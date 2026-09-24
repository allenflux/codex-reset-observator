from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from observatory.app import create_app
from observatory.collection_config import CollectionSettings
from observatory.collection_store import CollectionStorageError, CollectionStore
from observatory.config import Settings
from observatory.teacher import MODEL_VERSION, SOURCE, SOURCE_URL

NOW = datetime(2026, 9, 12, 10, tzinfo=UTC)


def teacher_forecast(at=NOW):
    return {"schemaVersion": 1, "source": SOURCE, "sourceUrl": SOURCE_URL,
            "modelVersion": MODEL_VERSION, "checkedAt": at.isoformat(),
            "fetchedAt": at.isoformat(), "sourceStale": False,
            "probability24h": .3638336, "probability48h": .5368211, "context": {}}


def test_public_forecast_uses_collected_teacher_with_provenance_and_keeps_local_model(tmp_path):
    app, config = configured_app(tmp_path)
    with CollectionStore(config.sqlite_path) as store:
        history = app.state.read_data()["reset_history"]
        run = store.record_success(history, fetched_at=NOW, source_metadata={})
        store.record_prediction(timestamp=NOW, probability24h=.3638336, probability48h=.5368211,
                                model_version=MODEL_VERSION, source_run_id=run,
                                features={"teacherForecast": {**teacher_forecast(), "private": "must-not-leak"}})
    with TestClient(app) as client:
        view = client.get("/api/current?locale=zh").json()["viewModel"]
        assert view["primaryForecast"]["kind"] == "upstream_mirror"
        assert view["primaryForecast"]["experimental"] is False
        assert view["probability24h"] == .3638336
        assert view["probability48h"] == .5368211
        assert view["neuralForecast"]["modelVersion"] == "reset-mlp-8-tanh-v1"
        status = client.get("/api/forecast/source")
        assert status.status_code == 200 and status.json()["fresh"]
        assert datetime.fromisoformat(status.json()["checkedAt"].replace("Z", "+00:00")) == NOW
        assert "must-not-leak" not in status.text
        html = client.get("/zh").text
        assert "源站同步预测" in html and "源站预测时间" in html
        assert 'aria-valuenow="36"' in html and 'aria-valuenow="54"' in html
        assert "本地历史模型 · 对照" in html


def test_expired_teacher_does_not_relabel_local_predictions_as_a_mirror(tmp_path):
    app, config = configured_app(tmp_path)
    with CollectionStore(config.sqlite_path) as store:
        at = NOW - timedelta(minutes=31)
        run = store.record_success(app.state.read_data()["reset_history"], fetched_at=at, source_metadata={})
        store.record_prediction(timestamp=at, probability24h=.3638336, probability48h=.5368211,
                                model_version=MODEL_VERSION, source_run_id=run,
                                features={"teacherForecast": teacher_forecast(at)})
    with TestClient(app) as client:
        view = client.get("/api/current").json()["viewModel"]
        assert view["primaryForecast"]["kind"] == "neural"
        assert view["probability24h"] == view["neuralForecast"]["probability24h"]
        assert view["upstreamForecast"]["reason"] == "expired"
        assert view["upstreamForecast"]["probability24h"] is None
        assert client.get("/api/forecast/source").status_code == 503
        assert "源站预测暂不可用或已过期" in client.get("/zh").text


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
        assert status["intervalSeconds"] == 300
        assert status["currentEventCount"] == 1 and status["eventVersionCount"] == 3
        assert "no-store" in response.headers["cache-control"]
        assert "source_metadata" not in response.text and "password" not in response.text


def test_empty_success_does_not_resurrect_seed_records(tmp_path):
    app, config = configured_app(tmp_path)
    with CollectionStore(config.sqlite_path) as store:
        store.record_success([], fetched_at=NOW, source_metadata={})
    assert app.state.read_data()["reset_history"] == []


def test_default_history_collection_becomes_stale_after_fifteen_minutes(tmp_path):
    for minutes, expected_status in ((15, 200), (16, 503)):
        app, config = configured_app(tmp_path / str(minutes))
        with CollectionStore(config.sqlite_path) as store:
            store.record_success([event("recent")], fetched_at=NOW - timedelta(minutes=minutes),
                                 source_metadata={})
        with TestClient(app) as client:
            assert client.get("/api/collection/status").status_code == expected_status
            assert client.get("/api/mobile/status").json()["historyIntervalSeconds"] == 300


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


def test_social_status_distinguishes_missing_fresh_and_failed_without_private_fields(tmp_path):
    from observatory.social_sync import SOURCE_ID

    app, _ = configured_app(tmp_path)
    repo = app.state.repository
    with TestClient(app) as client:
        assert client.get("/api/social/status").status_code == 503
        state = {"id": SOURCE_ID, "last_successful_at": NOW.isoformat(),
                 "latest_attempt_status": "success", "post_count": 1, "version_count": 2,
                 "metadata": {"private": "internal-test-value"}}
        repo.put("social_collection_state", state)
        response = client.get("/api/social/status")
        assert response.status_code == 200 and response.json()["fresh"]
        assert response.json()["postCount"] == 1
        assert response.json()["completeTimeline"] is False
        assert "internal-test-value" not in response.text
        assert "no-store" in response.headers["cache-control"]
        assert repo.get("tibo_heartbeat", "main") is None
        repo.put("social_collection_state", {**state, "latest_attempt_status": "failure",
                                              "error": "private-error"})
        response = client.get("/api/social/status")
        assert response.status_code == 503
        assert response.json()["latestSuccessfulAt"]
        assert response.json()["postCount"] == 1
        assert "private-error" not in response.text
        repo.put("social_collection_state", {**state, "last_successful_at": (NOW - timedelta(minutes=16)).isoformat()})
        assert client.get("/api/social/status").status_code == 503
