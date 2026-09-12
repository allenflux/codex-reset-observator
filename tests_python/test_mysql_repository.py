"""Repository behavior against a DB-API test adapter; no MySQL credentials needed.

These tests verify query/transaction contracts and state transitions. Deployment
still needs a real MySQL smoke check for driver, permissions and InnoDB behavior.
"""

import json
import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from observatory.collection_config import CollectionSettings
from observatory.mysql_repository import MySQLRepository
from observatory.storage import StorageError
from observatory.webhooks import SOURCE_KEY, iso, process_usage


class DriverError(Exception):
    pass


class FakeConnection:
    def __init__(self, path=":memory:"):
        self.database = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.database.row_factory = sqlite3.Row
        self.database.execute("PRAGMA busy_timeout=10000")
        self.queries = []
        self.open_cursors = 0
        self.pings = 0
        self.fail_when = None
        self.closed = False

    def cursor(self):
        self.open_cursors += 1
        return FakeCursor(self)

    def ping(self, *, reconnect):
        assert reconnect is True
        self.pings += 1

    def close(self):
        self.closed = True
        self.database.close()


class FakeCursor:
    def __init__(self, connection):
        self.connection = connection
        self.cursor = connection.database.cursor()

    def execute(self, sql, parameters):
        normalized = " ".join(sql.split())
        self.connection.queries.append((normalized, parameters))
        if self.connection.fail_when and self.connection.fail_when(normalized, parameters):
            self.connection.fail_when = None
            raise DriverError(2006, "private connection response must not escape")
        if normalized.startswith("CREATE TABLE IF NOT EXISTS cro_records"):
            normalized = ("CREATE TABLE IF NOT EXISTS cro_records (table_name TEXT NOT NULL, "
                          "record_key TEXT NOT NULL, payload TEXT NOT NULL, "
                          "PRIMARY KEY(table_name,record_key))")
        elif normalized == "START TRANSACTION":
            normalized = "BEGIN IMMEDIATE"
        else:
            normalized = normalized.removesuffix(" FOR UPDATE").replace("%s", "?")
            normalized = normalized.replace("ON DUPLICATE KEY UPDATE payload=VALUES(payload)",
                                            "ON CONFLICT DO UPDATE SET payload=excluded.payload")
            normalized = normalized.replace("ON DUPLICATE KEY UPDATE payload=payload",
                                            "ON CONFLICT DO UPDATE SET payload=payload")
        try:
            self.cursor.execute(normalized, parameters)
        except sqlite3.IntegrityError:
            raise DriverError(1062, "duplicate key") from None

    @property
    def rowcount(self):
        return self.cursor.rowcount

    def fetchone(self):
        row = self.cursor.fetchone()
        return dict(row) if row else None

    def fetchall(self):
        return [dict(row) for row in self.cursor.fetchall()]

    def close(self):
        self.connection.open_cursors -= 1
        self.cursor.close()


@pytest.fixture
def repository():
    connection = FakeConnection()
    repo = MySQLRepository(CollectionSettings(), connection=connection)
    yield repo, connection
    repo.close()
    assert connection.open_cursors == 0


def test_additive_schema_and_basic_record_contract(repository):
    repo, connection = repository
    ddl = connection.queries[0][0]
    assert ddl.startswith("CREATE TABLE IF NOT EXISTS cro_records")
    assert "ENGINE=InnoDB" in ddl
    assert "COLLATE=utf8mb4_bin" in ddl
    assert repo.get("tibo_signals", "missing") is None
    assert repo.put("tibo_signals", {"tweet_id": "A", "text": "original"})
    assert not repo.put("tibo_signals", {"tweet_id": "A", "text": "retry"}, once=True)
    assert repo.get("tibo_signals", "A")["text"] == "original"
    assert repo.put("tibo_signals", {"tweet_id": "A", "text": "corrected"})
    assert repo.put("tibo_signals", {"tweet_id": "A", "text": "corrected"})
    assert repo.put("tibo_signals", {"tweet_id": "a", "text": "distinct case"}, once=True)
    assert [row["tweet_id"] for row in repo.list_records("tibo_signals")] == ["A", "a"]
    assert len(repo.list_records("tibo_heartbeat")) == 0
    assert connection.open_cursors == 0


