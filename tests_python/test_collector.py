import hashlib
import json
from datetime import UTC, datetime, timedelta

from observatory import collector
from observatory.collection_config import CollectionSettings
from observatory.collection_store import CollectionStore
from observatory.neural import FEATURES, MODEL_PATH, eligible_events, features_at

NOW = datetime(2026, 9, 12, 12, tzinfo=UTC)


def source():
    rows = []
    for index in range(43):
        rows.append({
            "id": f"synthetic-reset-{index}",
            "completed_at": (NOW - timedelta(days=90 - index * 2)).isoformat(),
            "recordKind": "confirmed_global" if index < 37 or index == 42 else "reference",
            "scope": "全有料プラン", "randomResetTargetScope": "conditional" if 35 <= index < 37 else "broad",
            "details": {"cycleType": "定期リセット" if index == 42 else "ランダムリセット"},
        })
    return rows, {"recordCount": 43, "sourceSha256": "a" * 64,
                  "fetchedAt": "2000-01-01T00:00:00Z", "sourceUrl": "https://example.com/history"}


def snapshot(data, *, locale, now):
    assert locale == "zh" and now >= NOW
    assert data["reset_history"] == source()[0]
    return {"viewModel": {
        "probability24h": 0.12, "probability48h": 0.22,
        "neuralForecast": {"probability24h": 0.21, "probability48h": 0.41,
                           "modelVersion": "test-neural-v1", "trainedAt": "2026-09-11T00:00:00Z"},
    }}


def collect(store, *, now=NOW, **kwargs):
    return collector.collect_once(CollectionSettings(), store=store, clock=lambda: now,
                                  fetcher=kwargs.get("fetcher", source),
                                  snapshot_builder=kwargs.get("snapshot_builder", snapshot))


def test_collect_captures_complete_history_and_both_forecasts_with_observed_time():
    with CollectionStore() as store:
        result = collect(store)
        assert result["ok"] is True
        assert result["eventCount"] == 43
        assert result["predictionCount"] == 2
        assert result["predictionStatus"] == "saved"
        exported = store.export_dataset()
        assert len(exported["eventVersions"]) == 43
        assert exported["runs"][0]["fetchedAt"] == NOW.isoformat(timespec="microseconds")
        assert exported["runs"][0]["sourceMetadata"]["fetchedAt"] == "2000-01-01T00:00:00Z"
        assert {row["eventFirstSeenAt"] for row in exported["eventVersions"]} == {
            NOW.isoformat(timespec="microseconds")}
        baseline, neural = exported["predictions"]
        assert baseline["sourceRunId"] == neural["sourceRunId"] == result["runId"]
        assert baseline["features"]["forecastKind"] == "statistical_baseline"
        assert baseline["probability24h"] == 0.12
        assert neural["modelVersion"] == "test-neural-v1"
        assert neural["features"]["forecastKind"] == "neural_experiment"
        assert neural["features"]["modelSha256"] == hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest()
        assert neural["features"]["eligibleEventCount"] == 35
        assert neural["features"]["eventCount"] == 43
        assert neural["features"]["featureNames"] == FEATURES
        events, _ = eligible_events(source()[0], NOW)
        assert neural["features"]["featureValues"] == features_at(events, NOW)


def test_unchanged_poll_adds_coverage_and_forecast_without_duplicate_event_versions():
    with CollectionStore() as store:
        first = collect(store)
        second = collect(store, now=NOW + timedelta(hours=1))
        assert first["runId"] != second["runId"]
        status = store.get_status()
        assert status["runCount"] == 2
        assert status["eventVersionCount"] == status["eventCount"] == 43
        assert status["predictionCount"] == 4
        predictions = store.export_dataset()["predictions"]
        assert [row["sourceRunId"] for row in predictions] == [first["runId"]] * 2 + [second["runId"]] * 2
        assert predictions[0]["features"]["featureValues"] != predictions[2]["features"]["featureValues"]


def test_collection_failure_records_gap_and_preserves_last_success_without_secret_text():
    def failing_source():
        raise RuntimeError("private-example-secret https://example.com?token=private-example-secret")

    with CollectionStore() as store:
        collect(store)
        result = collect(store, now=NOW + timedelta(hours=1), fetcher=failing_source)
        assert result == {"ok": False, "error": "source_collection_failed"}
        assert store.latest_events() == source()[0]
        status = store.get_status()
        assert status["failedRunCount"] == 1
        assert status["latestAttemptStatus"] == "failure"
        assert status["predictionCount"] == 2
        assert "private-example-secret" not in json.dumps([result, store.export_dataset()])


