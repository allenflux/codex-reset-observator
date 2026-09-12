from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier, Lock

import httpx
import pytest

from observatory.notifications import NotificationError, NotificationService, NotificationSettings
from observatory.storage import SQLiteRepository

NOW = datetime(2026, 9, 12, 12, tzinfo=UTC)
KEY = "123456:private-telegram-token"
CHAT_ID = "987654321"
SECRET = "private-api-secret"


def event(identity="reset-1", *, ago=10, **changes):
    return {
        "id": identity, "recordKind": "confirmed_global", "kind": "reset_completed",
        "status": "closed", "closed_at": (NOW - timedelta(seconds=ago)).isoformat(),
        "scope": "全有料プラン", "details": {"cycleType": "ランダムリセット"}, **changes,
    }


def settings(**changes):
    return NotificationSettings(enabled=True, telegram_bot_token=KEY, telegram_chat_id=CHAT_ID, mobile_api_secret=SECRET, **changes)


def client_for(handler):
    return httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)


@pytest.mark.parametrize(("field", "value"), [
    ("telegram_bot_token", "https://example.com/secret"),
    ("telegram_bot_token", "123:token/path"), ("telegram_bot_token", "123:token?query"),
    ("telegram_bot_token", "123:token with spaces"),
    ("telegram_chat_id", "https://example.com/secret"),
    ("telegram_chat_id", "recipient name"),
])
def test_invalid_configuration_is_sanitized(field, value):
    with pytest.raises(ValueError) as error:
        NotificationSettings(**{field: value})
    assert value not in str(error.value)


def test_settings_default_and_secrets_hidden():
    assert NotificationSettings.from_env({}).enabled is False
    configured = NotificationSettings.from_env({"TELEGRAM_ENABLED": "true", "TELEGRAM_BOT_TOKEN": KEY,
        "MOBILE_API_SECRET": SECRET, "TELEGRAM_CHAT_ID": CHAT_ID,
        "NOTIFICATION_INTERVAL_SECONDS": "15"})
    assert configured.interval_seconds == 15
    assert KEY not in repr(configured) and SECRET not in repr(configured)
    assert CHAT_ID not in repr(configured)
    for name, value in [("TELEGRAM_ENABLED", "yes"), ("NOTIFICATION_INTERVAL_SECONDS", "1"),
                        ("NOTIFICATION_MAX_EVENT_AGE_SECONDS", "invalid")]:
        with pytest.raises(ValueError, match=name):
            NotificationSettings.from_env({name: value})


def test_baseline_poll_edits_backfill_and_restart_deduplicate(tmp_path):
    path = tmp_path / "notifications.sqlite3"
    requests = []
    client = client_for(lambda request: requests.append(request) or httpx.Response(200, json={"ok": True}))
    repo = SQLiteRepository(path)
    service = NotificationService(repo, settings(), client=client)
    assert service.sync_history([event("existing")], now=NOW)["baseline"]
    assert service.deliver_pending(now=NOW)["sent"] == 0
    rows = [event("existing"), event("new"), event("old-backfill", ago=90000)]
    assert service.sync_history(rows, now=NOW)["queued"] == 1
    assert service.sync_history(rows, now=NOW)["queued"] == 0
    assert service.deliver_pending(now=NOW)["sent"] == 1
    repo.close()
    repo = SQLiteRepository(path)
    service = NotificationService(repo, settings(), client=client)
    # Both display corrections and a stale backfill becoming recent stay seen.
    rows = [event("existing", title="corrected"), event("new", ago=0), event("old-backfill", ago=0)]
    assert service.sync_history(rows, now=NOW)["queued"] == 0
    assert service.deliver_pending(now=NOW)["sent"] == 0
    assert len(requests) == 1
    status = service.status()
    assert status["lastSentAt"] and status["pendingCount"] == 0
    assert status["enabled"] and status["configured"] and status["testAvailable"]
    records = json.dumps([repo.list_records(name) for name in
        ["reset_notification_state", "reset_notification_seen", "reset_notification_outbox"]])
    assert KEY not in records + json.dumps(status)
    assert SECRET not in records + json.dumps(status)
    assert CHAT_ID not in records + json.dumps(status)
    request = requests[0]
    assert str(request.url) == "https://api.telegram.org/bot" + KEY + "/sendMessage"
    assert json.loads(request.content)["chat_id"] == CHAT_ID
    assert json.loads(request.content)["disable_notification"] is False
    repo.close()


