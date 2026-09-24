"""Validate the upstream public forecast as an attributed, short-lived teacher.

Only probabilities, timestamps and bounded structured context are retained.
Upstream prose and expectation labels are never imported as model inputs.
"""

from __future__ import annotations

import json
import math
import re
from datetime import UTC, datetime
from typing import Any

import httpx

SOURCE = "gussuri-public-forecast"
SOURCE_URL = "https://codex.gussuriworks.com/zh"
API_URL = "https://codex.gussuriworks.com/api/current?locale=en"
MODEL_VERSION = "upstream-public-forecast-v1"
MAX_RESPONSE_BYTES = 2_000_000
MAX_AGE_SECONDS = 30 * 60
CLOCK_SKEW_SECONDS = 60
SOURCE_ERRORS = frozenset({
    "teacher_source_unavailable", "teacher_source_invalid_response",
    "teacher_source_response_too_large", "teacher_source_schema_changed",
    "teacher_source_invalid_forecast",
})

Record = dict[str, Any]


class TeacherSourceError(ValueError):
    """A safe error code that never contains a response body or request secret."""


def _time(value: Any, *, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str) or len(value) > 64:
        raise TeacherSourceError("teacher_source_invalid_forecast")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise TeacherSourceError("teacher_source_invalid_forecast")
        return parsed.astimezone(UTC).isoformat()
    except (ValueError, OverflowError):
        raise TeacherSourceError("teacher_source_invalid_forecast") from None


def _probability(value: Any, *, optional: bool = False) -> float | None:
    if value is None and optional:
        return None
    if type(value) not in (int, float) or not 0 <= value <= 1 or not math.isfinite(value):
        raise TeacherSourceError("teacher_source_invalid_forecast")
    return float(value)


def _category(value: Any) -> str:
    if value is None:
        return "unknown"
    if not isinstance(value, str) or re.fullmatch(r"[a-zA-Z0-9_ -]{1,64}", value) is None:
        raise TeacherSourceError("teacher_source_invalid_forecast")
    return value


def _boolean(value: Any) -> bool | None:
    if value is None or type(value) is bool:
        return value
    raise TeacherSourceError("teacher_source_invalid_forecast")


def validate_teacher_forecast(record: Any) -> Record:
    """Revalidate stored or injected records and return only the supported fields."""
    if (not isinstance(record, dict) or type(record.get("schemaVersion")) is not int
            or record.get("schemaVersion") != 1
            or record.get("source") != SOURCE or record.get("sourceUrl") != SOURCE_URL
            or record.get("modelVersion") != MODEL_VERSION
            or type(record.get("sourceStale")) is not bool):
        raise TeacherSourceError("teacher_source_invalid_forecast")
    result: Record = {
        "schemaVersion": 1, "source": SOURCE, "sourceUrl": SOURCE_URL,
        "modelVersion": MODEL_VERSION,
        "checkedAt": _time(record.get("checkedAt")),
        "fetchedAt": _time(record.get("fetchedAt")),
        "updatedAt": _time(record.get("updatedAt"), optional=True),
        "lastRandomResetAt": _time(record.get("lastRandomResetAt"), optional=True),
        "sourceStale": record["sourceStale"],
    }
    probabilities = []
    for hours in (12, 24, 48, 72):
        field = f"probability{hours}h"
        result[field] = _probability(record.get(field), optional=hours in (12, 72))
        if result[field] is not None:
            probabilities.append(result[field])
    if probabilities != sorted(probabilities):
        raise TeacherSourceError("teacher_source_invalid_forecast")
    context = record.get("context", {})
    if not isinstance(context, dict):
        raise TeacherSourceError("teacher_source_invalid_forecast")
    normalized: Record = {}
    for field in ("resetTeaserStatus", "codexOperationalStatus", "latestPostClassification"):
        normalized[field] = _category(context.get(field))
    strength = context.get("latestPostTeaserStrength")
    normalized["latestPostTeaserStrength"] = (
        _probability(strength) if type(strength) in (int, float) else _category(strength)
    )
    for field in ("officialNoticeActive", "isReply", "isQuote"):
        normalized[field] = _boolean(context.get(field))
    for field in ("noticeStartsAt", "noticeEndsAt", "latestPostAt"):
        normalized[field] = _time(context.get(field), optional=True)
    result["context"] = normalized
    checked = datetime.fromisoformat(result["checkedAt"])
    # A notice may refer to a future window; observed posts/resets may not.
    observed_times = [result["updatedAt"], result["lastRandomResetAt"], normalized["latestPostAt"]]
    if any(value and (datetime.fromisoformat(value) - checked).total_seconds() > CLOCK_SKEW_SECONDS
           for value in observed_times):
        raise TeacherSourceError("teacher_source_invalid_forecast")
    return result