def test_invalid_completed_event_is_a_failure_and_cannot_advance_source_snapshot():
    def invalid_source():
        rows, metadata = source()
        rows[0]["completed_at"] = (NOW + timedelta(days=365)).isoformat()
        return rows, metadata

    with CollectionStore() as store:
        collect(store)
        result = collect(store, now=NOW + timedelta(hours=1), fetcher=invalid_source)
        assert result["ok"] is False
        assert store.get_status()["successfulRunCount"] == 1
        assert store.get_status()["failedRunCount"] == 1
        assert store.latest_events() == source()[0]


def test_prediction_generation_failure_does_not_discard_valid_source_snapshot():
    def broken_snapshot(*args, **kwargs):
        raise RuntimeError("private-example-secret")

    with CollectionStore() as store:
        result = collect(store, snapshot_builder=broken_snapshot)
        assert result["ok"] is True
        assert result["predictionStatus"] == "failed"
        assert result["predictionCount"] == 0
        assert store.latest_events() == source()[0]
        assert store.get_status()["successfulRunCount"] == 1
        assert "private-example-secret" not in json.dumps(result)


def test_neural_prediction_failure_preserves_already_archived_baseline():
    def invalid_neural(data, *, locale, now):
        view = snapshot(data, locale=locale, now=now)
        view["viewModel"]["neuralForecast"]["probability48h"] = -1
        return view

    with CollectionStore() as store:
        result = collect(store, snapshot_builder=invalid_neural)
        assert result["ok"] is True
        assert result["predictionStatus"] == "failed"
        assert result["predictionCount"] == 1
        assert store.get_status()["currentEventCount"] == 43
        assert store.export_dataset()["predictions"][0]["features"]["forecastKind"] == "statistical_baseline"


def test_fetch_source_uses_ephemeral_staging_and_removes_it(monkeypatch):
    directories = []
    expected_rows, expected_metadata = source()

    def fake_sync(directory):
        directories.append(directory)
        (directory / "online_history.json").write_text(json.dumps(expected_rows))
        return expected_metadata

    monkeypatch.setattr(collector, "sync_history", fake_sync)
    assert collector.fetch_source() == (expected_rows, expected_metadata)
    assert len(directories) == 1
    assert not directories[0].exists()


def test_database_connection_failure_is_sanitized(monkeypatch):
    def unavailable(settings):
        raise RuntimeError("private-example-secret")

    monkeypatch.setattr(collector, "create_collection_store", unavailable)
    result = collector.collect_once(CollectionSettings(), fetcher=source)
    assert result == {"ok": False, "error": "collection_database_unavailable"}


def test_owned_connection_is_closed_after_collection(monkeypatch):
    store = CollectionStore()
    closed = []
    original_close = store.close

    def close():
        closed.append(True)
        original_close()

    monkeypatch.setattr(store, "close", close)
    monkeypatch.setattr(collector, "create_collection_store", lambda settings: store)
    result = collector.collect_once(CollectionSettings(), fetcher=source,
                                    snapshot_builder=snapshot, clock=lambda: NOW)
    assert result["ok"] is True
    assert closed == [True]


def test_neural_primary_does_not_get_archived_as_statistical_baseline():
    def neural_primary(data, *, locale, now):
        result = snapshot(data, locale=locale, now=now)
        view = result["viewModel"]
        view["statisticalBaseline"] = {"probability24h": 0.12, "probability48h": 0.22}
        view.update(probability24h=0.21, probability48h=0.41)
        return result

    with CollectionStore() as store:
        assert collect(store, snapshot_builder=neural_primary)["predictionCount"] == 2
        baseline, neural = store.export_dataset()["predictions"]
        assert baseline["probability24h"] == 0.12
        assert neural["probability24h"] == 0.21


def test_worker_collects_social_more_often_and_history_failure_does_not_disable_it(monkeypatch):
    from observatory import social_sync

    calls = []
    tick = [0.0]

    class Stop:
        stopped = False

        def is_set(self):
            return self.stopped

        def set(self):
            self.stopped = True

        def wait(self, seconds):
            tick[0] += seconds
            if tick[0] > 300:
                self.stopped = True

    monkeypatch.setattr(collector.threading, "Event", Stop)
    monkeypatch.setattr(collector.signal, "signal", lambda *args: None)
    monkeypatch.setattr(collector.time, "monotonic", lambda: tick[0])

    def social(settings):
        calls.append(("social", tick[0]))
        return {"ok": True}

    def history(settings):
        calls.append(("history", tick[0]))
        return {"ok": False}

    monkeypatch.setattr(social_sync, "collect_social_once", social)
    monkeypatch.setattr(collector, "collect_once", history)
    collector.run_collector(CollectionSettings(social_interval_seconds=60))
    assert [at for kind, at in calls if kind == "social"] == [0, 60, 120, 180, 240, 300]
    assert [at for kind, at in calls if kind == "history"] == [0, 300]
    calls.clear()
    tick[0] = 0
    collector.run_collector(CollectionSettings(social_enabled=False))
    assert calls == [("history", 0), ("history", 300)]
