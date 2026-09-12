"""Environment-only collection configuration, with no implicit database fallback."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from observatory.collection_store import CollectionStore, MySQLCollectionStore


class CollectionConfigError(ValueError):
    """A safe configuration error that never includes connection values."""


def _integer(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        raise CollectionConfigError("invalid_collection_configuration") from None


def _enabled(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name, str(default)).strip().lower()
    if raw in {"true", "1", "yes", "on"}:
        return True
    if raw in {"false", "0", "no", "off"}:
        return False
    raise CollectionConfigError("invalid_collection_configuration")


@dataclass(frozen=True)
class CollectionSettings:
    backend: str = "unconfigured"
    mysql_host: str = field(default="", repr=False)
    mysql_port: int = 3306
    mysql_database: str = field(default="", repr=False)
    mysql_user: str = field(default="", repr=False)
    mysql_password: str = field(default="", repr=False)
    mysql_ssl_ca: Path | None = field(default=None, repr=False)
    sqlite_path: Path = Path("var/collection.sqlite3")
    interval_seconds: int = 3600
    collect_history: bool = False
    output_dir: Path = Path("var/training")

    def __post_init__(self) -> None:
        if self.backend not in {"mysql", "sqlite", "unconfigured"}:
            raise CollectionConfigError("invalid_collection_backend")
        if self.interval_seconds < 300:
            raise CollectionConfigError("collection_interval_must_be_at_least_300_seconds")
        if not 1 <= self.mysql_port <= 65535:
            raise CollectionConfigError("invalid_collection_configuration")

    @classmethod
    def from_env(cls) -> CollectionSettings:
        host = os.environ.get("MYSQL_HOST", "").strip()
        backend = os.environ.get("COLLECTION_BACKEND", "").strip().lower()
        ca = os.environ.get("MYSQL_SSL_CA", "").strip()
        sqlite_path = os.environ.get("COLLECTION_SQLITE_PATH", "var/collection.sqlite3").strip()
        output_dir = os.environ.get("COLLECTION_OUTPUT_DIR", "var/training").strip()
        if not sqlite_path or not output_dir:
            raise CollectionConfigError("invalid_collection_configuration")
        return cls(
            backend=backend or ("mysql" if host else "unconfigured"),
            mysql_host=host,
            mysql_port=_integer("MYSQL_PORT", 3306),
            mysql_database=os.environ.get("MYSQL_DATABASE", "").strip(),
            mysql_user=os.environ.get("MYSQL_USER", "").strip(),
            # Whitespace can be part of a password; never normalize it.
            mysql_password=os.environ.get("MYSQL_PASSWORD", ""),
            mysql_ssl_ca=Path(ca) if ca else None,
            sqlite_path=Path(sqlite_path),
            interval_seconds=_integer("COLLECTION_INTERVAL_SECONDS", 3600),
            collect_history=_enabled("COLLECT_HISTORY"),
            output_dir=Path(output_dir),
        )


def from_env() -> CollectionSettings:
    return CollectionSettings.from_env()


def create_collection_store(
    settings: CollectionSettings | None = None,
) -> CollectionStore | MySQLCollectionStore:
    """Connect only when requested; MySQL errors never select a local replacement."""
    settings = settings or from_env()
    if settings.backend == "mysql":
        if not all((settings.mysql_host, settings.mysql_database,
                    settings.mysql_user, settings.mysql_password)):
            raise CollectionConfigError("mysql_collection_configuration_incomplete")
        from observatory.collection_store import MySQLCollectionStore

        return MySQLCollectionStore(
            host=settings.mysql_host,
            port=settings.mysql_port,
            database=settings.mysql_database,
            user=settings.mysql_user,
            password=settings.mysql_password,
            ssl_ca=str(settings.mysql_ssl_ca) if settings.mysql_ssl_ca else None,
        )
    if settings.backend == "sqlite":
        from observatory.collection_store import CollectionStore

        return CollectionStore(settings.sqlite_path)
    raise CollectionConfigError("collection_database_not_configured")
