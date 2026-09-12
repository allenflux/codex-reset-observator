"""Validated compatibility contracts for browser and local quota monitors."""
from __future__ import annotations

import hashlib
import math
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid5

from observatory.classification import is_global_reset_signal
from observatory.storage import Record, Repository, StorageError

SOURCE_KEY = "local-codex-app-server"
PUBLIC_ESTIMATORS = {"usage-execution-v1", "usage-execution-teaser-v1", "usage-execution-monitor-v1"}


def timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or len(value) > 50:
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(UTC) if result.tzinfo else None
    except (ValueError, OverflowError):
        return None


def iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def valid_date(value: Any, now: datetime) -> str:
    result = timestamp(value)
    if result is None or result > now + timedelta(minutes=5):
        raise ValueError("Invalid timestamp")
    return iso(result)


def validate_tibo(body: Record, now: datetime) -> Record:
    tweet_id = body.get("tweetId")
    text = body.get("text")
    url = body.get("tweetUrl")
    if not isinstance(tweet_id, str) or not re.fullmatch(r"[0-9]{1,30}", tweet_id):
        raise ValueError("Invalid tweetId")
    if not isinstance(text, str) or not text.strip() or len(text) > 25_000:
        raise ValueError("Invalid text")
    if not isinstance(url, str) or not re.fullmatch(
        r"https://(?:x|twitter)\.com/thsottiaux/status/" + tweet_id + r"/?(?:\?[^#\s]*)?", url, re.I
    ):
        raise ValueError("Invalid tweetUrl: Must match @thsottiaux and tweetId")
    row: Record = {"tweet_id": tweet_id, "text": text.strip(),
                   "tweet_url": "https://x.com/thsottiaux/status/" + tweet_id,
                   "tweet_created_at": valid_date(body.get("tweetCreatedAt"), now)}
    for key, field in [("isReply", "is_reply"), ("isQuote", "is_quote")]:
        if key in body:
            if type(body[key]) is not bool:
                raise ValueError("Invalid reply metadata")
            row[field] = body[key]
    for key, field in [("replyContextText", "reply_context_text"),
                       ("quoteContextText", "quote_context_text")]:
        value = body.get(key)
        if value is not None and (not isinstance(value, str) or len(value) > 1000):
            raise ValueError("Invalid reply metadata")
        if key in body:
            row[field] = value
    handles = body.get("replyToHandles", [])
    if (not isinstance(handles, list) or len(handles) > 20 or any(
        not isinstance(handle, str) or not re.fullmatch(r"@?[A-Za-z0-9_]{1,15}", handle)
        for handle in handles
    )):
        raise ValueError("Invalid reply metadata")
    row["reply_to_handles"] = list(dict.fromkeys("@" + handle.lstrip("@") for handle in handles))
    if "sourceTimeline" in body:
        if body["sourceTimeline"] not in ("profile", "with_replies"):
            raise ValueError("Invalid reply metadata")
        row["source_timeline"] = body["sourceTimeline"]
    quote_url = body.get("quoteTweetUrl")
    if quote_url is not None:
        if not isinstance(quote_url, str) or not re.fullmatch(
            r"https://(?:x|twitter)\.com/[A-Za-z0-9_]{1,15}/status/[0-9]{1,30}/?", quote_url, re.I
        ):
            raise ValueError("Invalid quote metadata")
        row["quote_tweet_url"] = quote_url
        row["is_quote"] = True
    quote_author = body.get("quoteAuthorHandle")
    if quote_author is not None:
        if not isinstance(quote_author, str) or not re.fullmatch(r"@?[A-Za-z0-9_]{1,15}", quote_author):
            raise ValueError("Invalid quote metadata")
        row["quote_author_handle"] = "@" + quote_author.lstrip("@")
        row["is_quote"] = True
    if row.get("quote_context_text"):
        row["is_quote"] = True
    return row


