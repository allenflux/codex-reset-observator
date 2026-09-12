"""Durable observations for prospective training, independent of app repositories.

Successful collection runs reference an immutable set of content-addressed event
versions. A correction or removal changes the next snapshot; it cannot rewrite
what an earlier prediction could have known. ``fetched_at`` is the local time of
observation, never an event's execution date or a source's historical fetch date.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import math
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Any

Record = dict[str, Any]
Timestamp = datetime | str


def _timestamp(value: Timestamp) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
    if not isinstance(parsed, datetime) or parsed.tzinfo is None:
        raise ValueError("collection_timezone_missing")
    return parsed.astimezone(UTC).isoformat(timespec="microseconds")


def _encode(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class CollectionStore:
    """Append collection evidence to a local SQLite database on persistent disk.

    The table prefix allows this store to share the application's SQLite file.
    It also works beside a Supabase repository; it does not sync itself to cloud
    storage. Multiple processes can collect safely through SQLite transactions.
    """

    def __init__(self, path: str | Path = ":memory:") -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._connection = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA busy_timeout=10000")
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._connection.executescript("""
            CREATE TABLE IF NOT EXISTS collection_runs (
                id INTEGER PRIMARY KEY,
                fetched_at TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('success', 'failure')),
                source_metadata TEXT NOT NULL,
                snapshot_hash TEXT,
                error_code TEXT
            );
            CREATE INDEX IF NOT EXISTS collection_runs_time ON collection_runs(fetched_at, id);
            CREATE TABLE IF NOT EXISTS collection_event_versions (
                event_key TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                payload TEXT NOT NULL,
                first_seen_at TEXT NOT NULL,
                first_run_id INTEGER NOT NULL REFERENCES collection_runs(id),
                PRIMARY KEY(event_key, content_hash)
            );
            CREATE TABLE IF NOT EXISTS collection_run_events (
                run_id INTEGER NOT NULL REFERENCES collection_runs(id),
                event_key TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY(run_id, event_key),
                FOREIGN KEY(event_key, content_hash)
                    REFERENCES collection_event_versions(event_key, content_hash)
            );
            CREATE TABLE IF NOT EXISTS collection_predictions (
                id INTEGER PRIMARY KEY,
                timestamp TEXT NOT NULL,
                probability_24h REAL NOT NULL CHECK(probability_24h BETWEEN 0 AND 1),
                probability_48h REAL NOT NULL CHECK(probability_48h BETWEEN 0 AND 1),
                model_version TEXT NOT NULL,
                features TEXT NOT NULL,
                source_run_id INTEGER NOT NULL REFERENCES collection_runs(id),
                content_hash TEXT NOT NULL UNIQUE
            );
        """)

    def __enter__(self) -> CollectionStore:
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    @contextmanager
    def _transaction(self, *, write: bool = True) -> Iterator[None]:
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            try:
                yield
                self._connection.execute("COMMIT")
            except BaseException:
                self._connection.execute("ROLLBACK")
                raise

    def record_success(self, rows: list[Record], *, fetched_at: Timestamp,
                       source_metadata: Record) -> int:
        """Keep a complete observed snapshot, deduplicating unchanged versions.

        Every successful poll is retained as coverage evidence, even when its
        content is unchanged. Caller metadata should describe source completeness.
        """
        observed_at = _timestamp(fetched_at)
        metadata = _encode(source_metadata)
        versions: list[tuple[str, str, str]] = []
        seen: set[str] = set()
        for row in rows:
            key = row.get("id")
            if not isinstance(key, str) or not key or len(key) > 191 or key in seen:
                raise ValueError("invalid_or_duplicate_event_key")
            seen.add(key)
            completed_at = row.get("completed_at")
            if not isinstance(completed_at, (datetime, str)):
                raise ValueError("missing_event_time")
            if _timestamp(completed_at) > observed_at:
                raise ValueError("future_completed_event")
            payload = _encode(row)
            versions.append((key, _digest(payload), payload))
        snapshot_hash = _digest(_encode(sorted((key, digest) for key, digest, _ in versions)))
        with self._transaction():
            cursor = self._connection.execute(
                "INSERT INTO collection_runs(fetched_at,status,source_metadata,snapshot_hash) "
                "VALUES (?,'success',?,?)", (observed_at, metadata, snapshot_hash),
            )
            run_id = int(cursor.lastrowid or 0)
            for position, (key, digest, payload) in enumerate(versions):
                self._connection.execute(
                    "INSERT OR IGNORE INTO collection_event_versions "
                    "(event_key,content_hash,payload,first_seen_at,first_run_id) VALUES (?,?,?,?,?)",
                    (key, digest, payload, observed_at, run_id),
                )
                self._connection.execute(
                    "INSERT INTO collection_run_events(run_id,event_key,content_hash,position) "
                    "VALUES (?,?,?,?)", (run_id, key, digest, position),
                )
        return run_id

    def record_failure(self, *, fetched_at: Timestamp, error_code: str,
                       source_metadata: Record | None = None) -> int:
        """Record a coverage gap without persisting exception messages or URLs."""
        observed_at = _timestamp(fetched_at)
        safe_code = error_code if re.fullmatch(r"[a-z][a-z0-9_]{0,63}", error_code) else "collection_failed"
        with self._transaction():
            cursor = self._connection.execute(
                "INSERT INTO collection_runs(fetched_at,status,source_metadata,error_code) "
                "VALUES (?,'failure',?,?)", (observed_at, _encode(source_metadata or {}), safe_code),
            )
            return int(cursor.lastrowid or 0)

    def _events_for_run(self, run_id: int) -> list[Record]:
        rows = self._connection.execute(
            "SELECT v.payload FROM collection_run_events r JOIN collection_event_versions v "
            "ON v.event_key=r.event_key AND v.content_hash=r.content_hash "
            "WHERE r.run_id=? ORDER BY r.position", (run_id,),
        ).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def events_for_run(self, run_id: int) -> list[Record]:
        with self._lock:
            return self._events_for_run(run_id)

    def latest_events(self) -> list[Record]:
        with self._transaction(write=False):
            row = self._connection.execute(
                "SELECT id FROM collection_runs WHERE status='success' ORDER BY fetched_at DESC,id DESC LIMIT 1"
            ).fetchone()
            return self._events_for_run(row["id"]) if row else []

    def asof_events(self, at: Timestamp) -> list[Record]:
        """Return the canonical source snapshot actually available by the cutoff."""
        cutoff = _timestamp(at)
        with self._transaction(write=False):
            row = self._connection.execute(
                "SELECT id FROM collection_runs WHERE status='success' AND fetched_at<=? "
                "ORDER BY fetched_at DESC,id DESC LIMIT 1", (cutoff,),
            ).fetchone()
            return self._events_for_run(row["id"]) if row else []

    def record_prediction(self, *, timestamp: Timestamp, probability24h: float,
                          probability48h: float, model_version: str, features: Record,
                          source_run_id: int) -> int:
        """Archive one issued forecast and the exact available features/model identity."""
        issued_at = _timestamp(timestamp)
        for value in (probability24h, probability48h):
            if not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError("invalid_prediction_probability")
        if probability48h < probability24h:
            raise ValueError("invalid_prediction_horizons")
        if not isinstance(model_version, str) or not model_version.strip():
            raise ValueError("missing_model_version")
        encoded_features = _encode(features)
        digest = _digest(_encode([issued_at, probability24h, probability48h, model_version,
                                  features, source_run_id]))
        with self._transaction():
            run = self._connection.execute(
                "SELECT fetched_at,status FROM collection_runs WHERE id=?", (source_run_id,),
            ).fetchone()
            if not run or run["status"] != "success" or run["fetched_at"] > issued_at:
                raise ValueError("prediction_source_not_available")
            self._connection.execute(
                "INSERT OR IGNORE INTO collection_predictions "
                "(timestamp,probability_24h,probability_48h,model_version,features,source_run_id,content_hash) "
                "VALUES (?,?,?,?,?,?,?)",
                (issued_at, probability24h, probability48h, model_version, encoded_features,
                 source_run_id, digest),
            )
            return int(self._connection.execute(
                "SELECT id FROM collection_predictions WHERE content_hash=?", (digest,),
            ).fetchone()["id"])

    def get_status(self) -> Record:
        with self._transaction(write=False):
            latest = self._connection.execute(
                "SELECT * FROM collection_runs ORDER BY fetched_at DESC,id DESC LIMIT 1"
            ).fetchone()
            success = self._connection.execute(
                "SELECT * FROM collection_runs WHERE status='success' ORDER BY fetched_at DESC,id DESC LIMIT 1"
            ).fetchone()
            counts = self._connection.execute(
                "SELECT COUNT(*) AS total,SUM(status='success') AS success,SUM(status='failure') AS failure "
                "FROM collection_runs"
            ).fetchone()
            status = {
                "latestSuccessfulAt": success["fetched_at"] if success else None,
                "latestSuccessfulRunId": success["id"] if success else None,
                "latestAttemptAt": latest["fetched_at"] if latest else None,
                "latestAttemptStatus": latest["status"] if latest else None,
                "latestErrorCode": latest["error_code"] if latest else None,
                "currentEventCount": len(self._events_for_run(success["id"])) if success else 0,
                "runCount": counts["total"],
                "successfulRunCount": int(counts["success"] or 0),
                "failedRunCount": int(counts["failure"] or 0),
            }
            status["eventCount"] = self._connection.execute(
                "SELECT COUNT(DISTINCT event_key) AS count FROM collection_event_versions"
            ).fetchone()["count"]
            for field, table in (("eventVersionCount", "collection_event_versions"),
                                 ("predictionCount", "collection_predictions")):
                status[field] = self._connection.execute(f"SELECT COUNT(*) AS count FROM {table}").fetchone()["count"]
        return status

    def export_dataset(self) -> Record:
        """Export version links, observation coverage and issued forecasts consistently.

        Removed events remain in ``eventVersions`` but are absent from subsequent
        successful runs' references. Failed runs never imply an empty source list.
        """
        with self._transaction(write=False):
            links: dict[int, list[Record]] = {}
            for row in self._connection.execute(
                "SELECT * FROM collection_run_events ORDER BY run_id,position"
            ):
                links.setdefault(row["run_id"], []).append({
                    "eventKey": row["event_key"], "contentHash": row["content_hash"],
                })
            runs = [{
                "id": row["id"], "fetchedAt": row["fetched_at"], "status": row["status"],
                "sourceMetadata": json.loads(row["source_metadata"]),
                "snapshotSha256": row["snapshot_hash"], "errorCode": row["error_code"],
                "eventVersions": links.get(row["id"], []),
            } for row in self._connection.execute("SELECT * FROM collection_runs ORDER BY fetched_at,id")]
            # Writers may commit in a different order from their actual fetches.
            # Derive first observation from immutable run links, not commit order.
            first_observations: dict[tuple[str, str], tuple[str, int]] = {}
            event_first_seen: dict[str, str] = {}
            for run in runs:
                for reference in run["eventVersions"]:
                    key = reference["eventKey"]
                    first_observations.setdefault((key, reference["contentHash"]),
                                                   (run["fetchedAt"], run["id"]))
                    event_first_seen.setdefault(key, run["fetchedAt"])
            versions = [{
                "eventKey": row["event_key"], "contentHash": row["content_hash"],
                "firstSeenAt": first_observations[(row["event_key"], row["content_hash"])][0],
                "firstRunId": first_observations[(row["event_key"], row["content_hash"])][1],
                "eventFirstSeenAt": event_first_seen[row["event_key"]], "data": json.loads(row["payload"]),
            } for row in self._connection.execute(
                "SELECT v.* FROM collection_event_versions v "
                "ORDER BY v.first_seen_at,v.event_key,v.content_hash"
            )]
            versions.sort(key=lambda row: (row["firstSeenAt"], row["eventKey"], row["contentHash"]))
            predictions = [{
                "id": row["id"], "timestamp": row["timestamp"],
                "probability24h": row["probability_24h"], "probability48h": row["probability_48h"],
                "modelVersion": row["model_version"], "features": json.loads(row["features"]),
                "sourceRunId": row["source_run_id"],
            } for row in self._connection.execute("SELECT * FROM collection_predictions ORDER BY timestamp,id")]
        return {"schemaVersion": 1, "runs": runs, "eventVersions": versions, "predictions": predictions}

    def close(self) -> None:
        with self._lock:
            self._connection.close()


SQLiteCollectionStore = CollectionStore


class CollectionStorageError(RuntimeError):
    """An intentionally sanitized persistent collection failure."""


class _MySQLConnection:
    """Adapt the store's fixed, parameterized queries to MySQL's driver API."""

    def __init__(self, connection: Any) -> None:
        self._connection = connection

    def execute(self, sql: str, parameters: tuple[Any, ...] = ()) -> Any:
        names = {
            "collection_runs": "cro_collection_runs",
            "collection_event_versions": "cro_event_versions",
            "collection_run_events": "cro_run_events",
            "collection_predictions": "cro_predictions",
        }
        for source, target in names.items():
            sql = re.sub(r"\b" + source + r"\b", target, sql)
        if sql.startswith("INSERT OR IGNORE INTO"):
            # INSERT IGNORE also suppresses truncation and other invalid data in
            # MySQL; only uniqueness conflicts are eligible for a no-op here.
            sql = sql.replace("INSERT OR IGNORE", "INSERT", 1)
            sql += " ON DUPLICATE KEY UPDATE content_hash=VALUES(content_hash)"
        sql = sql.replace("?", "%s")
        if sql in {"BEGIN", "BEGIN IMMEDIATE"}:
            sql = "START TRANSACTION"
        try:
            cursor = self._connection.cursor()
            cursor.execute(sql, parameters)
            return cursor
        except Exception:
            raise CollectionStorageError("Collection database operation failed") from None

    def close(self) -> None:
        self._connection.close()


class MySQLCollectionStore(CollectionStore):
    """Keep collection evidence in the user's existing MySQL database.

    Creates only four additive ``cro_`` tables. Configuration, credentials and
    connection exception details are never included in exports or status output.
    """

    def __init__(self, *, host: str, database: str, user: str, password: str,
                 port: int = 3306, ssl_ca: str | None = None,
                 connect_timeout: int = 10) -> None:
        self._lock = RLock()
        driver = importlib.import_module("pymysql")
        options: Record = {
            "host": host, "port": port, "database": database, "user": user,
            "password": password, "connect_timeout": connect_timeout,
            "read_timeout": 30, "write_timeout": 30, "charset": "utf8mb4",
            "cursorclass": driver.cursors.DictCursor, "autocommit": True,
        }
        if ssl_ca:
            options["ssl"] = {"ca": ssl_ca, "check_hostname": True}
        try:
            connection = driver.connect(**options)
        except Exception:
            raise CollectionStorageError("Collection database connection failed") from None
        # The private connection wrapper presents the same operations as sqlite3.
        self._connection = _MySQLConnection(connection)  # type: ignore[assignment]
        schemas = [
            """CREATE TABLE IF NOT EXISTS cro_collection_runs (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                fetched_at VARCHAR(32) NOT NULL,
                status VARCHAR(7) NOT NULL,
                source_metadata LONGTEXT NOT NULL,
                snapshot_hash CHAR(64),
                error_code VARCHAR(64),
                INDEX cro_runs_time(fetched_at,id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin""",
            """CREATE TABLE IF NOT EXISTS cro_event_versions (
                event_key VARCHAR(191) NOT NULL,
                content_hash CHAR(64) NOT NULL,
                payload LONGTEXT NOT NULL,
                first_seen_at VARCHAR(32) NOT NULL,
                first_run_id BIGINT NOT NULL,
                PRIMARY KEY(event_key,content_hash),
                FOREIGN KEY(first_run_id) REFERENCES cro_collection_runs(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin""",
            """CREATE TABLE IF NOT EXISTS cro_run_events (
                run_id BIGINT NOT NULL,
                event_key VARCHAR(191) NOT NULL,
                content_hash CHAR(64) NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY(run_id,event_key),
                FOREIGN KEY(run_id) REFERENCES cro_collection_runs(id),
                FOREIGN KEY(event_key,content_hash) REFERENCES cro_event_versions(event_key,content_hash)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin""",
            """CREATE TABLE IF NOT EXISTS cro_predictions (
                id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
                timestamp VARCHAR(32) NOT NULL,
                probability_24h DOUBLE NOT NULL,
                probability_48h DOUBLE NOT NULL,
                model_version TEXT NOT NULL,
                features LONGTEXT NOT NULL,
                source_run_id BIGINT NOT NULL,
                content_hash CHAR(64) NOT NULL UNIQUE,
                FOREIGN KEY(source_run_id) REFERENCES cro_collection_runs(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin""",
        ]
        try:
            for schema in schemas:
                self._connection.execute(schema)
        except Exception:
            self.close()
            raise
