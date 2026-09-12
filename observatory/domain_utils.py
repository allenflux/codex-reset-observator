"""Pure, dependency-free utilities shared by the Python domain modules."""
from __future__ import annotations

import math
from datetime import UTC, datetime
from urllib.parse import urlsplit

UTC = UTC


def timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
    except (ValueError, OverflowError):
        return None


def iso(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z") if value else None


def number(value: object, default: float = 0.0) -> float:
    if isinstance(value, bool):
        return default
    try:
        result = float(value)  # type: ignore[arg-type]
        return result if math.isfinite(result) else default
    except (ValueError, TypeError, OverflowError):
        return default


def clamp(value: object, low: float = 0, high: float = 1) -> float:
    return min(high, max(low, number(value)))


def safe_url(value: object) -> str | None:
    if not isinstance(value, str) or any(ord(c) < 32 for c in value):
        return None
    try:
        parsed = urlsplit(value.strip())
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            return None
        return value.strip()
    except ValueError:
        return None


def localize(value: object, locale: str = "ja") -> str:
    if isinstance(value, dict):
        selected = value.get(locale) or value.get("ja") or value.get("en") or value.get("zh") or ""
        return str(selected)
    return str(value) if value is not None else ""


def records(data: dict, *keys: str) -> list[dict]:
    for key in keys:
        value = data.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []
