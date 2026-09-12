import json
import logging

import httpx
import pytest

from observatory import cli
from observatory.telegram_setup import private_chat_ids

TOKEN = "123456:private-setup-token"


def test_setup_fetches_private_ids_without_confirming_updates_or_logging_token(caplog):
    def handler(request):
        assert request.url.path.endswith("/getUpdates")
        assert json.loads(request.content) == {"timeout": 0, "limit": 100}
        return httpx.Response(200, json={"ok": True, "result": [
            {"message": {"chat": {"id": 123, "type": "private"}}},
            {"message": {"chat": {"id": 123, "type": "private"}}},
            {"message": {"chat": {"id": -456, "type": "group"}}},
            {"message": {"chat": {"id": True, "type": "private"}}},
            {"edited_message": {"chat": {"id": 999, "type": "private"}}},
        ]})

    with caplog.at_level(logging.INFO, logger="httpx"):
        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            assert private_chat_ids(TOKEN, client=client) == [123]
    assert TOKEN not in caplog.text


@pytest.mark.parametrize("status,body", [(401, {"description": TOKEN}), (200, {"ok": False}), (200, {"ok": True, "result": {}})])
def test_lookup_failures_are_sanitized(status, body):
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(status, json=body))) as client:
        with pytest.raises(ValueError, match="^telegram_chat_lookup_failed$") as caught:
            private_chat_ids(TOKEN, client=client)
        assert caught.value.__cause__ is None


def test_lookup_rejects_missing_or_url_shaped_token():
    for token in ("", "https://example.com/bot", "123:token/other"):
        with pytest.raises(ValueError, match="telegram_token_not_configured"):
            private_chat_ids(token)


def test_chat_id_cli_reads_environment_and_never_echoes_token(monkeypatch, capsys):
    from observatory import telegram_setup

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", TOKEN)
    seen = []
    monkeypatch.setattr(telegram_setup, "private_chat_ids", lambda token: seen.append(token) or [123])
    cli.main(["telegram-chat-id"])
    output = capsys.readouterr()
    assert seen == [TOKEN]
    assert json.loads(output.out) == {"privateChatIds": [123]}
    assert TOKEN not in output.out + output.err
