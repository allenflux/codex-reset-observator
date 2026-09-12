from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from observatory.storage import SQLiteRepository, StorageError, SupabaseRepository
from observatory.webhooks import SOURCE_KEY, iso, process_usage


def test_sqlite_survives_reopening(tmp_path):
    path = tmp_path / "data.sqlite3"
    repo = SQLiteRepository(path)
    repo.put("tibo_signals", {"tweet_id": "1", "text": "original"})
    assert not repo.put("tibo_signals", {"tweet_id": "1", "text": "replacement"}, once=True)
    repo.close()
    reopened = SQLiteRepository(path)
    assert reopened.get("tibo_signals", "1")["text"] == "original"
    reopened.close()


def test_sqlite_transactions_rollback_all_writes():
    repo = SQLiteRepository()
    with pytest.raises(RuntimeError), repo.transaction():
        repo.put("tibo_signals", {"tweet_id": "1"})
        raise RuntimeError("simulated failure")
    assert repo.get("tibo_signals", "1") is None
    repo.close()


def test_concurrent_usage_retries_create_one_recovery():
    repo = SQLiteRepository()
    now = datetime(2026, 9, 12, tzinfo=UTC)
    previous = {"observedAt": iso(now - timedelta(minutes=1)), "limitId": "codex", "planType": "plus", "usedPercent": 80,
                "windowDurationMins": 10080, "resetsAt": int(now.timestamp()) + 86400}
    process_usage(repo, previous, now)
    current = {**previous, "observedAt": iso(now), "usedPercent": 0, "resetsAt": previous["resetsAt"] + 86400}
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda _: process_usage(repo, current, now), range(12)))
    assert sum(row["recovery"] == "observed" for row in results) == 1
    assert len(repo.list_records("codex_recovery_observations")) == 1
    assert len(repo.list_records("reset_execution_estimates")) == 1
    assert repo.get("codex_usage_monitor_state", SOURCE_KEY)["used_percent"] == 0
    repo.close()


def test_supabase_usage_uses_atomic_rpc():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={"status": "applied", "retry_required": False})

    repo = SupabaseRepository("https://db.example", "server-secret", client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert repo.apply_usage({"source_key": SOURCE_KEY})["status"] == "applied"
    assert calls[0].url.path == "/rest/v1/rpc/apply_codex_usage_webhook_write"
    assert calls[0].headers["Authorization"] == "Bearer server-secret"
    repo.close()


def test_supabase_failures_are_sanitized():
    client = httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(500, text="private database details")))
    repo = SupabaseRepository("https://db.example", "server-secret", client=client)
    with pytest.raises(StorageError, match="^Database unavailable$"):
        repo.list_records("tibo_signals")
    repo.close()