def teacher_status(record: Any, now: datetime | None = None) -> Record:
    """A recent fetch cannot make an old upstream computation fresh again."""
    now = now or datetime.now(UTC)
    if now.tzinfo is None:
        raise ValueError("teacher_timezone_missing")
    status: Record = {"fresh": False, "forecast": None, "reason": "missing",
                      "ageSeconds": None, "sourceAgeSeconds": None}
    if record is None:
        return status
    try:
        forecast = validate_teacher_forecast(record)
    except (TeacherSourceError, OverflowError):
        return {**status, "reason": "invalid"}
    age = (now - datetime.fromisoformat(forecast["fetchedAt"])).total_seconds()
    source_age = (now - datetime.fromisoformat(forecast["checkedAt"])).total_seconds()
    status.update(ageSeconds=age, sourceAgeSeconds=source_age)
    if min(age, source_age) < -CLOCK_SKEW_SECONDS:
        return {**status, "reason": "future_timestamp"}
    if forecast["sourceStale"]:
        return {**status, "reason": "upstream_stale"}
    if max(age, source_age) > MAX_AGE_SECONDS:
        return {**status, "reason": "expired"}
    return {**status, "fresh": True, "forecast": forecast, "reason": "fresh"}


def fetch_teacher_forecast(*, now: datetime | None = None,
                           client: httpx.Client | None = None) -> Record:
    """Fetch the fixed public JSON endpoint, without redirects or unbounded bodies."""
    owned = client is None
    client = client or httpx.Client()
    try:
        try:
            with client.stream("GET", API_URL, timeout=20, follow_redirects=False,
                               headers={"Accept": "application/json"}) as response:
                response.raise_for_status()
                body = bytearray()
                for chunk in response.iter_bytes(chunk_size=65_536):
                    body.extend(chunk)
                    if len(body) > MAX_RESPONSE_BYTES:
                        raise TeacherSourceError("teacher_source_response_too_large")
            payload = json.loads(body)
        except httpx.HTTPError:
            raise TeacherSourceError("teacher_source_unavailable") from None
        except (ValueError, UnicodeError, RecursionError) as exc:
            if isinstance(exc, TeacherSourceError):
                raise
            raise TeacherSourceError("teacher_source_invalid_response") from None
        if not isinstance(payload, dict) or not isinstance(payload.get("viewModel"), dict):
            raise TeacherSourceError("teacher_source_schema_changed")
        fetched_at = now or datetime.now(UTC)
        if fetched_at.tzinfo is None:
            raise TeacherSourceError("teacher_source_invalid_forecast")
        view = payload["viewModel"]
        health = payload.get("dataHealth") or {}
        window = view.get("activeWindow") or {}
        post = payload.get("latestTiboActivity") or {}
        if not all(isinstance(value, dict) for value in (health, window, post)):
            raise TeacherSourceError("teacher_source_schema_changed")
        active = _boolean(window.get("active"))
        record = {
            "schemaVersion": 1, "source": SOURCE, "sourceUrl": SOURCE_URL,
            "modelVersion": MODEL_VERSION, "fetchedAt": fetched_at.isoformat(),
            "checkedAt": payload.get("checkedAt"), "updatedAt": payload.get("updatedAt"),
            "lastRandomResetAt": payload.get("lastRandomResetAt"),
            # Missing health is unknown, never implicit confirmation of freshness.
            "sourceStale": health.get("stale", True),
            **{f"probability{h}h": view.get(f"probability{h}h") for h in (12, 24, 48, 72)},
            "context": {
                "resetTeaserStatus": payload.get("resetTeaserStatus"),
                "codexOperationalStatus": view.get("codexOperationalStatus"),
                "officialNoticeActive": active and window.get("kind") == "official",
                "noticeStartsAt": window.get("expectedAt"),
                "noticeEndsAt": window.get("expectedEndAt"),
                "latestPostAt": post.get("createdAt"),
                "latestPostClassification": post.get("classification"),
                "latestPostTeaserStrength": post.get("teaserStrength"),
                "isReply": post.get("isReply"), "isQuote": post.get("isQuote"),
            },
        }
        result = validate_teacher_forecast(record)
        if teacher_status(result, fetched_at)["reason"] == "future_timestamp":
            raise TeacherSourceError("teacher_source_invalid_forecast")
        return result
    finally:
        if owned:
            client.close()
