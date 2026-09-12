from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from observatory.app import create_app
from observatory.collection_config import CollectionSettings
from observatory.collection_store import CollectionStorageError, CollectionStore
from observatory.config import Settings

NOW = datetime(2026, 9, 12, 10, tzinfo=UTC)


def event(key, **fields):
    return {"id": key, "completed_at": "2026-09-01T00:00:00Z", **fields}


def configured_app(tmp_path, **kwargs):
    config = CollectionSettings(backend="sqlite", sqlite_path=tmp_path / "collection.sqlite3")
    settings = Settings(database_path=":memory:", collection=config)
    return create_app(settings, clock=lambda: NOW, **kwargs), config


def test_site_reads_complete_snapshots_including_removals_without_restart(tmp_path):
    app, config = configured_app(tmp_path)
    with CollectionStore(config.sqlite_path) as store:
        store.record_success([event("one", title="original"), event("two")],
                             fetched_at=NOW - timedelta(hours=1), source_metadata={})
    assert app.state.read_data()["reset_history"] == [event("one", title="original"), event("two")]
    with CollectionStore(config.sqlite_path) as store:
        store.record_success([event("one", title="corrected")], fetched_at=NOW, source_metadata={})
    assert app.state.read_data()["reset_history"] == [event("one", title="corrected")]
    with TestClient(app) as client:
        response = client.get("/api/collection/status")
        status = response.json()
        assert response.status_code == 200
        assert status["fresh"] and status["runCount"] == 2
        assert status["currentEventCount"] == 1 and status["eventVersionCount"] == 3
        assert "no-store" in response.headers["cache-control"]
        assert "source_metadata" not in response.text and "password" not in response.text


def test_empty_success_does_not_resurrect_seed_records(tmp_path):
    app, config = configured_app(tmp_path)
    with CollectionStore(config.sqlite_path) as store:
        store.record_success([], fetched_at=NOW, source_metadata={})
    assert app.state.read_data()["reset_history"] == []


def test_missing_or_stale_collection_is_visible(tmp_path):
    app, config = configured_app(tmp_path)
    with TestClient(app) as client:
        assert client.get("/api/collection/status").status_code == 503
        assert app.state.read_data()["reset_history"]
        with CollectionStore(config.sqlite_path) as store:
            store.record_success([event("old")], fetched_at=NOW - timedelta(hours=4), source_metadata={})
        response = client.get("/api/collection/status")
        assert response.status_code == 503 and not response.json()["fresh"]
        assert app.state.read_data()["data_health"]["stale"]
        assert app.state.read_data()["reset_history"] == [event("old")]


def test_collection_failure_is_sanitized_and_preserves_website(tmp_path):
    def unavailable():
        raise CollectionStorageError("private connection details")

    app, _ = configured_app(tmp_path, collection_factory=unavailable)
    with TestClient(app) as client:
        response = client.get("/api/collection/status")
        assert response.status_code == 503
        assert "private" not in response.text
        current = client.get("/api/current?locale=zh")
        assert current.status_code == 200
        assert current.json()["dataHealth"]["overall"] == "degraded"


def test_mysql_is_selected_ahead_of_legacy_storage(monkeypatch):
    from observatory import app as module
    from observatory.storage import SQLiteRepository

    used = []

    class FakeMySQL(SQLiteRepository):
        def __init__(self, config):
            used.append(config)
            super().__init__()

    monkeypatch.setattr(module, "MySQLRepository", FakeMySQL)
    config = CollectionSettings(backend="mysql")
    app = create_app(Settings(collection=config, supabase_url="https://unused.example"))
    assert used == [config]
    with TestClient(app) as client:
        assert client.get("/healthz").status_code == 200
