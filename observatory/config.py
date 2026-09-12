"""Environment-only configuration; secret values never enter public snapshots."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from observatory.collection_config import CollectionSettings


@dataclass(frozen=True)
class Settings:
    database_path: str | Path = "var/observatory.sqlite3"
    tibo_webhook_secret: str = field(default="", repr=False)
    codex_usage_webhook_secret: str = field(default="", repr=False)
    cron_secret: str = field(default="", repr=False)
    supabase_url: str = ""
    supabase_service_role_key: str = field(default="", repr=False)
    fetch_live_status: bool = False
    site_url: str = "http://localhost:8000"
    max_body_bytes: int = 65_536
    collection: CollectionSettings | None = None

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
            site_url=os.environ.get("SITE_URL", "http://localhost:8000").rstrip("/"),
            collection=CollectionSettings.from_env(),
        )