def test_invalid_tables_and_keys_never_execute_sql(repository):
    repo, connection = repository
    count = len(connection.queries)
    for operation in (
        lambda: repo.list_records("other_table"),
        lambda: repo.get("other_table", "1"),
        lambda: repo.put("other_table", {"id": "1"}),
        lambda: repo.put("tibo_signals", {"tweet_id": "x" * 513}),
        lambda: repo.put("tibo_signals", {"tweet_id": "1", "bad": float("nan")}),
    ):
        with pytest.raises(ValueError):
            operation()
    assert len(connection.queries) == count


def test_quotes_are_parameters_and_private_rows_do_not_mix(repository):
    repo, connection = repository
    key = "quoted' OR 1=1 --"
    repo.put("tibo_signals", {"tweet_id": key, "text": "public"})
    repo.put("codex_usage_monitor_state", {"source_key": "private", "state": "monitor only"})
    assert repo.get("tibo_signals", key)["text"] == "public"
    assert repo.list_records("tibo_signals") == [{"tweet_id": key, "text": "public"}]
    assert all(key not in query for query, _ in connection.queries)


def test_rollback_and_nested_savepoint_contract(repository):
    repo, connection = repository
    with pytest.raises(RuntimeError), repo.transaction():
        repo.put("tibo_signals", {"tweet_id": "rolled-back"})
        raise RuntimeError("test rollback")
    assert repo.get("tibo_signals", "rolled-back") is None
    with repo.transaction():
        repo.put("tibo_signals", {"tweet_id": "outer"})
        with pytest.raises(ValueError), repo.transaction():
            repo.put("tibo_signals", {"tweet_id": "inner"})
            raise ValueError("test savepoint")
        assert repo.get("tibo_signals", "inner") is None
        assert repo.get("tibo_signals", "outer") is not None
    assert repo.get("tibo_signals", "outer") is not None
    assert repo.get("tibo_signals", "inner") is None
    queries = [query for query, _ in connection.queries]
    assert "SAVEPOINT cro_nested_1" in queries
    assert "ROLLBACK TO SAVEPOINT cro_nested_1" in queries
    assert any(query.endswith("FOR UPDATE") for query in queries)
    assert repo._depth == 0


def test_reconnect_is_only_allowed_outside_transactions(repository):
    repo, connection = repository
    before = connection.pings
    with repo.transaction():
        assert connection.pings == before + 1
        repo.put("tibo_signals", {"tweet_id": "1"})
        with repo.transaction():
            repo.get("tibo_signals", "1")
        assert connection.pings == before + 1
    assert connection.pings == before + 1
    repo.get("tibo_signals", "1")
    assert connection.pings == before + 2


def test_failed_inner_rollback_prevents_outer_commit(repository):
    repo, connection = repository
    with pytest.raises(StorageError, match="^Database unavailable$"), repo.transaction():
        repo.put("tibo_signals", {"tweet_id": "outer"})
        with pytest.raises(ValueError), repo.transaction():
            repo.put("tibo_signals", {"tweet_id": "inner"})
            connection.fail_when = lambda query, _: query.startswith("ROLLBACK TO SAVEPOINT")
            raise ValueError("test nested failure")
    assert repo.list_records("tibo_signals") == []


def observation_pair():
    now = datetime(2026, 9, 12, tzinfo=UTC)
    previous = {"observedAt": iso(now - timedelta(minutes=1)), "limitId": "codex",
                "planType": "plus", "usedPercent": 80, "windowDurationMins": 10080,
                "resetsAt": int(now.timestamp()) + 86400}
    current = {**previous, "observedAt": iso(now), "usedPercent": 0,
               "resetsAt": previous["resetsAt"] + 86400}
    return now, previous, current