def test_only_confirmed_broad_random_events_and_distinct_banked_text():
    requests = []
    with client_for(lambda request: requests.append(request) or httpx.Response(200, json={"ok": True})) as client:
        repo = SQLiteRepository()
        service = NotificationService(repo, settings(), client=client)
        service.sync_history([], now=NOW)
        rows = [event("global"), event("banked", recordKind="banked_distribution"),
                event("announcement", status="announced"), event("future", ago=-3600),
                event("partial", randomResetTargetScope="conditional"),
                event("limited", scope="一部ユーザー"), event("reference", recordKind="reference"),
                event("regular", recordKind="regular_completed"), event("void", status="voided"),
                event("window", kind="window_opened")]
        assert service.sync_history(rows, now=NOW)["queued"] == 2
        assert service.deliver_pending(now=NOW)["sent"] == 2
        payloads = [json.loads(request.content) for request in requests]
        assert {row["text"].splitlines()[0] for row in payloads} == {"已发放手动重置机会", "已确认 Codex 额度重置"}
        assert any("需要自行使用" in row["text"] for row in payloads)
        # A previously unconfirmed announcement becoming completed can notify.
        assert service.sync_history([*rows, event("announcement")], now=NOW)["queued"] == 1
        repo.close()


def test_source_retraction_cancels_pending_alert():
    repo = SQLiteRepository()
    service = NotificationService(repo, settings())
    service.sync_history([], now=NOW)
    service.sync_history([event()], now=NOW)
    service.sync_history([event(status="voided")], now=NOW)
    assert service.status()["pendingCount"] == 0
    assert service.deliver_pending(now=NOW)["sent"] == 0
    assert repo.list_records("reset_notification_outbox")[0]["status"] == "cancelled"
    repo.close()


def test_transient_retry_survives_restart_and_obeys_backoff(tmp_path):
    path = tmp_path / "retry.sqlite3"
    repo = SQLiteRepository(path)
    client = client_for(lambda request: httpx.Response(503, text=KEY + SECRET))
    service = NotificationService(repo, settings(), client=client)
    service.sync_history([], now=NOW)
    service.sync_history([event()], now=NOW)
    assert service.deliver_pending(now=NOW)["failed"] == 1
    row = repo.list_records("reset_notification_outbox")[0]
    assert row["status"] == "retry" and row["attempts"] == 1
    assert KEY not in json.dumps(row) and SECRET not in json.dumps(row)
    repo.close()
    repo = SQLiteRepository(path)
    client = client_for(lambda request: httpx.Response(200, json={"ok": True}))
    service = NotificationService(repo, settings(), client=client)
    assert service.deliver_pending(now=NOW + timedelta(seconds=29))["sent"] == 0
    assert service.deliver_pending(now=NOW + timedelta(seconds=30))["sent"] == 1
    assert repo.list_records("reset_notification_outbox")[0]["attempts"] == 2
    repo.close()


@pytest.mark.parametrize(("status", "response", "expected"), [
    (400, {"ok": True}, "failed"), (302, {"ok": True}, "failed"),
    (200, {"ok": False, "error_code": 400, "description": KEY}, "failed"), (200, {"ok": False, "error_code": 500}, "retry"),
    (429, {"ok": False, "error_code": 429}, "retry"), (200, {}, "failed"),
])
def test_http_and_provider_code_must_both_succeed_without_redirect(status, response, expected):
    calls = []
    client = client_for(lambda request: calls.append(request) or httpx.Response(
        status, json=response, headers={"Location": "https://other.example/push"}))
    repo = SQLiteRepository()
    service = NotificationService(repo, settings(), client=client)
    service.sync_history([], now=NOW)
    service.sync_history([event()], now=NOW)
    assert service.deliver_pending(now=NOW)["failed"] == 1
    assert len(calls) == 1
    assert repo.list_records("reset_notification_outbox")[0]["status"] == expected
    repo.close()


def test_timeouts_are_sanitized_and_retries_are_bounded():
    def timeout(request):
        raise httpx.ReadTimeout(KEY + SECRET, request=request)

    repo = SQLiteRepository()
    service = NotificationService(repo, settings(), client=client_for(timeout))
    service.sync_history([], now=NOW)
    service.sync_history([event()], now=NOW)
    for elapsed in [0, 30, 90, 210, 450]:
        assert service.deliver_pending(now=NOW + timedelta(seconds=elapsed))["failed"] == 1
    row = repo.list_records("reset_notification_outbox")[0]
    assert row["status"] == "failed" and row["attempts"] == 5
    assert row["lastError"] == "provider_unavailable"
    assert service.deliver_pending(now=NOW + timedelta(hours=1))["failed"] == 0
    repo.close()