def validate_usage(body: Record, now: datetime) -> Record:
    allowed = {"observedAt", "limitId", "planType", "usedPercent", "windowDurationMins",
               "resetsAt", "monitorProtocolVersion", "postReason", "bankedResetAvailableCount",
               "bankedResetCountChange"}
    if body.keys() - allowed:
        raise ValueError("Invalid usage snapshot")
    if body.get("limitId") != "codex" or body.get("windowDurationMins") != 10080:
        raise ValueError("Invalid weekly quota")
    plan = body.get("planType")
    if not isinstance(plan, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", plan):
        raise ValueError("Invalid planType")
    percent = body.get("usedPercent")
    if isinstance(percent, bool) or not isinstance(percent, (float, int)) or not math.isfinite(percent) or not 0 <= percent <= 100:
        raise ValueError("Invalid usedPercent")
    if type(body.get("resetsAt")) is not int or not 0 < body["resetsAt"] < 253402300800:
        raise ValueError("Invalid resetsAt")
    version = body.get("monitorProtocolVersion")
    reason = body.get("postReason")
    if version is not None and (type(version) is not int or version not in (1, 2)):
        raise ValueError("Invalid monitor protocol")
    if reason is not None and reason not in (
        "initial", "recovery_candidate", "banked_reset_count_change", "structure_change", "heartbeat"
    ):
        raise ValueError("Invalid postReason")
    if version == 2 and reason is None:
        raise ValueError("postReason required")
    count = body.get("bankedResetAvailableCount")
    if count is not None and (type(count) is not int or not 0 <= count <= 1000):
        raise ValueError("Invalid banked reset count")
    change = body.get("bankedResetCountChange")
    if change is not None and type(change) is not bool:
        raise ValueError("Invalid banked reset count change")
    if change and (count is None or count < 1):
        raise ValueError("Invalid banked reset count change")
    return {**body, "observedAt": valid_date(body.get("observedAt"), now)}


def build_heartbeat(body: Record, existing: Record | None, now: datetime) -> Record:
    old = existing or {}
    session = body.get("sessionId") or "default_session"
    if not isinstance(session, str) or len(session) > 200:
        raise ValueError("Invalid sessionId")
    fresh = session != old.get("session_id")
    previous = timestamp(old.get("last_heartbeat_at"))
    gap = max(0, int((now - previous).total_seconds())) if previous and not fresh else 0
    parse_at = body.get("lastSuccessfulParseAt")
    seen_id = body.get("lastSeenTweetId")
    if seen_id is not None and (not isinstance(seen_id, str) or not re.fullmatch(r"[0-9]{1,30}", seen_id)):
        raise ValueError("Invalid lastSeenTweetId")
    status = body.get("last_page_reload_status", body.get("lastPageReloadStatus"))
    if status not in (None, "success", "monitored_tab_missing", "error"):
        status = "error"
    scan_error = body.get("lastScanError")
    safe_errors = {"translated_text_detected", "scan_exception", "article_missing", "time_element_missing",
                   "tweet_text_missing", "tweet_text_empty", "tibo_status_url_missing",
                   "tweet_datetime_missing", "no_parse_success", "scan_error"}
    scan_error = scan_error if isinstance(scan_error, str) and scan_error in safe_errors else "scan_error" if scan_error else None
    version = body.get("selectorVersion", "v1")
    if not isinstance(version, str) or not re.fullmatch(r"[-A-Za-z0-9_.]{1,100}", version):
        raise ValueError("Invalid selectorVersion")
    row: Record = {
        "id": "main", "session_id": session, "session_started_at": iso(now) if fresh else old.get("session_started_at", iso(now)),
        "last_heartbeat_at": iso(now), "last_successful_parse_at": valid_date(parse_at, now) if parse_at else None,
        "last_seen_tweet_id": seen_id, "last_scan_error": scan_error, "selector_version": version,
        "last_page_reload_status": status, "last_page_reload_error": "page_reload_error" if status == "error" else None,
        "heartbeat_count": 1 if fresh else old.get("heartbeat_count", 0) + 1,
        "max_gap_seconds": 0 if fresh else max(gap, old.get("max_gap_seconds", 0)),
        "last_gap_seconds": gap, "updated_at": iso(now),
    }
    for snake, camel in [("last_page_reload_at", "lastPageReloadAt"),
                         ("newest_seen_tweet_created_at", "newestSeenTweetCreatedAt")]:
        value = body.get(snake, body.get(camel))
        row[snake] = valid_date(value, now) if value else old.get(snake)
    summary = body.get("last_scan_summary", body.get("lastScanSummary", old.get("last_scan_summary")))
    row["last_scan_summary"] = None
    if isinstance(summary, dict):
        raw_url = summary.get("currentUrl")
        parsed = urlsplit(raw_url) if isinstance(raw_url, str) else None
        if parsed and parsed.scheme == "https" and parsed.netloc in ("x.com", "twitter.com"):
            safe_summary: Record = {"currentUrl": f"https://{parsed.netloc}{parsed.path}"[:500]}
            for field in ("articleCount", "timeElementCount", "tweetTextCount", "nonEmptyTweetTextCount",
                          "matchingTiboStatusCount", "translatedTweetCount", "tweetDatetimeCount", "parseSuccessCount"):
                value = summary.get(field, 0)
                safe_summary[field] = max(0, min(10_000, int(value))) if type(value) in (int, float) and math.isfinite(value) else 0
            safe_summary["selectorVersion"] = version
            safe_summary["scanTimestamp"] = valid_date(summary.get("scanTimestamp"), now)
            row["last_scan_summary"] = safe_summary
    return row


def evaluate_health(row: Record | None, now: datetime) -> Record:
    if not row or not row.get("last_heartbeat_at"):
        return {"status": "unhealthy", "detail": "heartbeat_missing"}
    heartbeat = timestamp(row["last_heartbeat_at"])
    if not heartbeat or heartbeat > now:
        return {"status": "unhealthy", "detail": "heartbeat_future" if heartbeat else "heartbeat_invalid"}
    age = int((now - heartbeat).total_seconds())
    result: Record = {"status": "healthy", "detail": "healthy", "heartbeatAgeSeconds": age}
    parse = timestamp(row.get("last_successful_parse_at"))
    if age > 900:
        result.update(status="unhealthy", detail="heartbeat_stale")
    elif not parse:
        started = timestamp(row.get("session_started_at"))
        result.update(status="warning" if started and 0 <= (now - started).total_seconds() <= 1800 else "unhealthy", detail="parse_missing")
    elif parse > now:
        result.update(status="unhealthy", detail="parse_future")
    else:
        parse_age = int((now - parse).total_seconds())
        result["parseAgeSeconds"] = parse_age
        if parse_age > 900:
            result.update(status="warning" if parse_age <= 1800 else "unhealthy", detail="parse_stale")
    if age <= 900:
        if row.get("last_scan_error"):
            result.update(status="unhealthy", detail="scan_error")
        elif row.get("last_page_reload_status") not in (None, "success"):
            result.update(status="unhealthy", detail="page_reload_failed")
    return result


def usage_plan(body: Record, previous: Record | None, signals: list[Record], now: datetime) -> tuple[str, Record]:
    current_at = timestamp(body["observedAt"])
    assert current_at is not None
    old = previous or {}
    old_at = timestamp(old.get("observed_at"))
    banked = body.get("bankedResetAvailableCount", old.get("banked_reset_available_count"))
    old_banked = old.get("banked_reset_available_count")
    grant = old.get("last_banked_grant_at")
    if type(banked) is int and type(old_banked) is int and banked > old_banked:
        grant = body["observedAt"]
    state = {
        "source_key": SOURCE_KEY, "observed_at": body["observedAt"], "received_at": iso(now),
        "limit_id": "codex", "plan_type": body["planType"], "used_percent": body["usedPercent"],
        "window_duration_mins": 10080, "resets_at": body["resetsAt"], "updated_at": iso(now),
        "coverage_started_at": old.get("coverage_started_at", body["observedAt"]),
        "banked_reset_available_count": banked, "last_banked_grant_at": grant,
    }
    plan: Record = {"source_key": SOURCE_KEY, "expected_previous_observed_at": old.get("observed_at"), "state": state}
    if not previous:
        return "baseline", plan
    if old_at and current_at <= old_at:
        return "stale", plan
    if old.get("plan_type") != body["planType"] or not old_at or (current_at - old_at).total_seconds() > 600:
        state["coverage_started_at"] = body["observedAt"]
        return "rebase", plan
    if old["used_percent"] - body["usedPercent"] < 1 or body["resetsAt"] - old["resets_at"] < 3600:
        return "no_recovery", plan
    personal = type(old_banked) is int and type(banked) is int and banked < old_banked
    grant_at = timestamp(grant)
    personal = personal and grant_at is not None and 0 <= (current_at - grant_at).total_seconds() <= 20 * 86400
    near_regular = abs(current_at.timestamp() - old["resets_at"]) <= 300
    matched: Record | None = None
    # Only source-owned, explicit reset statements within the same recovery
    # window can corroborate. Quotes/replies, notices and old resets cannot.
    for signal in signals:
        created = timestamp(signal.get("tweet_created_at"))
        if (created and abs((created - current_at).total_seconds()) <= 5400
            and is_global_reset_signal(signal)):
            if matched is None or signal["tweet_created_at"] > matched["tweet_created_at"]:
                matched = signal
    identifier = str(uuid5(NAMESPACE_URL, SOURCE_KEY + ":" + body["observedAt"] + ":" + str(body["resetsAt"])))
    confirmed = bool(matched) and not near_regular and not personal
    observation: Record = {
        "id": identifier, "source_key": SOURCE_KEY, "observed_at": body["observedAt"],
        "previous_observed_at": old["observed_at"], "previous_used_percent": old["used_percent"],
        "current_used_percent": body["usedPercent"], "previous_resets_at": old["resets_at"],
        "current_resets_at": body["resetsAt"], "cycle_hint": "regular" if near_regular else "unexpected",
        "confidence": "medium" if near_regular else "strong", "status": "rejected" if personal else "confirmed" if confirmed else "observed",
        "matched_tibo_tweet_id": matched["tweet_id"] if confirmed and matched else None,
        "confirmed_at": iso(now) if confirmed else None, "created_at": iso(now), "updated_at": iso(now),
    }
    plan["observation"] = observation
    if near_regular and not personal:
        scheduled = datetime.fromtimestamp(old["resets_at"], UTC)
        plan["regular_reset_event"] = {
            "schedule_key": "weekly-regular-reset:" + iso(scheduled), "scheduled_at": iso(scheduled),
            "window_start_at": iso(scheduled - timedelta(minutes=2)), "window_end_at": iso(scheduled + timedelta(minutes=13)),
            "representative_at": iso(scheduled), "completed_at": body["observedAt"],
            "cycle_type": "定期リセット", "reset_method": "強制リセット", "scope": "任意リセット未使用アカウント",
            "record_kind": "regular_completed", "status": "completed",
        }
    if not near_regular and not personal:
        event_key = "usage-observation:" + identifier
        tweet_id = matched["tweet_id"] if matched else None
        plan["execution_estimate"] = {
            "reset_event_key": event_key, "display_execution_at": body["observedAt"],
            "execution_time_source": "usage_observation", "execution_time_confidence": "high",
            "execution_time_precision": "approximate", "execution_window_start_at": old["observed_at"],
            "execution_window_end_at": body["observedAt"], "recovery_observation_id": identifier,
            "recovery_previous_observed_at": old["observed_at"], "recovery_observed_at": body["observedAt"],
            "tibo_announced_at": matched["tweet_created_at"] if matched else None,
            "tibo_primary_tweet_id": tweet_id, "tibo_source_tweet_ids": [tweet_id] if tweet_id else [],
            "official_notice_tweet_id": None, "official_notice_at": None,
            "estimator_version": "usage-execution-monitor-v1",
            "is_monitor_observed": True,
        }
    return "personal_reset" if personal else "regular" if near_regular else "confirmed" if confirmed else "observed", plan


def process_usage(repo: Repository, body: Record, now: datetime) -> Record:
    with repo.transaction():
        for _ in range(3):
            previous = repo.get("codex_usage_monitor_state", SOURCE_KEY)
            status, plan = usage_plan(body, previous, repo.list_records("tibo_signals"), now)
            if status == "stale":
                return {"accepted": True, "recovery": "stale"}
            result = repo.apply_usage(plan)
            if result.get("status") == "applied":
                return {"accepted": True, "recovery": status}
            if not result.get("retry_required"):
                return {"accepted": True, "recovery": "stale"}
        raise StorageError("Concurrent usage write; retry request")


def reset_marker(records: list[Record], now: datetime) -> Record:
    eligible = []
    for row in records:
        when = timestamp(row.get("display_execution_at"))
        start = timestamp(row.get("execution_window_start_at"))
        end = timestamp(row.get("execution_window_end_at"))
        if (when and start and end and start < end == when <= now
            and row.get("execution_time_source") == "usage_observation"
            and row.get("execution_time_confidence") == "high"
            and row.get("execution_time_precision") == "approximate"
            and row.get("estimator_version") in PUBLIC_ESTIMATORS
            and row.get("recovery_observation_id") and row.get("reset_event_key")):
            eligible.append(row)
    latest = max(eligible, key=lambda row: row["display_execution_at"], default=None)
    when_iso = latest["display_execution_at"] if latest else None
    return {"schemaVersion": "reset-marker-v1", "marker": latest["reset_event_key"] + ":" + when_iso if latest else None, "resetAt": when_iso}


def post_fingerprint(row: Record) -> str:
    return hashlib.sha256((row["tweet_id"] + row["text"] + row["tweet_created_at"]).encode()).hexdigest()
