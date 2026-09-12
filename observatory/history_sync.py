"""Import published reset records as structured data, without an LLM or JS evaluation."""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

HISTORY_URL = "https://codex.gussuriworks.com/zh/history"
LOCALIZED_HISTORY_URLS = {"ja": "https://codex.gussuriworks.com/history",
                          "en": "https://codex.gussuriworks.com/en/history"}
DATA_DIR = Path(__file__).parent / "data"
MAX_SOURCE_BYTES = 4_000_000


class _Scripts(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.inside = False
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag == "script":
            self.inside = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "script":
            self.inside = False

    def handle_data(self, data: str) -> None:
        if self.inside:
            self.scripts.append(data)


def parse_history_page(html: str) -> list[dict[str, Any]]:
    """Decode Next's JSON flight payload; reject schema changes instead of guessing text."""
    parser = _Scripts()
    parser.feed(html)
    chunks = []
    for script in parser.scripts:
        match = re.fullmatch(r"self\.__next_f\.push\((.*)\);?", script, re.DOTALL)
        if not match:
            continue
        try:
            item = json.loads(match.group(1))
        except ValueError:
            continue
        if isinstance(item, list) and len(item) == 2 and item[0] == 1 and isinstance(item[1], str):
            chunks.append(item[1])
    payload = "".join(chunks)
    candidates = []
    for match in re.finditer(r'"items"\s*:\s*(?=\[)', payload):
        try:
            rows, _ = json.JSONDecoder().raw_decode(payload[match.end():])
        except ValueError:
            continue
        if rows and all(isinstance(row, dict) and "key" in row and "resetAt" in row for row in rows):
            candidates.append(rows)
    if len(candidates) != 1:
        raise ValueError("history_schema_changed: expected one complete structured history list")
    return candidates[0]


def _timestamp(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("missing_event_time")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("event_timezone_missing")
    return parsed.astimezone(UTC)


def normalize_history(rows: list[dict[str, Any]], fetched_at: datetime) -> list[dict[str, Any]]:
    output = []
    seen: set[str] = set()
    for row in rows:
        key = row.get("key")
        if not isinstance(key, str) or not key or key in seen:
            raise ValueError("invalid_or_duplicate_event_key")
        seen.add(key)
        timestamp = _timestamp(row.get("resetAt"))
        if timestamp > fetched_at:
            raise ValueError("future_completed_event")
        if not isinstance(row.get("details", {}), dict):
            raise ValueError("invalid_event_details")
        details = dict(row.get("details") or {})
        cycle = details.get("cycleType", "")
        details["cycleType"] = {"随机重置": "ランダムリセット", "定期重置": "定期リセット"}.get(cycle, cycle)
        scope = details.get("scope") or row.get("scope") or ""
        details["scope"] = {"所有付费套餐": "全有料プラン", "所有用户": "全ユーザー"}.get(scope, scope)
        source = row.get("source")
        if source and (not isinstance(source, str) or urlparse(source).scheme not in {"http", "https"}):
            raise ValueError("invalid_source_url")
        broad = (details["scope"] in {"全有料プラン", "全ユーザー", "Codex / ChatGPT Work"}
                 and row.get("randomResetTargetScope") != "conditional")
        source_id = re.search(r"/status/(\d+)", source or "")
        output.append({
            "id": key,
            "recordKind": row.get("recordKind"),
            "title": row.get("title", ""),
            "summary": row.get("summary", ""),
            "kind": "reset_completed",
            "status": "closed",
            "opened_at": row.get("signalAt") or row["resetAt"],
            "closed_at": row["resetAt"],
            "completed_at": row["resetAt"],
            "source_url": source,
            "sourceKind": row.get("sourceKind", "none"),
            "sourceTweetIds": [source_id.group(1)] if source_id else [],
            "scope": details["scope"],
            "details": details,
            "executionTimePrecision": row.get("executionTimePrecision"),
            "randomResetTargetScope": "broad" if broad else "conditional",
            "importedFrom": HISTORY_URL,
        })
    return sorted(output, key=lambda row: _timestamp(row["completed_at"]), reverse=True)


def merge_localized_history(
    rows: list[dict[str, Any]], localized_pages: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Join display text by immutable event key; ZH alone owns event eligibility.

    A translated page may be older or temporarily unavailable. It cannot add
    events, change dates, or replace the normalized cycle/scope classifications.
    """
    provenance: dict[str, Any] = {}
    for locale, source_url in LOCALIZED_HISTORY_URLS.items():
        html = (localized_pages or {}).get(locale)
        metadata: dict[str, Any] = {"sourceUrl": source_url, "status": "unavailable", "matchedRecords": 0}
        provenance[locale] = metadata
        if not isinstance(html, str):
            continue
        metadata["sourceSha256"] = hashlib.sha256(html.encode()).hexdigest()
        try:
            translated = parse_history_page(html)
            indexed = {row["key"]: row for row in translated}
            if len(indexed) != len(translated):
                raise ValueError("duplicate_localized_event_key")
        except (ValueError, TypeError, KeyError, RecursionError):
            metadata["status"] = "invalid_response"
            continue
        metadata["status"] = "ok"
        metadata["recordCount"] = len(translated)
        for row in rows:
            match = indexed.get(row["id"])
            if match is None:
                continue
            metadata["matchedRecords"] += 1
            for field in ("title", "summary"):
                text = match.get(field)
                original = row.get(field)
                if isinstance(text, str) and text.strip() and isinstance(original, (str, dict)):
                    values = dict(original) if isinstance(original, dict) else {"zh": original}
                    row[field] = {**values, locale: text}
            details = match.get("details")
            if isinstance(details, dict):
                display_details = {
                    key: details[key] for key in (
                        "cycleType", "reasonType", "resetMethod", "scope",
                        "noticeToExecution", "noticeType", "note"
                    ) if isinstance(details.get(key), str)
                }
                row.setdefault("localizedDetails", {})[locale] = display_details
            note = details.get("note") if isinstance(details, dict) else None
            original_note = row["details"].get("note", "")
            if isinstance(note, str) and note.strip() and isinstance(original_note, (str, dict)):
                notes = dict(original_note) if isinstance(original_note, dict) else {"zh": original_note}
                row["details"]["note"] = {**notes, locale: note}
    return provenance


def write_import(html: str, output: Path = DATA_DIR, fetched_at: datetime | None = None,
                 *, localized_pages: dict[str, str] | None = None) -> dict[str, Any]:
    fetched_at = fetched_at or datetime.now(UTC)
    rows = normalize_history(parse_history_page(html), fetched_at)
    translations = merge_localized_history(rows, localized_pages)
    counts: dict[str, int] = {}
    for row in rows:
        kind = row["recordKind"] or "unknown"
        counts[kind] = counts.get(kind, 0) + 1
    metadata = {
        "sourceUrl": HISTORY_URL,
        "fetchedAt": fetched_at.isoformat(),
        "sourceSha256": hashlib.sha256(html.encode()).hexdigest(),
        "recordCount": len(rows),
        "translations": translations,
        "recordKinds": counts,
        "earliestEventAt": rows[-1]["completed_at"],
        "latestEventAt": rows[0]["completed_at"],
        "scope": "Complete public history list; no private database fields",
        "limitations": [
            "Published execution timestamps may be estimates or later corrections.",
            "Historical detection timestamps and complete collection coverage are unavailable.",
            "Source records were not independently verified against every linked social post.",
        ],
    }
    output.mkdir(parents=True, exist_ok=True)
    for name, value in [("online_history", rows), ("online_history_metadata", metadata)]:
        target = output / f"{name}.json"
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(target)
    return metadata


def _fetch_page(url: str) -> str:
    with httpx.stream("GET", url, timeout=30, follow_redirects=False) as response:
        response.raise_for_status()
        parts = bytearray()
        for chunk in response.iter_bytes():
            parts.extend(chunk)
            if len(parts) > MAX_SOURCE_BYTES:
                raise ValueError("history_response_too_large")
    return parts.decode("utf-8")


def sync_history(output: Path = DATA_DIR) -> dict[str, Any]:
    html = _fetch_page(HISTORY_URL)
    localized_pages = {}
    for locale, url in LOCALIZED_HISTORY_URLS.items():
        try:
            localized_pages[locale] = _fetch_page(url)
        except (httpx.HTTPError, ValueError, UnicodeError):
            continue  # Display translations are optional; complete ZH data remains authoritative.
    return write_import(html, output, localized_pages=localized_pages)
