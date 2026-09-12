import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from observatory.collection_config import (
    CollectionConfigError,
    CollectionSettings,
    create_collection_store,
    from_env,
)


@pytest.fixture(autouse=True)
def clean_collection_environment(monkeypatch):
    for key in list(os.environ):
        if key.startswith(("MYSQL_", "COLLECTION_")) or key == "COLLECT_HISTORY":
            monkeypatch.delenv(key)


def test_unconfigured_defaults_do_not_silently_create_sqlite():
    settings = from_env()
    assert settings.backend == "unconfigured"
    assert settings.interval_seconds == 3600
    assert settings.collect_history is False
    assert settings.output_dir == Path("var/training")
    with pytest.raises(CollectionConfigError, match="^collection_database_not_configured$"):
        create_collection_store(settings)


def test_mysql_is_selected_from_environment_without_exposing_connection_values(monkeypatch):
    values = {
        "MYSQL_HOST": "example.test", "MYSQL_PORT": "3307", "MYSQL_DATABASE": "example_db",
        "MYSQL_USER": "example_user", "MYSQL_PASSWORD": " example_password ",
        "MYSQL_SSL_CA": "/example/ca.pem", "COLLECT_HISTORY": "true",
        "COLLECTION_INTERVAL_SECONDS": "7200", "COLLECTION_OUTPUT_DIR": "var/research",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    settings = CollectionSettings.from_env()
    assert settings.backend == "mysql"
    assert settings.collect_history is True
    assert settings.interval_seconds == 7200
    assert settings.output_dir == Path("var/research")
    assert settings.mysql_password == " example_password "
    for key in ("MYSQL_HOST", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_SSL_CA"):
        assert values[key] not in repr(settings)
    calls = []
    store = object()

    def connect(**kwargs):
        calls.append(kwargs)
        return store

    monkeypatch.setitem(sys.modules, "observatory.collection_store",
                        SimpleNamespace(MySQLCollectionStore=connect))
    assert create_collection_store(settings) is store
    assert calls == [{"host": "example.test", "port": 3307, "database": "example_db",
                      "user": "example_user", "password": " example_password ",
                      "ssl_ca": "/example/ca.pem"}]


def test_partial_mysql_configuration_never_falls_back_to_sqlite(monkeypatch):
    monkeypatch.setenv("MYSQL_HOST", "example.test")
    settings = from_env()
    assert settings.backend == "mysql"
    with pytest.raises(CollectionConfigError, match="^mysql_collection_configuration_incomplete$"):
        create_collection_store(settings)


def test_explicit_sqlite_has_a_separate_path_and_ignores_app_database(monkeypatch, tmp_path):
    path = tmp_path / "collection.sqlite3"
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "app.sqlite3"))
    monkeypatch.setenv("COLLECTION_BACKEND", "sqlite")
    monkeypatch.setenv("COLLECTION_SQLITE_PATH", str(path))
    settings = from_env()
    assert settings.sqlite_path == path
    with create_collection_store(settings) as store:
        assert store.get_status()["successfulRunCount"] == 0
    assert path.is_file()
    assert not (tmp_path / "app.sqlite3").exists()


@pytest.mark.parametrize(("key", "value"), [
    ("COLLECTION_INTERVAL_SECONDS", "299"),
    ("COLLECTION_INTERVAL_SECONDS", "bad"),
    ("COLLECTION_BACKEND", "other"),
    ("MYSQL_PORT", "0"),
    ("MYSQL_PORT", "65536"),
    ("MYSQL_PORT", "bad"),
    ("COLLECT_HISTORY", "maybe"),
    ("COLLECTION_OUTPUT_DIR", ""),
    ("COLLECTION_SQLITE_PATH", ""),
])
def test_invalid_config_fails_with_sanitized_errors(monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    with pytest.raises(CollectionConfigError) as error:
        from_env()
    assert str(error.value) in {
        "invalid_collection_configuration", "invalid_collection_backend",
        "collection_interval_must_be_at_least_300_seconds",
    }


def test_interval_can_be_exact_minimum(monkeypatch):
    monkeypatch.setenv("COLLECTION_INTERVAL_SECONDS", "300")
    assert from_env().interval_seconds == 300
