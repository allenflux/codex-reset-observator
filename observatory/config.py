"""Environment-only configuration; secret values never enter public snapshots."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from observatory.collection_config import CollectionSettings
from observatory.notifications import NotificationSettings


@dataclass(frozen=True)
class Settings:
    database_path: str | Path = "var/observatory.sqlite3"
    tibo_webhook_secret: str = field(default="", repr=False)
    codex_usage_webhook_secret: str = field(default="", repr=False)
    cron_secret: str = field(default="", repr=False)
    supabase_url: str = ""
    supabase_service_role_key: str = field(default="", repr=False)
    fetch_live_status: bool = False
    site_url: str = ""
    max_body_bytes: int = 65_536
    collection: CollectionSettings | None = None
    notifications: NotificationSettings = field(default_factory=NotificationSettings)

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            database_path=os.environ.get("DATABASE_PATH", "var/observatory.sqlite3"),
            tibo_webhook_secret=os.environ.get("TIBO_WEBHOOK_SECRET", "").strip(),
            codex_usage_webhook_secret=os.environ.get("CODEX_USAGE_MONITOR_SECRET", os.environ.get("CODEX_USAGE_WEBHOOK_SECRET", "")).strip(),
            cron_secret=os.environ.get("CRON_SECRET", "").strip(),
            supabase_url=os.environ.get("SUPABASE_URL", "").rstrip("/"),
            supabase_service_role_key=os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""),
            fetch_live_status=os.environ.get("FETCH_LIVE_STATUS", "false").lower() == "true",
            site_url=os.environ.get("SITE_URL", "").strip().rstrip("/"),
            collection=CollectionSettings.from_env(),
            notifications=NotificationSettings.from_env(),
        )
