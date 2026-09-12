import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from observatory.collection_store import (
    CollectionStorageError,
    CollectionStore,
    MySQLCollectionStore,
)
from observatory.storage import SQLiteRepository


def event(key="reset-1", **changes):
    return {"id": key, "completed_at": "2026-09-01T12:00:00Z", "recordKind": "confirmed_global", **changes}


def record(store, rows, hour=0):
    return store.record_success(rows, fetched_at=datetime(2026, 9, 12, hour, tzinfo=UTC),
                                source_metadata={"sourceUrl": "https://example.com/history",
                                                 "sourceSha256": "a" * 64, "recordCount": len(rows)})


def test_repeated_polls_keep_coverage_without_duplicate_versions(tmp_path):
    path = tmp_path / "persistent.sqlite3"
    with CollectionStore(path) as store:
        first_run = record(store, [event()])
        record(store, [event()], 1)
        assert store.get_status()["runCount"] == 2
        assert store.get_status()["eventVersionCount"] == 1
    with CollectionStore(path) as reopened:
        exported = reopened.export_dataset()
        version = exported["eventVersions"][0]
        assert version["firstSeenAt"] == "2026-09-12T00:00:00.000000+00:00"
        assert version["firstRunId"] == first_run
        assert version["data"]["completed_at"] == "2026-09-01T12:00:00Z"
        assert exported["runs"][0]["snapshotSha256"] == exported["runs"][1]["snapshotSha256"]
        assert reopened.latest_events() == [event()]


def test_corrections_and_removals_preserve_point_in_time_history():
    with CollectionStore() as store:
        original = event(title="original")
        corrected = event(title="corrected")
        first_run = record(store, [original, event("reset-2")])
        record(store, [corrected], 1)
        assert store.events_for_run(first_run) == [original, event("reset-2")]
        assert store.latest_events() == [corrected]
        assert store.asof_events("2026-09-11T23:00:00Z") == []
        assert store.asof_events("2026-09-12T00:30:00Z") == [original, event("reset-2")]
        assert store.asof_events("2026-09-12T08:30:00+07:00") == [corrected]
        status = store.get_status()
        assert (status["eventCount"], status["eventVersionCount"], status["currentEventCount"]) == (2, 3, 1)
        versions = store.export_dataset()["eventVersions"]
        corrected_version = next(row for row in versions if row["data"].get("title") == "corrected")
        assert corrected_version["firstSeenAt"] == "2026-09-12T01:00:00.000000+00:00"
        assert corrected_version["eventFirstSeenAt"] == "2026-09-12T00:00:00.000000+00:00"


def test_failure_marks_missing_coverage_without_erasing_history():
    with CollectionStore() as store:
        record(store, [event()])
        store.record_failure(fetched_at="2026-09-12T01:00:00Z",
                             error_code="request failed: https://example.com?token=private")
        status = store.get_status()
        assert status["latestAttemptStatus"] == "failure"
        assert status["latestErrorCode"] == "collection_failed"
        assert status["failedRunCount"] == 1
        assert store.latest_events() == [event()]
        assert "private" not in json.dumps(store.export_dataset())


def test_invalid_snapshots_do_not_record_partial_runs():
    with CollectionStore() as store:
        record(store, [event()])
        for rows in ([event(), event()], [event(completed_at="2030-01-01T00:00:00Z")],
                     [event(completed_at="2026-09-01T00:00:00")], [event(summary=float("nan"))]):
            with pytest.raises(ValueError):
                record(store, rows, 1)
        assert store.get_status()["runCount"] == 1
        assert store.get_status()["eventVersionCount"] == 1


def test_transaction_failure_rolls_back_run_and_all_versions(tmp_path):
    path = tmp_path / "collection.sqlite3"
    with CollectionStore(path) as store:
        record(store, [event()])
        with sqlite3.connect(path) as connection:
            connection.execute("CREATE TRIGGER reject_new_event BEFORE INSERT ON collection_run_events "
                               "WHEN NEW.event_key='reject' BEGIN SELECT RAISE(ABORT,'test failure'); END")
        with pytest.raises(sqlite3.IntegrityError):
            record(store, [event("new-valid"), event("reject")], 1)
        assert store.get_status()["runCount"] == 1
        assert store.get_status()["eventVersionCount"] == 1
        assert store.latest_events() == [event()]


