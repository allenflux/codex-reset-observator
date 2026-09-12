"""Optional Telegram delivery for newly collected, confirmed reset history.

Secrets remain in process configuration. Durable outbox claims coordinate SQLite
and MySQL workers, while stable event IDs suppress repeat polls and corrections.
Telegram has no idempotency receipt: a timeout or crash after acceptance can duplicate
an alert on retry, so this is bounded at-least-once delivery, not exactly-once.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx

from observatory.domain_utils import iso, timestamp
from observatory.history import completed_at, eligible_random_reset
from observatory.storage import Record, Repository, SQLiteRepository

_STATE = "reset_notification_state"
_SEEN = "reset_notification_seen"
_OUTBOX = "reset_notification_outbox"
_MAX_ATTEMPTS = 5
_LEASE_SECONDS = 120
_TEST_INTERVAL_SECONDS = 60


class NotificationError(Exception):
    """Only stable, non-sensitive error codes cross the notification boundary."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


class _DeliveryError(NotificationError):
    def __init__(self, code: str, *, retryable: bool, retry_after: int = 0) -> None:
        self.retryable = retryable
        self.retry_after = retry_after
        super().__init__(code)


class _TelegramLogFilter(logging.Filter):
    """The Bot API embeds credentials in a URL that httpx normally logs at INFO."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        redacted = re.sub(r"(/bot)[^/\s\"'?]+", r"\1[redacted]", message)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


_LOG_FILTER = _TelegramLogFilter()


def install_telegram_log_redaction() -> None:
    for name in ("httpx", "httpcore.http11", "httpcore.http2", "httpcore.connection",
                 "httpcore.proxy", "httpcore.socks"):
        logging.getLogger(name).addFilter(_LOG_FILTER)


def _bounded_integer(env: Mapping[str, str], name: str, default: int,
                     minimum: int, maximum: int) -> int:
    try:
        result = int(env.get(name, str(default)))
        if not minimum <= result <= maximum:
            raise ValueError
        return result
    except (TypeError, ValueError):
        raise ValueError(f"Invalid {name}") from None


@dataclass(frozen=True)
class NotificationSettings:
    enabled: bool = False
    telegram_bot_token: str = field(default="", repr=False)
    telegram_chat_id: str = field(default="", repr=False)
    mobile_api_secret: str = field(default="", repr=False)
    max_event_age_seconds: int = 86400
    interval_seconds: int = 30

    def __post_init__(self) -> None:
        if self.telegram_bot_token and not re.fullmatch(r"[0-9]+:[a-zA-Z0-9_-]+", self.telegram_bot_token):
            raise ValueError("Invalid TELEGRAM_BOT_TOKEN")
        if self.telegram_chat_id and not re.fullmatch(r"-?[0-9]+|@[a-zA-Z0-9_]+", self.telegram_chat_id):
            raise ValueError("Invalid TELEGRAM_CHAT_ID")
        if not 60 <= self.max_event_age_seconds <= 604800:
            raise ValueError("Invalid NOTIFICATION_MAX_EVENT_AGE_SECONDS")
        if not 5 <= self.interval_seconds <= 3600:
            raise ValueError("Invalid NOTIFICATION_INTERVAL_SECONDS")

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> NotificationSettings:
        values = os.environ if env is None else env
        enabled = values.get("TELEGRAM_ENABLED", "false").lower().strip()
        if enabled not in {"true", "false", "1", "0"}:
            raise ValueError("Invalid TELEGRAM_ENABLED")
        return cls(
            enabled=enabled in {"true", "1"},
            telegram_bot_token=values.get("TELEGRAM_BOT_TOKEN", "").strip(),
            telegram_chat_id=values.get("TELEGRAM_CHAT_ID", "").strip(),
            mobile_api_secret=values.get("MOBILE_API_SECRET", "").strip(),
            max_event_age_seconds=_bounded_integer(
                values, "NOTIFICATION_MAX_EVENT_AGE_SECONDS", 86400, 60, 604800),
            interval_seconds=_bounded_integer(
                values, "NOTIFICATION_INTERVAL_SECONDS", 30, 5, 3600),
        )


def _now(value: datetime | None) -> datetime:
    return (value or datetime.now(UTC)).astimezone(UTC)


def _identity(event: Record) -> str | None:
    key = event.get("id")
    return hashlib.sha256(str(key).encode()).hexdigest() if key else None


def _payload(event: Record) -> Record:
    banked = event.get("recordKind") == "banked_distribution"
    title = "已发放手动重置机会" if banked else "已确认 Codex 额度重置"
    body = ("历史记录已确认发放 BANKED 手动重置机会，需要自行使用；到账可能分批进行。"
            if banked else "历史记录已确认一次全局额度重置；各账号的实际恢复时间可能不同。")
    completed = completed_at(event)
    when = completed.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC") if completed else "—"
    return {"text": f"{title}\n{body}\n记录完成时间：{when}", "disable_notification": False}


class NotificationService:
    def __init__(self, repository: Repository, settings: NotificationSettings, *,
                 client: httpx.Client | None = None) -> None:
        from observatory.mysql_repository import MySQLRepository

        self.repository = repository
        self.settings = settings
        self.client = client
        self.supported = isinstance(repository, (SQLiteRepository, MySQLRepository))
        install_telegram_log_redaction()

    @property
    def configured(self) -> bool:
        return bool(self.settings.telegram_bot_token and self.settings.telegram_chat_id) and self.supported

    @property
    def enabled(self) -> bool:
        return self.settings.enabled and self.configured

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        with self.repository.transaction():
            # Upserting the same sentinel obtains an exclusive InnoDB row lock,
            # including the first run; SELECT on a missing row is insufficient.
            self.repository.put(_STATE, {"id": "mutex"})
            yield

    def _require_enabled(self) -> None:
        if not self.supported:
            raise NotificationError("unsupported_storage")
        if not self.configured:
            raise NotificationError("not_configured")
        if not self.settings.enabled:
            raise NotificationError("disabled")

    def status(self) -> Record:
        result: Record = {
            "provider": "telegram", "enabled": self.enabled,
            "configured": self.configured,
            "testAvailable": self.enabled and bool(self.settings.mobile_api_secret),
            "lastCheckedAt": None, "lastSentAt": None, "pendingCount": 0,
            "failedCount": 0, "lastError": None,
            "pollIntervalSeconds": self.settings.interval_seconds,
        }
        if not self.supported:
            result["reason"] = "unsupported_storage"
            return result
        state = self.repository.get(_STATE, "dispatcher") or {}
        result.update({key: state.get(key) for key in ("lastCheckedAt", "lastSentAt", "lastError")})
        outbox = self.repository.list_records(_OUTBOX)
        result["pendingCount"] = sum(
            row.get("status") in {"pending", "retry", "sending"}
            for row in outbox)
        result["failedCount"] = sum(row.get("status") == "failed" for row in outbox)
        if not self.enabled:
            result["reason"] = "disabled" if self.configured else "not_configured"
        return result

    def sync_history(self, rows: Sequence[Record], *, now: datetime | None = None,
                     source_run_id: int | None = None) -> Record:
        if not self.enabled:
            return {"enabled": False, "queued": 0}
        checked = _now(now)
        current = {
            identity: row for row in rows
            if (identity := _identity(row)) and eligible_random_reset(row, checked)
        }
        queued = suppressed = 0
        with self._transaction():
            state = self.repository.get(_STATE, "dispatcher") or {"id": "dispatcher"}
            previous_run = state.get("lastSourceRunId")
            if source_run_id is not None and isinstance(previous_run, int) and source_run_id < previous_run:
                return {"enabled": True, "queued": 0, "suppressed": 0,
                        "baseline": False, "staleSnapshot": True}
            baseline = not state.get("initializedAt")
            for identity, event in current.items():
                previous = self.repository.get(_SEEN, identity)
                if previous:
                    continue
                completed = completed_at(event)
                assert completed is not None
                fresh = checked - completed <= timedelta(seconds=self.settings.max_event_age_seconds)
                disposition = "baseline" if baseline else "queued" if fresh else "stale"
                self.repository.put(_SEEN, {
                    "id": identity, "firstSeenAt": iso(checked), "disposition": disposition,
                }, once=True)
                if disposition != "queued":
                    suppressed += 1
                    continue
                self.repository.put(_OUTBOX, {
                    "id": identity, "status": "pending", "createdAt": iso(checked),
                    "completedAt": iso(completed), "nextAttemptAt": iso(checked),
                    "attempts": 0, "payload": _payload(event),
                }, once=True)
                queued += 1
            # Respect source corrections/removals before an alert is claimed.
            for pending in self.repository.list_records(_OUTBOX):
                lease = timestamp(pending.get("leaseUntil"))
                expired_claim = pending.get("status") == "sending" and (not lease or lease <= checked)
                if pending.get("status") not in {"pending", "retry"} and not expired_claim:
                    continue
                pending_event = current.get(pending["id"])
                if pending_event is None:
                    pending.update(status="cancelled", lastError="event_no_longer_confirmed")
                else:
                    completed = completed_at(pending_event)
                    pending.update(payload=_payload(pending_event), completedAt=iso(completed) if completed else None)
                self.repository.put(_OUTBOX, pending)
            state.update(initializedAt=state.get("initializedAt") or iso(checked),
                         lastCheckedAt=iso(checked))
            if source_run_id is not None:
                state["lastSourceRunId"] = source_run_id
            self.repository.put(_STATE, state)
        return {"enabled": True, "queued": queued, "suppressed": suppressed, "baseline": baseline}

    def _send(self, payload: Record) -> None:
        def request(client: httpx.Client) -> None:
            try:
                response = client.post(
                    "https://api.telegram.org/bot" + self.settings.telegram_bot_token + "/sendMessage",
                    json={**payload, "chat_id": self.settings.telegram_chat_id},
                    timeout=10, follow_redirects=False,
                )
            except httpx.HTTPError:
                raise _DeliveryError("provider_unavailable", retryable=True) from None
            status = response.status_code
            try:
                result = response.json()
            except ValueError:
                result = None
            retry_after = 0
            if isinstance(result, dict) and isinstance(result.get("parameters"), dict):
                value = result["parameters"].get("retry_after")
                if type(value) is int and 1 <= value <= 86400:
                    retry_after = value
            if not 200 <= status < 300:
                raise _DeliveryError("provider_http_error", retryable=status >= 500 or status in {408, 429},
                                     retry_after=max(30, retry_after) if status == 429 else 0)
            if not isinstance(result, dict):
                raise _DeliveryError("provider_invalid_response", retryable=True)
            if result.get("ok") is not True:
                code = result.get("error_code")
                raise _DeliveryError("provider_rejected", retryable=isinstance(code, int) and (
                    code >= 500 or code in {408, 429}), retry_after=max(30, retry_after) if code == 429 else 0)

        if self.client is not None:
            request(self.client)
        else:
            with httpx.Client(timeout=10, follow_redirects=False) as client:
                request(client)

    def _claim(self, checked: datetime) -> Record | None:
        with self._transaction():
            state = self.repository.get(_STATE, "dispatcher") or {}
            backoff = timestamp(state.get("providerBackoffUntil"))
            if backoff and backoff > checked:
                return None
            pending = sorted(self.repository.list_records(_OUTBOX), key=lambda row: (
                row.get("createdAt", ""), row["id"]))
            for row in pending:
                status = row.get("status")
                if status not in {"pending", "retry", "sending"}:
                    continue
                due = timestamp(row.get("leaseUntil") if status == "sending" else row.get("nextAttemptAt"))
                if due and due > checked:
                    continue
                completed = timestamp(row.get("completedAt"))
                if not completed or checked - completed > timedelta(seconds=self.settings.max_event_age_seconds):
                    row.update(status="expired", lastError="event_expired")
                    self.repository.put(_OUTBOX, row)
                    continue
                if row.get("attempts", 0) >= _MAX_ATTEMPTS:
                    row.update(status="failed", lastError="attempts_exhausted")
                    self.repository.put(_OUTBOX, row)
                    continue
                row.update(status="sending", attempts=row.get("attempts", 0) + 1,
                           claim=uuid4().hex, leaseUntil=iso(checked + timedelta(seconds=_LEASE_SECONDS)))
                self.repository.put(_OUTBOX, row)
                return row
        return None

    def deliver_pending(self, *, now: datetime | None = None, limit: int = 10) -> Record:
        if not self.enabled:
            return {"enabled": False, "sent": 0, "failed": 0}
        checked = _now(now)
        sent = failed = 0
        for _ in range(max(0, min(limit, 100))):
            claim = self._claim(checked)
            if claim is None:
                break
            error: _DeliveryError | None = None
            try:
                self._send(claim["payload"])
            except _DeliveryError as exc:
                error = exc
            with self._transaction():
                current = self.repository.get(_OUTBOX, claim["id"])
                if not current or current.get("claim") != claim["claim"]:
                    continue
                current.pop("claim", None)
                current.pop("leaseUntil", None)
                if error is None:
                    current.update(status="sent", sentAt=iso(checked), lastError=None)
                    state = self.repository.get(_STATE, "dispatcher") or {"id": "dispatcher"}
                    state.update(lastSentAt=iso(checked), lastError=None)
                    self.repository.put(_STATE, state)
                    sent += 1
                else:
                    retry = error.retryable and current["attempts"] < _MAX_ATTEMPTS
                    delay = max(error.retry_after, min(3600, 30 * 2 ** (current["attempts"] - 1)))
                    current.update(status="retry" if retry else "failed", lastError=error.code,
                                   nextAttemptAt=iso(checked + timedelta(seconds=delay)))
                    state = self.repository.get(_STATE, "dispatcher") or {"id": "dispatcher"}
                    state["lastError"] = error.code
                    if error.retry_after:
                        state["providerBackoffUntil"] = iso(checked + timedelta(seconds=delay))
                    self.repository.put(_STATE, state)
                    failed += 1
                self.repository.put(_OUTBOX, current)
        return {"enabled": True, "sent": sent, "failed": failed}

    def send_test(self, *, now: datetime | None = None) -> Record:
        """Caller must authenticate MOBILE_API_SECRET before invoking this method."""
        self._require_enabled()
        checked = _now(now)
        with self._transaction():
            dispatcher = self.repository.get(_STATE, "dispatcher") or {}
            backoff = timestamp(dispatcher.get("providerBackoffUntil"))
            if backoff and backoff > checked:
                raise NotificationError("rate_limited")
            state = self.repository.get(_STATE, "test") or {"id": "test"}
            previous = timestamp(state.get("lastAttemptAt"))
            if previous and checked - previous < timedelta(seconds=_TEST_INTERVAL_SECONDS):
                raise NotificationError("rate_limited")
            state["lastAttemptAt"] = iso(checked)
            self.repository.put(_STATE, state)
        try:
            self._send({"text": "Codex 重置通知测试\n通知通道已连接。此消息是测试，未检测到新的重置。",
                        "disable_notification": False})
        except _DeliveryError as error:
            with self._transaction():
                dispatcher = self.repository.get(_STATE, "dispatcher") or {"id": "dispatcher"}
                dispatcher["lastError"] = error.code
                if error.retry_after:
                    dispatcher["providerBackoffUntil"] = iso(checked + timedelta(seconds=error.retry_after))
                self.repository.put(_STATE, dispatcher)
            raise NotificationError("delivery_failed") from None
        return {"ok": True, "provider": "telegram"}
