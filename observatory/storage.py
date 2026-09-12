"""Persistent JSON records, with SQLite transactions and a Supabase REST adapter.

The logical table names and record fields match the existing Supabase schema.
Private monitor state is intentionally available only to backend code.
"""
from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
from typing import Any, Protocol

import httpx

Record = dict[str, Any]
TABLE_KEYS = {
    "tibo_signals": "tweet_id", "tibo_heartbeat": "id",
    "codex_usage_monitor_state": "source_key", "codex_recovery_observations": "id",
    "reset_execution_estimates": "reset_event_key", "regular_reset_events": "schedule_key",
    "prediction_history": "logged_hour", "reset_display_names": "event_key",
    "reset_display_name_candidates": "candidate_id", "tibo_formal_adoptions": "id",
    "social_post_versions": "id", "social_collection_state": "id",
    "reset_notification_state": "id", "reset_notification_seen": "id",
    "reset_notification_outbox": "id",
}
TABLE_ORDER = {
    "tibo_signals": "tweet_created_at", "prediction_history": "logged_hour",
    "codex_recovery_observations": "observed_at", "reset_execution_estimates": "display_execution_at",
    "regular_reset_events": "completed_at", "tibo_formal_adoptions": "claimed_at",
}


class StorageError(Exception):
    """An intentionally sanitized persistence error."""


class Repository(Protocol):
    def list_records(self, table: str) -> list[Record]: ...
    def get(self, table: str, key: str) -> Record | None: ...
    def put(self, table: str, row: Record, *, once: bool = False) -> bool: ...
    def apply_usage(self, plan: Record) -> Record: ...
    def transaction(self) -> Any: ...
    def close(self) -> None: ...


def _table(table: str) -> str:
    if table not in TABLE_KEYS:
        raise ValueError("Unsupported table")
    return TABLE_KEYS[table]


class SQLiteRepository:
    def __init__(self, path: str | Path = ":memory:") -> None:
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._connection = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._connection.execute("PRAGMA busy_timeout=10000")
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute(
            "CREATE TABLE IF NOT EXISTS records (table_name TEXT NOT NULL, record_key TEXT NOT NULL, "
            "payload TEXT NOT NULL, PRIMARY KEY(table_name, record_key))"
        )
        self._depth = 0

    @contextmanager
    def transaction(self) -> Iterator[None]:
        with self._lock:
            outer = self._depth == 0
            if outer:
                self._connection.execute("BEGIN IMMEDIATE")
            self._depth += 1
            try:
                yield
                if outer:
                    self._connection.execute("COMMIT")
            except BaseException:
                if outer:
                    self._connection.execute("ROLLBACK")
                raise
            finally:
                self._depth -= 1

    def list_records(self, table: str) -> list[Record]:
        _table(table)
        with self._lock:
            rows = self._connection.execute(
                "SELECT payload FROM records WHERE table_name=? ORDER BY record_key", (table,)
            ).fetchall()
        return [json.loads(row[0]) for row in rows]

    def get(self, table: str, key: str) -> Record | None:
        _table(table)
        with self._lock:
            row = self._connection.execute(
                "SELECT payload FROM records WHERE table_name=? AND record_key=?", (table, key)
            ).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, table: str, row: Record, *, once: bool = False) -> bool:
        key = str(row[_table(table)])
        encoded = json.dumps(row, ensure_ascii=False, allow_nan=False)
        sql = "INSERT INTO records (table_name, record_key, payload) VALUES (?, ?, ?) "
        sql += "ON CONFLICT DO NOTHING" if once else "ON CONFLICT DO UPDATE SET payload=excluded.payload"
        with self._lock:
            return self._connection.execute(sql, (table, key, encoded)).rowcount > 0

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
            self._connection.close()


class SupabaseRepository:
    """Service-role REST requests; usage writes use the existing atomic database RPC."""
    def __init__(self, url: str, key: str, *, client: httpx.Client | None = None) -> None:
        if not url.startswith("https://") or not key:
            raise ValueError("Supabase requires an HTTPS URL and service-role key")
        self._client = client or httpx.Client(timeout=15, follow_redirects=False)
        self._url = url.rstrip("/") + "/rest/v1/"
        self._headers = {"apikey": key, "Authorization": "Bearer " + key}
        self._lock = RLock()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        # Only protects process-local read/modify/write. Cross-process atomic
        # workflows MUST use the database RPC, as apply_usage and promotion do.
        with self._lock:
            yield

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = {**self._headers, **kwargs.pop("headers", {})}
        try:
            response = self._client.request(method, self._url + path, headers=headers, **kwargs)
            response.raise_for_status()
            return response.json() if response.content else None
        except (httpx.HTTPError, ValueError) as exc:
            raise StorageError("Database unavailable") from exc

    def list_records(self, table: str) -> list[Record]:
        _table(table)
        result: list[Record] = []
        for offset in range(0, 10_000, 1000):
            params: Record = {"select": "*", "limit": 1000, "offset": offset}
            order = TABLE_ORDER.get(table, TABLE_KEYS[table])
            params["order"] = order + ".desc.nullslast"
            page = self._request("GET", table, params=params)
            if not isinstance(page, list):
                raise StorageError("Invalid database response")
            result.extend(page)
            if len(page) < 1000:
                break
        return result

    def get(self, table: str, key: str) -> Record | None:
        field = _table(table)
        rows = self._request("GET", table, params={field: "eq." + key, "select": "*", "limit": 1})
        return rows[0] if isinstance(rows, list) and rows else None

    def put(self, table: str, row: Record, *, once: bool = False) -> bool:
        key = _table(table)
        preference = "ignore-duplicates" if once else "merge-duplicates"
        result = self._request("POST", table, params={"on_conflict": key}, json=row,
                               headers={"Prefer": "resolution=" + preference + ",return=representation"})
        return bool(result)

    def rpc(self, name: str, body: Record) -> Record:
        result = self._request("POST", "rpc/" + name, json=body)
        if not isinstance(result, dict):
            raise StorageError("Invalid database response")
        return result

    def apply_usage(self, plan: Record) -> Record:
        return self.rpc("apply_codex_usage_webhook_write", {"p_plan": plan})

    def close(self) -> None:
        self._client.close()