def test_usage_first_observation_locks_source_before_read_and_deduplicates(repository):
    repo, connection = repository
    now, previous, current = observation_pair()
    process_usage(repo, previous, now)
    assert process_usage(repo, current, now)["recovery"] == "observed"
    assert process_usage(repo, current, now)["recovery"] == "stale"
    assert len(repo.list_records("codex_recovery_observations")) == 1
    estimates = repo.list_records("reset_execution_estimates")
    assert len(estimates) == 1
    assert "is_monitor_observed" not in estimates[0]
    lock_index = next(index for index, (_, params) in enumerate(connection.queries)
                      if params and params[0] == "__usage_locks")
    query, params = connection.queries[lock_index + 1]
    assert query.endswith("FOR UPDATE")
    assert params == ("codex_usage_monitor_state", SOURCE_KEY)


def test_usage_stale_expectation_and_nonadvancing_state_do_not_write(repository):
    repo, _ = repository
    state = {"source_key": SOURCE_KEY, "observed_at": "2026-09-12T00:00:00+00:00"}
    repo.put("codex_usage_monitor_state", state)
    plan = {"source_key": SOURCE_KEY, "state": state, "expected_previous_observed_at": None,
            "observation": {"id": "must-not-be-written"}}
    assert repo.apply_usage(plan) == {"status": "stale", "retry_required": True}
    plan["expected_previous_observed_at"] = state["observed_at"]
    assert repo.apply_usage(plan) == {"status": "stale", "retry_required": False}
    assert repo.list_records("codex_recovery_observations") == []


def test_usage_failure_rolls_back_all_related_records(repository):
    repo, connection = repository
    now, previous, current = observation_pair()
    process_usage(repo, previous, now)
    connection.fail_when = lambda query, params: (
        query.startswith("INSERT INTO") and params and params[0] == "codex_usage_monitor_state"
    )
    with pytest.raises(StorageError, match="^Database unavailable$"):
        process_usage(repo, current, now)
    assert repo.get("codex_usage_monitor_state", SOURCE_KEY)["used_percent"] == 80
    assert repo.list_records("codex_recovery_observations") == []
    assert repo.list_records("reset_execution_estimates") == []


def test_separate_connection_usage_retries_create_one_recovery(tmp_path):
    connections = [FakeConnection(str(tmp_path / "fake-mysql.sqlite3")) for _ in range(6)]
    repositories = [MySQLRepository(CollectionSettings(), connection=item) for item in connections]
    now, previous, current = observation_pair()
    try:
        process_usage(repositories[0], previous, now)
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda index: process_usage(repositories[index % 6], current, now),
                                    range(12)))
        assert sum(result["recovery"] == "observed" for result in results) == 1
        assert len(repositories[0].list_records("codex_recovery_observations")) == 1
        assert len(repositories[0].list_records("reset_execution_estimates")) == 1
    finally:
        for repo in repositories:
            repo.close()


def test_mysql_connection_options_are_explicit_and_failures_sanitized(monkeypatch):
    settings = CollectionSettings(backend="mysql", mysql_host="example.test", mysql_database="demo",
                                  mysql_user="example_user", mysql_password="example_password")
    connections = []

    def connect(**options):
        connections.append(options)
        return FakeConnection()

    driver = SimpleNamespace(connect=connect, cursors=SimpleNamespace(DictCursor=object()))
    monkeypatch.setitem(sys.modules, "pymysql", driver)
    repo = MySQLRepository(settings)
    assert connections[0]["autocommit"] is True
    assert connections[0]["database"] == "demo"
    assert connections[0]["connect_timeout"] == 10
    repo.close()

    def fail(**options):
        raise DriverError(1045, "private connection response must not escape")

    driver.connect = fail
    with pytest.raises(StorageError, match="^Database unavailable$") as error:
        MySQLRepository(settings)
    assert error.value.__suppress_context__


def test_invalid_stored_payload_is_a_sanitized_storage_error(repository):
    repo, connection = repository
    for payload in ("invalid json", json.dumps(["not an object"])):
        connection.database.execute(
            "INSERT OR REPLACE INTO cro_records VALUES (?, ?, ?)", ("tibo_signals", "bad", payload),
        )
        with pytest.raises(StorageError, match="^Invalid database response$"):
            repo.get("tibo_signals", "bad")