def test_pending_events_expire_before_delivery():
    repo = SQLiteRepository()
    service = NotificationService(repo, settings())
    service.sync_history([], now=NOW)
    service.sync_history([event()], now=NOW)
    assert service.deliver_pending(now=NOW + timedelta(days=1))["sent"] == 0
    assert repo.list_records("reset_notification_outbox")[0]["status"] == "expired"
    repo.close()


def test_test_push_has_persistent_rate_limit_and_safe_errors(tmp_path):
    path = tmp_path / "test.sqlite3"
    repo = SQLiteRepository(path)
    calls = []
    client = client_for(lambda request: calls.append(request) or httpx.Response(200, json={"ok": True}))
    service = NotificationService(repo, settings(), client=client)
    assert service.send_test(now=NOW)["ok"]
    assert "测试" in json.loads(calls[0].content)["text"]
    repo.close()
    repo = SQLiteRepository(path)
    service = NotificationService(repo, settings(), client=client)
    with pytest.raises(NotificationError, match="rate_limited"):
        service.send_test(now=NOW + timedelta(seconds=59))
    assert len(calls) == 1
    assert service.send_test(now=NOW + timedelta(seconds=60))["ok"]
    service = NotificationService(repo, settings(), client=client_for(
        lambda request: httpx.Response(401, text=KEY + SECRET)))
    with pytest.raises(NotificationError) as error:
        service.send_test(now=NOW + timedelta(seconds=120))
    assert error.value.code == "delivery_failed"
    assert KEY not in repr(error.value) and SECRET not in repr(error.value)
    repo.close()


def test_disabled_never_sends_or_initializes():
    repo = SQLiteRepository()
    service = NotificationService(repo, NotificationSettings())
    assert not service.sync_history([event()], now=NOW)["enabled"]
    assert not service.deliver_pending(now=NOW)["enabled"]
    assert service.status()["reason"] == "not_configured"
    assert not repo.list_records("reset_notification_state")
    with pytest.raises(NotificationError, match="not_configured"):
        service.send_test(now=NOW)
    repo.close()


def test_two_sqlite_workers_claim_only_one_delivery(tmp_path):
    path = tmp_path / "shared.sqlite3"
    repos = [SQLiteRepository(path), SQLiteRepository(path)]
    barrier = Barrier(2)
    mutex = Lock()
    calls = []

    def handler(request):
        with mutex:
            calls.append(request)
        return httpx.Response(200, json={"ok": True})

    clients = [client_for(handler), client_for(handler)]
    services = [NotificationService(repo, settings(), client=client)
                for repo, client in zip(repos, clients, strict=True)]
    services[0].sync_history([], now=NOW)

    def run(service):
        barrier.wait()
        service.sync_history([event()], now=NOW)
        return service.deliver_pending(now=NOW)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(run, services))
    assert sum(row["sent"] for row in results) == 1
    assert len(calls) == 1
    assert len(repos[0].list_records("reset_notification_outbox")) == 1
    for repo in repos:
        repo.close()


def test_provider_retry_after_blocks_all_pending_alerts_and_test():
    repo = SQLiteRepository()
    calls = []
    client = client_for(lambda request: calls.append(request) or httpx.Response(429, json={
        "ok": False, "error_code": 429, "parameters": {"retry_after": 120}}))
    service = NotificationService(repo, settings(), client=client)
    service.sync_history([], now=NOW)
    service.sync_history([event("first"), event("second")], now=NOW)
    assert service.deliver_pending(now=NOW)["failed"] == 1
    assert len(calls) == 1
    assert service.deliver_pending(now=NOW + timedelta(seconds=119))["failed"] == 0
    with pytest.raises(NotificationError, match="rate_limited"):
        service.send_test(now=NOW + timedelta(seconds=60))
    assert service.deliver_pending(now=NOW + timedelta(seconds=120))["failed"] == 1
    assert len(calls) == 2
    repo.close()


