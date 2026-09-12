"""MySQL persistence for webhook, monitor and forecast records.

Only the additive ``cro_records`` table is used. Logical tables preserve the
existing repository contract, and private usage state stays backend-only.
"""

from __future__ import annotations

import importlib
import json
from collections.abc import Iterator
from contextlib import contextmanager
from threading import RLock
from typing import Any

from observatory.collection_config import CollectionSettings
from observatory.storage import Record, StorageError, _table


class MySQLRepository:
    def __init__(self, settings: CollectionSettings, *, connection: Any = None) -> None:
        self._lock = RLock()
        self._depth = 0
        self._rollback_only = False
        self._closed = False
        if connection is None:
            if settings.backend != "mysql" or not all((settings.mysql_host,
                    settings.mysql_database, settings.mysql_user, settings.mysql_password)):
                raise StorageError("Database configuration unavailable")
            driver = importlib.import_module("pymysql")
            options: Record = {
                "host": settings.mysql_host, "port": settings.mysql_port,
                "database": settings.mysql_database, "user": settings.mysql_user,
                "password": settings.mysql_password, "connect_timeout": 10,
                "read_timeout": 30, "write_timeout": 30, "charset": "utf8mb4",
                "cursorclass": driver.cursors.DictCursor, "autocommit": True,
            }
            if settings.mysql_ssl_ca:
                options["ssl"] = {"ca": str(settings.mysql_ssl_ca), "check_hostname": True}
            try:
                connection = driver.connect(**options)
            except Exception:
                raise StorageError("Database unavailable") from None
        self._connection = connection
        try:
            self._query("""
                CREATE TABLE IF NOT EXISTS cro_records (
                    table_name VARCHAR(64) NOT NULL,
                    record_key VARCHAR(512) NOT NULL,
                    payload LONGTEXT NOT NULL,
                    PRIMARY KEY(table_name, record_key)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin
            """)
        except StorageError:
            self.close()
            raise

    def _query(self, sql: str, params: tuple[Any, ...] = (), *,
               fetch: str = "", duplicate_ok: bool = False) -> Any:
        """Keep driver exceptions and parameter values out of callers and logs."""
        cursor = None
        with self._lock:
            try:
                if not self._depth:
                    # Idle web connections may expire. Reconnect only before a
                    # transaction starts, never halfway through a recovery write.
                    ping = getattr(self._connection, "ping", None)
                    if ping is not None:
                        ping(reconnect=True)
                cursor = self._connection.cursor()
                cursor.execute(sql, params)
                if fetch == "all":
                    return cursor.fetchall()
                if fetch == "one":
                    return cursor.fetchone()
                return cursor.rowcount
            except Exception as exc:
                if duplicate_ok and exc.args and exc.args[0] == 1062:
                    return 0
                raise StorageError("Database unavailable") from None
            finally:
                if cursor is not None:
                    try:
                        cursor.close()
                    except Exception:
                        pass

    def _rollback(self, savepoint: str | None) -> None:
        try:
            self._query("ROLLBACK" if savepoint is None else "ROLLBACK TO SAVEPOINT " + savepoint)
            if savepoint is not None:
                self._query("RELEASE SAVEPOINT " + savepoint)
        except StorageError:
            # Preserve the initial sanitized failure if the connection has gone away.
            self._rollback_only = True

    @contextmanager
    def transaction(self) -> Iterator[None]:
        with self._lock:
            savepoint = "cro_nested_" + str(self._depth) if self._depth else None
            self._query("START TRANSACTION" if savepoint is None else "SAVEPOINT " + savepoint)
            self._depth += 1
            try:
                yield
                if self._rollback_only:
                    raise StorageError("Database unavailable")
                self._query("COMMIT" if savepoint is None else "RELEASE SAVEPOINT " + savepoint)
            except BaseException:
                self._rollback(savepoint)
                raise
            finally:
                self._depth -= 1
                if self._depth == 0:
                    self._rollback_only = False

    @staticmethod
    def _decode(row: Record | None) -> Record | None:
        if row is None:
            return None
        try:
            decoded = json.loads(row["payload"])
            if not isinstance(decoded, dict):
                raise ValueError
            return decoded
        except (KeyError, TypeError, ValueError):
            raise StorageError("Invalid database response") from None

    def list_records(self, table: str) -> list[Record]:
        _table(table)
        with self._lock:
            suffix = " FOR UPDATE" if self._depth else ""
            rows = self._query(
                "SELECT payload FROM cro_records WHERE table_name=%s ORDER BY record_key" + suffix,
                (table,), fetch="all",
            )
            return [decoded for row in rows if (decoded := self._decode(row)) is not None]

    def get(self, table: str, key: str) -> Record | None:
        _table(table)
        with self._lock:
            if self._depth and table == "codex_usage_monitor_state":
                # An internal mutex row serializes the very first observation too.
                # A missing state's FOR UPDATE gap lock alone can admit two readers.
                self._query(
                    "INSERT INTO cro_records (table_name,record_key,payload) VALUES (%s,%s,%s) "
                    "ON DUPLICATE KEY UPDATE payload=payload", ("__usage_locks", key, "{}"),
                )
            suffix = " FOR UPDATE" if self._depth else ""
            row = self._query(
                "SELECT payload FROM cro_records WHERE table_name=%s AND record_key=%s" + suffix,
                (table, key), fetch="one",
            )
            return self._decode(row)

    def put(self, table: str, row: Record, *, once: bool = False) -> bool:
        key = str(row[_table(table)])
        if not key or len(key) > 512:
            raise ValueError("Invalid record key")
        encoded = json.dumps(row, ensure_ascii=False, allow_nan=False)
        sql = "INSERT INTO cro_records (table_name,record_key,payload) VALUES (%s,%s,%s)"
        if not once:
            sql += " ON DUPLICATE KEY UPDATE payload=VALUES(payload)"
        changed = self._query(sql, (table, key, encoded), duplicate_ok=once)
        return changed > 0 if once else True

    def apply_usage(self, plan: Record) -> Record:
        with self.transaction():
            state = plan["state"]
            existing = self.get("codex_usage_monitor_state", plan["source_key"])
            old_at = existing.get("observed_at") if existing else None
            if old_at != plan["expected_previous_observed_at"]:
                return {"status": "stale", "retry_required": True}
            if old_at and state["observed_at"] <= old_at:
                return {"status": "stale", "retry_required": False}
            observation = plan.get("observation")
            if observation:
                self.put("codex_recovery_observations", observation, once=True)
            for field, table in [("execution_estimate", "reset_execution_estimates"),
                                 ("regular_reset_event", "regular_reset_events")]:
                if field in plan:
                    row = dict(plan[field])
                    row.pop("is_monitor_observed", None)
                    self.put(table, row, once=True)
            self.put("codex_usage_monitor_state", state)
            return {"status": "applied", "retry_required": False}

    def close(self) -> None:
        with self._lock:
            if not self._closed:
                self._closed = True
                try:
                    self._connection.close()
                except Exception:
                    raise StorageError("Database unavailable") from None
