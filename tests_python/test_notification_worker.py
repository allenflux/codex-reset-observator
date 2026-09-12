from datetime import UTC, datetime

from observatory import collector, notification_worker
from observatory.collection_config import CollectionSettings
from observatory.collection_store import CollectionStore
from observatory.notifications import NotificationSettings
from observatory.storage import SQLiteRepository

NOW = datetime(2026, 9, 12, 12, tzinfo=UTC)
PUSH = NotificationSettings(enabled=True, telegram_bot_token="123456:test-token", telegram_chat_id="12345")


def test_worker_waits_for_successful_history_without_seeding_packaged_fallback():
    repo = SQLiteRepository()
    with CollectionStore() as store:
        result = notification_worker.notify_once(
            CollectionSettings(backend="sqlite"), PUSH, repository=repo, store=store, now=NOW,
        )
        assert result == {"ok": True, "waitingForCollection": True}
        assert repo.list_records("reset_notification_seen") == []
        assert repo.list_records("reset_notification_state") == []
    repo.close()


def test_worker_reads_only_last_successful_collection_and_sanitizes_errors(monkeypatch):
    calls = []

    class Service:
        def __init__(self, *args):
            pass

        def sync_history(self, rows, *, now, source_run_id):
            assert source_run_id == 1
            calls.append((rows, now))
            return {"queued": 0}

        def deliver_pending(self, *, now):
            raise RuntimeError("private relay key and response")

    monkeypatch.setattr(notification_worker, "NotificationService", Service)
    repo = SQLiteRepository()
    with CollectionStore() as store:
        store.record_success([], fetched_at=NOW, source_metadata={})
        store.record_failure(fetched_at=NOW, error_code="source_failed")
        result = notification_worker.notify_once(
            CollectionSettings(backend="sqlite"), PUSH, repository=repo, store=store, now=NOW,
        )
        assert calls == [([], NOW)]
        assert result == {"ok": False, "error": "notification_worker_failed"}
    repo.close()


def test_worker_does_not_open_storage_when_disabled(monkeypatch):
    def unexpected(*args):
        raise AssertionError("Disabled notifications must not open storage")

    monkeypatch.setattr(notification_worker, "create_collection_store", unexpected)
    assert notification_worker.notify_once(CollectionSettings(), NotificationSettings()) == {
        "ok": True, "enabled": False,
    }


def test_collection_dispatches_notifications_between_history_polls_and_after_collection(monkeypatch):
    calls, tick = [], [0.0]

    class Stop:
        stopped = False

        def is_set(self):
            return self.stopped

        def set(self):
            self.stopped = True

        def wait(self, seconds):
            tick[0] += seconds
            self.stopped = tick[0] > 300

    monkeypatch.setattr(collector.threading, "Event", Stop)
    monkeypatch.setattr(collector.signal, "signal", lambda *args: None)
    monkeypatch.setattr(collector.time, "monotonic", lambda: tick[0])
    monkeypatch.setattr(NotificationSettings, "from_env", classmethod(lambda cls: PUSH))

    def history(settings):
        calls.append(("history", tick[0]))
        return {"ok": True}

    def push(*args):
        calls.append(("push", tick[0]))
        return {"ok": False}  # Relay outage cannot stop collection.

    monkeypatch.setattr(collector, "collect_once", history)
    monkeypatch.setattr(notification_worker, "notify_once", push)
    collector.run_collector(CollectionSettings(social_enabled=False, interval_seconds=300))
    assert [at for kind, at in calls if kind == "history"] == [0, 300]
    assert [at for kind, at in calls if kind == "push"] == list(range(0, 301, 30))
    assert calls[-2:] == [("history", 300), ("push", 300)]