def test_token_redacted_from_httpx_and_httpcore_logs(caplog):
    repo = SQLiteRepository()
    client = client_for(lambda request: httpx.Response(200, json={"ok": True}))
    service = NotificationService(repo, settings(), client=client)
    with caplog.at_level(logging.DEBUG):
        service.send_test(now=NOW)
        logging.getLogger("httpcore.http11").debug("request=%r", b"/bot" + KEY.encode() + b"/sendMessage")
    assert "[redacted]" in caplog.text
    assert KEY not in caplog.text
    assert CHAT_ID not in caplog.text
    assert SECRET not in caplog.text
    repo.close()


def test_reclaimed_crashed_claim_is_revalidated_after_source_revocation():
    repo = SQLiteRepository()
    service = NotificationService(repo, settings())
    service.sync_history([], now=NOW)
    service.sync_history([event()], now=NOW)
    assert service._claim(NOW) is not None
    # The worker disappeared before its claim was acknowledged.
    service = NotificationService(repo, settings())
    later = NOW + timedelta(seconds=121)
    service.sync_history([event(status="voided")], now=later)
    assert service.deliver_pending(now=later)["sent"] == 0
    assert repo.list_records("reset_notification_outbox")[0]["status"] == "cancelled"
    repo.close()


def test_timestamp_correction_updates_pending_payload_and_expiry():
    repo = SQLiteRepository()
    service = NotificationService(repo, settings())
    service.sync_history([], now=NOW)
    service.sync_history([event()], now=NOW)
    service.sync_history([event(ago=90000)], now=NOW)
    assert service.deliver_pending(now=NOW)["sent"] == 0
    row = repo.list_records("reset_notification_outbox")[0]
    assert "2026-09-11 11:00:00 UTC" in row["payload"]["text"]
    assert row["status"] == "expired"
    repo.close()


def test_failed_state_is_public_but_provider_response_is_private():
    repo = SQLiteRepository()
    client = client_for(lambda request: httpx.Response(200, json={
        "ok": False, "error_code": 403, "description": KEY + CHAT_ID + SECRET}))
    service = NotificationService(repo, settings(), client=client)
    service.sync_history([], now=NOW)
    service.sync_history([event()], now=NOW)
    service.deliver_pending(now=NOW)
    status = service.status()
    assert status["failedCount"] == 1 and status["pendingCount"] == 0
    assert status["lastError"] == "provider_rejected"
    assert KEY not in json.dumps(status) and CHAT_ID not in json.dumps(status)
    repo.close()


def test_invalid_json_is_retryable_and_ok_must_be_boolean_true():
    repo = SQLiteRepository()
    service = NotificationService(repo, settings(), client=client_for(
        lambda request: httpx.Response(200, content=b"invalid-json")))
    service.sync_history([], now=NOW)
    service.sync_history([event()], now=NOW)
    service.deliver_pending(now=NOW)
    assert service.status()["lastError"] == "provider_invalid_response"
    service = NotificationService(repo, settings(), client=client_for(
        lambda request: httpx.Response(200, json={"ok": 1})))
    service.deliver_pending(now=NOW + timedelta(seconds=30))
    assert service.status()["failedCount"] == 1
    repo.close()


def test_supabase_is_unsupported_without_querying_remote_tables():
    from observatory.storage import SupabaseRepository

    calls = []
    client = client_for(lambda request: calls.append(request) or httpx.Response(500))
    repo = SupabaseRepository("https://example.com", "private", client=client)
    service = NotificationService(repo, settings())
    assert service.status()["reason"] == "unsupported_storage"
    assert not service.status()["configured"]
    assert not service.sync_history([event()], now=NOW)["enabled"]
    with pytest.raises(NotificationError, match="unsupported_storage"):
        service.send_test(now=NOW)
    assert not calls
    repo.close()


def test_test_push_preserves_provider_backoff_across_restarts(tmp_path):
    path = tmp_path / "test-backoff.sqlite3"
    repo = SQLiteRepository(path)
    client = client_for(lambda request: httpx.Response(429, json={
        "ok": False, "error_code": 429, "parameters": {"retry_after": 300}}))
    service = NotificationService(repo, settings(), client=client)
    with pytest.raises(NotificationError, match="delivery_failed"):
        service.send_test(now=NOW)
    repo.close()
    repo = SQLiteRepository(path)
    service = NotificationService(repo, settings())
    with pytest.raises(NotificationError, match="rate_limited"):
        service.send_test(now=NOW + timedelta(seconds=120))
    assert service.sync_history([event()], now=NOW)["baseline"]
    repo.close()


