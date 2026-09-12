"""Deliver alerts from successfully collected history, independently of forecasts."""

from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import Any

from observatory.collection_config import CollectionSettings, create_collection_store
from observatory.history import canonical_history
from observatory.mysql_repository import MySQLRepository
from observatory.notifications import NotificationService, NotificationSettings
from observatory.storage import Record, Repository, SQLiteRepository


def notify_once(
    settings: CollectionSettings,
    notifications: NotificationSettings,
    *,
    repository: Repository | None = None,
    store: Any = None,
    now: datetime | None = None,
) -> Record:
    if not notifications.enabled:
        return {"ok": True, "enabled": False}
    if settings.backend not in {"mysql", "sqlite"}:
        return {"ok": False, "error": "notification_storage_not_configured"}
    owned_repository, owned_store = repository is None, store is None
    try:
        now = now or datetime.now(UTC)
        if repository is None:
            repository = (MySQLRepository(settings) if settings.backend == "mysql"
                          else SQLiteRepository(os.environ.get("DATABASE_PATH", "var/observatory.sqlite3")))
        store = store or create_collection_store(settings)
        status = store.get_status()
        run_id = status.get("latestSuccessfulRunId")
        # An empty/unavailable source must never seed the first monitoring baseline.
        if run_id is None:
            return {"ok": True, "waitingForCollection": True}
        rows = store.events_for_run(run_id)
        history = canonical_history({"reset_history": rows}, now)
        service = NotificationService(repository, notifications)
        synced = service.sync_history(history, now=now, source_run_id=run_id)
        delivered = service.deliver_pending(now=now)
        return {"ok": True, "sync": synced, "delivery": delivered}
    except Exception:
        # Includes driver/HTTP errors; neither credentials nor relay bodies enter logs.
        return {"ok": False, "error": "notification_worker_failed"}
    finally:
        for owned, resource in ((owned_store, store), (owned_repository, repository)):
            if owned and resource is not None:
                try:
                    resource.close()
                except Exception:
                    pass
