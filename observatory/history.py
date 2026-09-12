"""Canonical completed-reset eligibility and weekly scheduling.

Random probability targets include broad banked distributions. Those distributions
are not weekly schedule anchors unless they are an explicit regular completion.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from pathlib import Path

from .classification import is_global_reset_signal
from .domain_utils import iso, records, timestamp

_DATA = Path(__file__).with_name("data")


def _exclusions(filename: str) -> set[str]:
    path = _DATA / filename
    return set(json.loads(path.read_text())) if path.exists() else set()


EXCLUDED_RESETS = _exclusions("excluded_reset_event_keys.json")
EXCLUDED_RECOVERIES = _exclusions("excluded_recovery_observation_ids.json")
PENDING = {"open", "active", "pending", "scheduled", "announced", "rejected", "voided"}


def completed_at(event: dict) -> datetime | None:
    if event.get("kind") == "window_opened" or str(event.get("status", "")).lower() in PENDING:
        return None
    # An opened-only record is never a completed reset.
    return timestamp(event.get("closed_at") or event.get("completed_at") or event.get("resetAt"))


def broad_scope(event: dict) -> bool:
    scope = str(event.get("scope") or (event.get("details") or {}).get("scope") or "").strip()
    if not scope:
        return event.get("recordKind") == "confirmed_global"
    return bool(re.search(r"全|all|every|global|codex\s*/\s*chatgpt", scope, re.I)) and not bool(
        re.search(r"特定|対象ユーザー|不具合対象|個人|一部|限定|単一|specific|affected|individual|subset|single|limited", scope, re.I)
    )


def eligible_random_reset(event: dict, now: datetime) -> bool:
    completed = completed_at(event)
    return bool(
        event.get("id") not in EXCLUDED_RESETS
        and event.get("recordKind") in {"confirmed_global", "banked_distribution"}
        and event.get("randomResetTargetScope") != "conditional"
        and (event.get("details") or {}).get("cycleType") == "ランダムリセット"
        and broad_scope(event) and completed and completed <= now
    )


def regular_event(row: dict) -> dict:
    start, end = timestamp(row.get("window_start_at")), timestamp(row.get("window_end_at"))
    return {
        "id": "regular-reset-" + re.sub(r"[^a-zA-Z0-9_-]+", "-", str(row.get("schedule_key", row.get("scheduled_at", "")))),
        "recordKind": "regular_completed", "title": {"ja": "定期リセット", "en": "Regular reset", "zh": "定期重置"},
        "kind": "reset_completed", "status": "voided" if row.get("status") == "voided" else "closed",
        "opened_at": row.get("window_start_at"), "closed_at": row.get("completed_at"),
        "completed_at": row.get("completed_at"), "scope": row.get("scope", "任意リセット未使用アカウント"),
        "window_minutes": max(0, round((end - start).total_seconds() / 60)) if start and end else 0,
        "source_url": None,
        "summary": {"ja": "定期リセットが実施されました。", "en": "The regular reset completed.", "zh": "定期重置已完成。"},
        "details": {"cycleType": "定期リセット", "reasonType": "定期更新", "resetMethod": row.get("reset_method", "強制リセット"),
                    "scope": row.get("scope", "任意リセット未使用アカウント"), "noticeToExecution": "0分（定期）", "noticeType": "なし"},
    }


def all_signals(data: dict, now: datetime | None = None) -> list[dict]:
    collected: dict[str, dict] = {}
    for key in ("signals", "tibo_signals", "active_tibo_signals", "recent_tibo_signals", "formal_tibo_resets"):
        for signal in records(data, key):
            created = timestamp(signal.get("tweet_created_at"))
            available = timestamp(signal.get("detected_at") or signal.get("tweet_created_at"))
            if now and (not created or created > now or (available and available > now)):
                continue
            identity = str(signal.get("tweet_id") or f"{signal.get('tweet_created_at')}:{signal.get('text')}")
            collected[identity] = {**collected.get(identity, {}), **signal}
    # Rejection is authoritative even when a stale active copy was supplied.
    for rejected in records(data, "rejected_tibo_resets"):
        identity = str(rejected.get("tweet_id", ""))
        if identity in collected:
            collected[identity]["verification_status"] = "rejected"
    return sorted(collected.values(), key=lambda item: item.get("tweet_created_at") or "", reverse=True)


def canonical_history(data: dict, now: datetime) -> list[dict]:
    history = [dict(event) for event in records(data, "reset_history", "windows", "recent_windows")]
    history.extend(regular_event(event) for event in records(data, "regular_reset_events"))
    known_tweets = {tweet for event in history for tweet in _source_ids(event)}
    estimates = {str(row.get("resetEventKey") or row.get("reset_event_key") or row.get("eventKey") or row.get("event_key")): row for row in records(data, "reset_execution_estimates")}
    for signal in all_signals(data, now):
        tweet_id = str(signal.get("tweet_id", ""))
        if not is_global_reset_signal(signal) or tweet_id in known_tweets:
            continue
        event_id = f"tibo-reset-{tweet_id}"
        estimate = estimates.get(event_id, {})
        execution = estimate.get("displayExecutionAt") or estimate.get("display_execution_at") or signal.get("tweet_created_at")
        history.append({
            "id": event_id, "recordKind": "confirmed_global", "kind": "reset_completed", "status": "closed",
            "title": {"ja": "Tiboのリセット", "en": "Tibo reset", "zh": "Tibo 重置"}, "summary": str(signal.get("text") or ""),
            "opened_at": signal.get("tweet_created_at"), "closed_at": execution, "completed_at": execution,
            "source_url": signal.get("tweet_url"), "sourceTweetIds": [tweet_id], "scope": "全有料プラン",
            "details": {"cycleType": "ランダムリセット", "reasonType": "ご祝儀リセット", "resetMethod": "強制リセット",
                        "scope": "全有料プラン", "noticeToExecution": "—", "noticeType": "公式告知あり"},
        })
        known_tweets.add(tweet_id)
    for key, estimate in estimates.items():
        def field(camel: str, snake: str):
            return estimate.get(camel, estimate.get(snake))
        at = timestamp(field("displayExecutionAt", "display_execution_at"))
        start = timestamp(field("executionWindowStartAt", "execution_window_start_at"))
        end = timestamp(field("executionWindowEndAt", "execution_window_end_at"))
        observation = field("recoveryObservationId", "recovery_observation_id")
        estimator = field("estimatorVersion", "estimator_version")
        notice_id = field("officialNoticeTweetId", "official_notice_tweet_id")
        teaser_id = field("tiboPrimaryTweetId", "tibo_primary_tweet_id")
        source_ids = field("tiboSourceTweetIds", "tibo_source_tweet_ids") or []
        created = timestamp(field("createdAt", "created_at"))
        updated = timestamp(field("updatedAt", "updated_at"))
        monitor = not notice_id and (estimator == "usage-execution-monitor-v1" or (not teaser_id and observation))
        valid = (estimator in {"usage-execution-v1", "usage-execution-teaser-v1", "usage-execution-monitor-v1"}
                 and field("executionTimeSource", "execution_time_source") == "usage_observation"
                 and field("executionTimeConfidence", "execution_time_confidence") == "high"
                 and field("executionTimePrecision", "execution_time_precision") == "approximate"
                 and observation and observation not in EXCLUDED_RECOVERIES
                 and start and end and at and start < end and at == end and at <= now
                 and (not created or created <= now) and (not updated or updated <= now)
                 and (monitor or notice_id in source_ids or (estimator == "usage-execution-teaser-v1" and teaser_id in source_ids)))
        if not valid:
            continue
        existing = next((event for event in history if event.get("id") == key or set(_source_ids(event)).intersection(source_ids)), None)
        if existing:
            existing.update(closed_at=iso(at), completed_at=iso(at), executionTimePrecision="approximate")
            continue
        history.append({
            "id": key, "recordKind": "confirmed_global", "kind": "reset_completed", "status": "closed",
            "title": {"ja": "利用枠リセットの観測", "en": "Observed usage reset", "zh": "已观测到额度重置"},
            "summary": {"ja": "利用枠モニターの回復観測に基づく記録です。", "en": "Recorded from a usage monitor recovery observation.", "zh": "根据额度监测器的恢复观测记录。"},
            "opened_at": iso(start), "closed_at": iso(at), "completed_at": iso(at),
            "executionTimePrecision": "approximate", "sourceTweetIds": source_ids,
            "source_url": f"https://x.com/i/status/{notice_id or teaser_id}" if notice_id or teaser_id else None,
            "scope": "全有料プラン", "recoveryObservationId": observation,
            "details": {"cycleType": "ランダムリセット", "reasonType": "ご祝儀リセット", "resetMethod": "強制リセット", "scope": "全有料プラン", "noticeToExecution": "—", "noticeType": "予告なし"},
        })
    display_names = {str(row.get("event_key") or row.get("eventKey")): row for row in records(data, "reset_display_names")}
    seen: set[str] = set()
    result = []
    for event in history:
        key = str(event.get("id") or event.get("guid") or f"{event.get('source_url')}:{event.get('closed_at')}")
        details = dict(event.get("details") or {})
        normalization = {"强制重置": "強制リセット", "Automatic reset": "強制リセット", "BANKED 重置发放": "任意リセット権配布", "庆祝重置": "ご祝儀リセット", "故障补偿重置": "詫びリセット"}
        for field_name in ("resetMethod", "reasonType"):
            details[field_name] = normalization.get(str(details.get(field_name)), details.get(field_name))
        event = {**event, "details": details}
        at = completed_at(event)
        if key in seen or key in EXCLUDED_RESETS or not at or at > now:
            continue
        seen.add(key)
        names = display_names.get(key, {})
        title = event.get("title")
        localized_title = dict(title) if isinstance(title, dict) else {"ja": str(title or "")}
        for locale in ("ja", "en", "zh"):
            value = names.get("manual_name_" + locale)
            if not value and names.get("ai_status") == "accepted" and not names.get("ai_flags"):
                value = names.get("ai_name_" + locale)
            if isinstance(value, str) and value.strip():
                localized_title[locale] = value.strip()
        if names:
            event = {**event, "title": localized_title}
        result.append(event)
    return sorted(result, key=lambda row: completed_at(row), reverse=True)  # type: ignore[arg-type,return-value]


def _source_ids(event: dict) -> list[str]:
    ids = [str(value) for value in event.get("sourceTweetIds", [])]
    match = re.search(r"/status/(\d+)", str(event.get("source_url") or ""))
    if match:
        ids.append(match[1])
    return ids


def random_events(history: list[dict], now: datetime) -> list[dict]:
    seen: set[str] = set()
    result = []
    for event in history:
        if not eligible_random_reset(event, now):
            continue
        source_ids = _source_ids(event)
        at = completed_at(event)
        # One persistent banked notice can cover multiple separately observed
        # grants. The authoritative import carries their distinct canonical IDs.
        # Keep legacy/unverified post duplicates on source identity deduplication.
        if event.get("recordKind") == "banked_distribution" and event.get("importedFrom") and event.get("id"):
            identity = "canonical:" + str(event["id"])
        else:
            identity = "source:" + source_ids[0] if source_ids else str(event.get("id")) + ":" + str(iso(at))
        if identity in seen:
            continue
        seen.add(identity)
        result.append({"id": str(event.get("id", identity)), "resetAt": iso(at)})
    return sorted(result, key=lambda event: event["resetAt"])


def schedule_anchor(history: list[dict], now: datetime) -> datetime | None:
    anchors = []
    for event in history:
        details = event.get("details") or {}
        regular = event.get("recordKind") == "regular_completed" or (
            details.get("cycleType") == "定期リセット" and event.get("recordKind") in {"confirmed_global", "reference"} and broad_scope(event)
        )
        forced = event.get("recordKind") in {"confirmed_global", "banked_distribution"} and details.get("cycleType") == "ランダムリセット" and details.get("resetMethod") == "強制リセット" and broad_scope(event)
        at = completed_at(event)
        if (regular or forced) and at and at <= now:
            anchors.append(at)
    return max(anchors) if anchors else None


def next_regular_reset(history: list[dict], now: datetime) -> tuple[datetime | None, datetime | None]:
    anchor = schedule_anchor(history, now)
    if not anchor:
        return None, None
    periods = max(1, int((now - anchor).total_seconds() // (7 * 86400)) + 1)
    return anchor + timedelta(days=7 * periods), anchor


def get_heatmap_event_times(data: dict, now: datetime | None = None) -> list[str]:
    from .domain_utils import UTC
    at = now or datetime.now(UTC)
    return [row["resetAt"] for row in random_events(canonical_history(data, at), at)]