def test_predictions_record_exact_inputs_and_reject_future_source():
    with CollectionStore() as store:
        run_id = record(store, [event()], 1)
        prediction = dict(timestamp="2026-09-12T01:00:00Z", probability24h=0.1,
                          probability48h=0.2, model_version="model-sha256", features={"vector": [1, 2]},
                          source_run_id=run_id)
        first = store.record_prediction(**prediction)
        assert store.record_prediction(**prediction) == first
        store.record_prediction(**{**prediction, "model_version": "updated-model"})
        exported = store.export_dataset()["predictions"]
        assert len(exported) == 2
        assert exported[0]["features"] == prediction["features"]
        assert exported[0]["sourceRunId"] == run_id
        for changes in ({"timestamp": "2026-09-12T00:00:00Z"}, {"source_run_id": 12345},
                        {"probability24h": float("nan")}, {"probability48h": 0.01}):
            with pytest.raises(ValueError):
                store.record_prediction(**{**prediction, **changes})
        failed = store.record_failure(fetched_at="2026-09-12T01:00:00Z", error_code="http_error")
        with pytest.raises(ValueError, match="source_not_available"):
            store.record_prediction(**{**prediction, "source_run_id": failed})
        assert store.get_status()["predictionCount"] == 2


def test_store_can_share_application_database_without_changing_records(tmp_path):
    path = tmp_path / "shared.sqlite3"
    repository = SQLiteRepository(path)
    repository.put("tibo_signals", {"tweet_id": "123", "value": "unchanged"})
    with CollectionStore(path) as store:
        record(store, [event()])
        assert repository.get("tibo_signals", "123") == {"tweet_id": "123", "value": "unchanged"}
        assert store.latest_events() == [event()]
    repository.close()


def test_independent_connections_preserve_concurrent_observations(tmp_path):
    path = tmp_path / "concurrent.sqlite3"
    # Prepare WAL once, then exercise concurrent writers through separate connections.
    CollectionStore(path).close()

    def collect(hour):
        with CollectionStore(path) as store:
            return record(store, [event()], hour)

    with ThreadPoolExecutor(max_workers=4) as executor:
        ids = list(executor.map(collect, range(8)))
    with CollectionStore(path) as store:
        assert len(set(ids)) == 8
        assert store.get_status()["runCount"] == 8
        assert store.get_status()["eventVersionCount"] == 1


def test_first_observation_uses_fetch_time_when_writers_finish_out_of_order():
    with CollectionStore() as store:
        record(store, [event()], 2)
        earliest_run = record(store, [event()], 0)
        version = store.export_dataset()["eventVersions"][0]
        assert version["firstSeenAt"] == "2026-09-12T00:00:00.000000+00:00"
        assert version["firstRunId"] == earliest_run
        assert store.get_status()["latestSuccessfulAt"] == "2026-09-12T02:00:00.000000+00:00"


def test_mysql_constructor_only_creates_namespaced_tables_and_sanitizes_errors(monkeypatch):
    from observatory import collection_store

    calls = []

    class Cursor:
        def execute(self, sql, parameters):
            calls.append((sql, parameters))

    connection = SimpleNamespace(cursor=lambda: Cursor(), close=lambda: None)
    options = {}

    def connect(**kwargs):
        options.update(kwargs)
        return connection

    driver = SimpleNamespace(connect=connect, cursors=SimpleNamespace(DictCursor=object))
    monkeypatch.setattr(collection_store.importlib, "import_module", lambda _: driver)
    with MySQLCollectionStore(host="db.example", database="existing", user="user", password="test-secret",
                              ssl_ca="/tmp/test-ca.pem"):
        pass
    assert len(calls) == 4
    assert all(sql.startswith("CREATE TABLE IF NOT EXISTS cro_") for sql, _ in calls)
    assert all("test-secret" not in sql for sql, _ in calls)
    assert options["ssl"]["check_hostname"] is True
    assert options["autocommit"] is True

    def fail_connect(**kwargs):
        raise RuntimeError("test-secret connection failure")

    driver.connect = fail_connect
    with pytest.raises(CollectionStorageError) as raised:
        MySQLCollectionStore(host="db.example", database="existing", user="user", password="test-secret")
    assert "test-secret" not in str(raised.value)
