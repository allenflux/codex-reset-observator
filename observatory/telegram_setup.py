"""Read private chat IDs without putting the bot token in shell arguments."""

from __future__ import annotations

import re

import httpx

from observatory.notifications import install_telegram_log_redaction


def private_chat_ids(token: str, *, client: httpx.Client | None = None) -> list[int]:
    if not re.fullmatch(r"[0-9]+:[A-Za-z0-9_-]+", token):
        raise ValueError("telegram_token_not_configured")
    install_telegram_log_redaction()

    def fetch(connection: httpx.Client) -> list[int]:
        try:
            response = connection.post(
                "https://api.telegram.org/bot" + token + "/getUpdates",
                json={"timeout": 0, "limit": 100}, timeout=15, follow_redirects=False,
            )
            response.raise_for_status()
            body = response.json()
            if not isinstance(body, dict) or body.get("ok") is not True:
                raise ValueError
            updates = body.get("result")
            if not isinstance(updates, list):
                raise ValueError
            result = set()
            for update in updates:
                message = update.get("message") if isinstance(update, dict) else None
                chat = message.get("chat") if isinstance(message, dict) else None
                if (isinstance(chat, dict) and chat.get("type") == "private"
                        and type(chat.get("id")) is int and chat["id"] > 0):
                    result.add(chat["id"])
            return sorted(result)
        except (httpx.HTTPError, ValueError, TypeError):
            # HTTP exceptions and Telegram descriptions may contain the token URL.
            raise ValueError("telegram_chat_lookup_failed") from None

    if client is not None:
        return fetch(client)
    with httpx.Client() as owned:
        return fetch(owned)