def test_mysql_worker_mutex_precedes_reads_and_duplicate_delivery_is_suppressed(tmp_path):
    # A DB-API adapter verifies SQL ordering/semantics without production credentials.
    from observatory.collection_config import CollectionSettings
    from observatory.mysql_repository import MySQLRepository
    from tests_python.test_mysql_repository import FakeConnection

    connections = [FakeConnection(str(tmp_path / "mysql-adapter.sqlite3")) for _ in range(2)]
    repos = [MySQLRepository(CollectionSettings(), connection=connection) for connection in connections]
    calls = []
    barrier = Barrier(2)
    client = client_for(lambda request: calls.append(request) or httpx.Response(200, json={"ok": True}))
    services = [NotificationService(repo, settings(), client=client) for repo in repos]
    services[0].sync_history([], now=NOW)

    def run(service):
        barrier.wait()
        service.sync_history([event()], now=NOW)
        return service.deliver_pending(now=NOW)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(run, services))
    assert sum(row["sent"] for row in results) == 1
    assert len(calls) == 1
    for connection in connections:
        for index, (query, _) in enumerate(connection.queries):
            if query == "START TRANSACTION":
                mutex_sql, parameters = connection.queries[index + 1]
                assert "ON DUPLICATE KEY UPDATE" in mutex_sql
                assert parameters[:2] == ("reset_notification_state", "mutex")
    for repo in repos:
        repo.close()


def test_older_collection_snapshot_cannot_cancel_newer_pending_event():
    repo = SQLiteRepository()
    calls = []
    client = client_for(lambda request: calls.append(request) or httpx.Response(200, json={"ok": True}))
    service = NotificationService(repo, settings(), client=client)
    service.sync_history([], now=NOW, source_run_id=10)
    assert service.sync_history([event()], now=NOW, source_run_id=12)["queued"] == 1
    stale = service.sync_history([], now=NOW + timedelta(seconds=5), source_run_id=11)
    assert stale["staleSnapshot"] is True
    assert service.status()["pendingCount"] == 1
    assert service.deliver_pending(now=NOW + timedelta(seconds=5))["sent"] == 1
    assert len(calls) == 1
    assert repo.get("reset_notification_state", "dispatcher")["lastSourceRunId"] == 12
    repo.close()


def test_imported_combined_product_scope_updates_latest_reset_and_notifies_once():
    from observatory.domain import build_snapshot
    from observatory.history import canonical_history, eligible_random_reset
    from observatory.history_sync import normalize_history
    from observatory.neural import eligible_events

    source = {"key": "tibo-reset-2098685367058612394", "recordKind": "confirmed_global",
              "resetAt": "2026-09-12T08:00:00Z", "source": "https://x.com/thsottiaux/status/2098685367058612394",
              "details": {"cycleType": "随机重置", "scope": "Codex / ChatGPT Work"}}
    limited = {**source, "key": "banked-reset-2097752790177370535", "recordKind": "banked_distribution",
               "resetAt": "2026-09-09T18:23:34Z", "details": {"cycleType": "随机重置", "scope": "部分用户"}}
    rows = normalize_history([source, limited], NOW)
    history = canonical_history({"reset_history": rows}, NOW)
    eligible = [row for row in history if eligible_random_reset(row, NOW)]
    assert [row["id"] for row in eligible] == [source["key"]]
    assert eligible[0]["completed_at"] == source["resetAt"]
    snapshot = build_snapshot({"reset_history": rows}, locale="zh", now=NOW)
    assert snapshot["lastRandomResetAt"] == "2026-09-12T08:00:00.000Z"
    assert eligible_events(rows, NOW)[1]["eligibleEventIds"] == [source["key"]]
    calls = []
    repo = SQLiteRepository()
    client = client_for(lambda request: calls.append(request) or httpx.Response(200, json={"ok": True}))
    service = NotificationService(repo, settings(), client=client)
    service.sync_history([], now=NOW, source_run_id=1)
    assert service.sync_history(history, now=NOW, source_run_id=2)["queued"] == 1
    assert service.deliver_pending(now=NOW)["sent"] == 1
    assert service.sync_history(history, now=NOW, source_run_id=2)["queued"] == 0
    assert service.deliver_pending(now=NOW)["sent"] == 0
    assert len(calls) == 1
    repo.close()
