from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from observatory.app import create_app
from observatory.config import Settings
from observatory.notifications import NotificationError, NotificationService, NotificationSettings
from observatory.storage import SQLiteRepository

NOW = datetime(2026, 9, 12, 12, tzinfo=UTC)
AUTH = {"Authorization": "Bearer mobile-test-secret"}


@pytest.fixture
def mobile():
    repo = SQLiteRepository()
    settings = Settings(database_path=":memory:", notifications=NotificationSettings(
        enabled=True, telegram_bot_token="123456:private-telegram-token", telegram_chat_id="12345", mobile_api_secret="mobile-test-secret",
    ))
    with TestClient(create_app(settings, repo, clock=lambda: NOW)) as client:
        yield client, repo
    repo.close()


def test_mobile_status_does_not_expose_credentials_or_send(mobile, monkeypatch):
    def unexpected(*args, **kwargs):
        raise AssertionError("A public read must never send notifications")

    monkeypatch.setattr(NotificationService, "send_test", unexpected)
    monkeypatch.setattr(NotificationService, "deliver_pending", unexpected)
    client, _ = mobile
    response = client.get("/api/mobile/status")
    assert response.status_code == 200
    assert response.json()["provider"] == "telegram"
    assert response.json()["testAvailable"] is True
    assert response.json()["workerFresh"] is False
    assert response.headers["cache-control"].startswith("no-store")
    for secret in ("123456:private-telegram-token", "mobile-test-secret"):
        assert secret not in response.text
        assert secret not in client.get("/api/current").text


def test_mobile_test_authorizes_before_parsing_and_disallows_destination_override(mobile):
    client, _ = mobile
    assert client.post("/api/mobile/test", content="invalid-json").status_code == 401
    for body in ({"device_key": "attacker"}, {"url": "http://example.com"}, {"body": "arbitrary"}):
        assert client.post("/api/mobile/test", headers=AUTH, json=body).status_code == 400
    assert client.post("/api/mobile/test", headers=AUTH, content="x" * 1025).status_code == 413


def test_mobile_test_sends_only_explicit_authenticated_request(mobile, monkeypatch):
    calls = []
    monkeypatch.setattr(NotificationService, "send_test", lambda self, *, now: calls.append(now))
    response = mobile[0].post("/api/mobile/test", headers=AUTH, json={})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert calls == [NOW]


@pytest.mark.parametrize(("code", "status"), [
    ("not_configured", 503), ("disabled", 503), ("unsupported_storage", 503),
    ("rate_limited", 429), ("delivery_failed", 502),
])
def test_mobile_test_returns_safe_delivery_errors(mobile, monkeypatch, code, status):
    def fail(*args, **kwargs):
        raise NotificationError(code)

    monkeypatch.setattr(NotificationService, "send_test", fail)
    response = mobile[0].post("/api/mobile/test", headers=AUTH, json={})
    assert response.status_code == status
    assert response.json() == {"error": code}


def test_unconfigured_install_keeps_mobile_dashboard_usable():
    with TestClient(create_app(Settings(database_path=":memory:"))) as client:
        status = client.get("/api/mobile/status")
        assert status.status_code == 200
        assert status.json()["enabled"] is False
        assert status.json()["testAvailable"] is False
        assert client.get("/api/current").status_code == 200
        assert client.post("/api/mobile/test", json={}).status_code == 503
