"""Browser-safe public radar projection and dependency-free domain entry points."""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .classification import classify_post as classify_post
from .domain_utils import UTC, iso, number, records, timestamp
from .domain_utils import localize as _localize
from .domain_utils import safe_url as safe_url
from .history import (
    EXCLUDED_RECOVERIES,
    all_signals,
    canonical_history,
    completed_at,
    next_regular_reset,
    random_events,
)
from .history import (
    get_heatmap_event_times as get_heatmap_event_times,
)
from .probability import active_notice, calculate_probability

TRANSLATIONS = {
    "ランダムリセット": ("Random reset", "随机重置"), "定期リセット": ("Regular reset", "定期重置"),
    "個人別リセット": ("Individual reset", "个人重置"), "ご祝儀リセット": ("Celebration reset", "庆祝重置"),
    "詫びリセット": ("Compensation reset", "补偿重置"), "定期更新": ("Regular renewal", "定期更新"),
    "強制リセット": ("Automatic reset", "强制重置"), "任意リセット権配布": ("Banked reset credit", "自选重置额度发放"),
    "利用上限更新": ("Usage-limit renewal", "使用额度更新"), "リセット実施": ("Reset completed", "重置完成"),
    "全有料プラン": ("All paid plans", "全部付费套餐"), "全ユーザー": ("All users", "全部用户"),
    "任意リセット未使用アカウント": ("Accounts with unused banked resets", "尚未使用自选重置的账号"),
    "公式予告あり": ("Official advance notice", "官方预告"), "公式告知あり": ("Official announcement", "官方公告"),
    "告知投稿あり": ("Announcement posted", "已有公告"), "匂わせ投稿あり": ("Teaser posted", "已有暗示"),
    "予告あり": ("Advance notice", "已有预告"), "予告なし": ("No advance notice", "无预告"),
    "なし": ("None", "无"), "定期実施": ("Regular schedule", "定期执行"),
    "0分（定期）": ("0 min (scheduled)", "0 分钟（定期）"),
    "不明": ("Unknown", "未知"), "確認済み": ("Confirmed", "已确认"),
}


def localize(value: object, locale: str = "ja") -> str:
    text = _localize(value, locale)
    if locale in {"en", "zh"} and text in TRANSLATIONS:
        return TRANSLATIONS[text][0 if locale == "en" else 1]
    return text


def _text(locale: str, ja: str, en: str, zh: str) -> str:
    return {"ja": ja, "en": en, "zh": zh}.get(locale, ja)


def load_data() -> dict:
    """Load versioned, inspectable JSON seed data; no remote requests or secrets."""
    directory = Path(__file__).with_name("data")
    mappings = {"reset_history": "reset_history", "status_history": "status_history",
                "observation_signals": "observation_signals", "prediction_history": "probability_history"}
    result = {}
    for key, filename in mappings.items():
        path = directory / (filename + ".json")
        result[key] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    online_path = directory / "online_history.json"
    if online_path.exists():
        try:
            online = json.loads(online_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            online = None
        if (isinstance(online, list) and online and all(isinstance(row, dict) and row.get("id") and timestamp(row.get("completed_at")) for row in online)):
            indexed = {str(row.get("id")): row for row in result["reset_history"]}
            merged_rows = []
            for row in online:
                old = indexed.get(str(row.get("id")), {})
                merged = {**old, **row}
                for field in ("title", "summary"):
                    if isinstance(old.get(field), dict) and isinstance(row.get(field), str):
                        merged[field] = {**old[field], "zh": row[field]}
                merged_rows.append(merged)
            # The online endpoint is a complete history list: do not resurrect
            # older local records omitted after a source-side correction.
            result["reset_history"] = merged_rows
    metadata_path = directory / "online_history_metadata.json"
    if metadata_path.exists():
        result["history_source"] = json.loads(metadata_path.read_text(encoding="utf-8"))
    return result


def _format_date(value: datetime | None, locale: str) -> str:
    if not value:
        return "—"
    return value.astimezone(ZoneInfo("Asia/Tokyo")).strftime("%Y-%m-%d")


def _remaining(expected: datetime | None, now: datetime, locale: str) -> str:
    if not expected:
        return _text(locale, "未確定", "Unconfirmed", "尚未确定")
    minutes = max(0, int((expected - now).total_seconds() / 60))
    days, hours = minutes // 1440, minutes % 1440 // 60
    if days:
        return _text(locale, f"あと{days}日{hours}時間", f"{days}d {hours}h remaining", f"剩余 {days} 天 {hours} 小时")
    if hours:
        return _text(locale, f"あと{hours}時間{minutes % 60}分", f"{hours}h {minutes % 60}m remaining", f"剩余 {hours} 小时 {minutes % 60} 分钟")
    return _text(locale, f"あと{minutes}分", f"{minutes}m remaining", f"剩余 {minutes} 分钟")


def _duration(event: dict, locale: str) -> str:
    if event.get("window_human"):
        return localize(event["window_human"], locale)
    minutes = number(event.get("window_minutes"))
    if not minutes:
        return "—"
    hours, remainder = divmod(round(minutes), 60)
    if hours:
        return _text(locale, f"{hours}時間{remainder}分", f"{hours}h {remainder}m", f"{hours} 小时 {remainder} 分钟")
    return _text(locale, f"{remainder}分", f"{remainder} min", f"{remainder} 分钟")


def _history_view(event: dict, locale: str) -> dict:
    details = event.get("details") or {}
    localized_details = (event.get("localizedDetails") or {}).get(locale) or {}
    source = safe_url(event.get("source_url") or event.get("source") or event.get("link"))
    cycle = localize(details.get("cycleType") or "ランダムリセット", locale)
    execution = completed_at(event)
    signal = timestamp(event.get("opened_at"))
    return {
        "key": str(event.get("id") or event.get("guid") or iso(execution)),
        "title": localize(event.get("title") or details.get("cycleType") or "リセット実施", locale),
        "resetType": cycle, "resetTypes": [cycle], "status": localize("確認済み", locale),
        "details": {key: localize(localized_details.get(key, details.get(key)), locale) for key in ("cycleType", "reasonType", "resetMethod", "scope", "noticeToExecution", "noticeType", "note")},
        "date": iso(execution), "signalAt": iso(signal), "resetAt": iso(execution),
        "executionTimePrecision": event.get("executionTimePrecision") or ("announcement_fallback" if event.get("id", "").startswith("tibo-reset-") else "exact" if execution else None),
        "signalLabel": _text(locale, "告知", "Announcement", "公告"), "resetLabel": _text(locale, "実施", "Completed", "执行"),
        "scopeLabel": localize(event.get("scopeLabel") or _text(locale, "対象", "Scope", "范围"), locale),
        "scope": localize(localized_details.get("scope") or event.get("scope") or details.get("scope"), locale),
        "windowLabel": _text(locale, "告知から実施", "Notice to execution", "公告至执行"),
        "windowLength": _duration(event, locale), "source": source,
        "sourceKind": event.get("sourceKind") if event.get("sourceKind") in {"direct_post", "profile", "official_status", "none"} else "direct_post" if source and "/status/" in source else "none",
        "recordKind": event.get("recordKind", "reference"), "summary": localize(event.get("summary"), locale),
    }


def _public_recovery(data: dict, now: datetime) -> dict | None:
    candidates = records(data, "codex_recovery_observations", "recovery_observations")
    if isinstance(data.get("codex_usage_recovery"), dict):
        candidates = [data["codex_usage_recovery"], *candidates]
    consumed = {row.get("recoveryObservationId") or row.get("recovery_observation_id") for row in records(data, "reset_execution_estimates")}
    for observation in sorted(candidates, key=lambda item: str(item.get("observedAt", item.get("observed_at", ""))), reverse=True):
        observed = timestamp(observation.get("observedAt") or observation.get("observed_at"))
        if (observation.get("status") == "observed" and observation.get("confidence") == "strong"
                and observation.get("cycleHint", observation.get("cycle_hint")) == "unexpected"
                and observation.get("id") not in EXCLUDED_RECOVERIES | consumed
                and observed and timedelta(0) <= now - observed <= timedelta(minutes=90)):
            return {"status": "observed_unconfirmed", "observedAt": iso(observed), "confidence": "strong", "cycleHint": "unexpected"}
    return None


def _health(data: dict, now: datetime) -> dict:
    health = data.get("data_health") or data.get("health") or {}
    source_health = dict(health.get("sources") or {})
    if "status" in health and "supabaseSignals" not in source_health:
        if health["status"] == "healthy" and data.get("source_status") != "unavailable":
            source_health["supabaseSignals"] = {"state": "ok"}
        else:
            source_health["supabaseSignals"] = {"state": "degraded", "detail": "partial_response" if health["status"] == "warning" else "request_failed"}
    if "status_feed_available" in data and "openAIStatus" not in source_health:
        source_health["openAIStatus"] = {"state": "ok"} if data["status_feed_available"] else {"state": "degraded", "detail": "request_failed"}
    sources = {}
    for key in ("supabaseSignals", "openAIStatus"):
        source = source_health.get(key) or {"state": "degraded", "detail": "missing_configuration"}
        state = source.get("state") if source.get("state") in {"ok", "degraded", "misconfigured"} else "degraded"
        sources[key] = {"state": state}
        if source.get("detail") in {"missing_configuration", "request_failed", "invalid_response", "database_error", "partial_response"}:
            sources[key]["detail"] = source["detail"]
    checked = timestamp(data.get("checked_at") or health.get("checkedAt"))
    stale = bool(health.get("stale")) or (now - checked > timedelta(hours=1) if checked else health.get("status") != "healthy")
    return {"overall": "degraded" if stale or health.get("overall") == "degraded" or any(value["state"] != "ok" for value in sources.values()) else "ok",
            "stale": stale, "generatedAt": iso(now), "sources": sources}


def build_snapshot(data: dict, locale: str = "ja", now: datetime | None = None) -> dict:
    """Produce a public-v1 allowlist; private payload fields are never spread."""
    locale = locale if locale in {"ja", "en", "zh"} else "ja"
    now = timestamp(now) or datetime.now(UTC)
    history = canonical_history(data, now)
    event_rows = random_events(history, now)
    last_random = timestamp(event_rows[-1]["resetAt"]) if event_rows else None
    probability = calculate_probability(data, now)
    from .neural import forecast as neural_forecast
    neural = neural_forecast(history, now)
    primary = {key: probability[key] for key in (
        "probability12h", "probability24h", "probability48h", "probability72h")}
    if neural:
        primary.update(probability12h=None, probability72h=None,
                       probability24h=neural["probability24h"], probability48h=neural["probability48h"])
    expected, anchor = next_regular_reset(history, now)
    notice = active_notice(data, now, max((at for at in (last_random, anchor) if at), default=None))
    local_expected = expected.astimezone(ZoneInfo("Asia/Tokyo")) if expected else None
    notice_window = bool(expected and timedelta(0) <= expected - now <= timedelta(hours=24))
    forecast = {"date": _format_date(expected, locale), "time": local_expected.strftime("%H:%M JST") if local_expected else None,
                "remaining": _remaining(expected, now, locale), "sourceResetAt": iso(anchor), "expectedAt": iso(expected),
                "lastCompletedAt": iso(anchor), "remainingDays": max(0, (expected - now).total_seconds() / 86400) if expected else None,
                "isNoticeWindow": notice_window}
    official_expected = timestamp(notice.get("expected_start_at")) if notice else None
    official_end = timestamp(notice.get("expected_end_at")) if notice else None
    overdue = bool(notice and official_expected and official_expected < now and notice.get("temporal_precision") == "exact_time")
    kind = "official" if notice else "regular" if notice_window else "none"
    active = {"active": kind != "none", "kind": kind,
              "label": _text(locale, "公式予告", "Official notice", "官方预告") if notice else localize("定期リセット", locale) if notice_window else _text(locale, "監視中", "Monitoring", "监测中"),
              "summary": localize(notice.get("text"), locale) if notice else _text(locale, "直近の完了履歴から7日周期で予測しています。", "Estimated on a seven-day cycle from the latest completed recovery.", "根据最近一次已完成恢复，按 7 天周期推算。") if notice_window else _text(locale, "現在、有効な公式予告はありません。", "No active official notice.", "目前没有有效的官方预告。"),
              "openedAt": notice.get("tweet_created_at") if notice else None,
              "expectedAt": iso(official_expected) if notice else iso(expected) if notice_window else None,
              "expectedEndAt": iso(official_end), "expectedPrecision": notice.get("temporal_precision") if notice else None,
              "expectedTimeZone": notice.get("temporal_timezone") if notice else None,
              "source": safe_url(notice.get("tweet_url")) if notice else None, "sourceLabel": "Tibo / X" if notice else None,
              "forecastDate": forecast["date"], "forecastTime": forecast["time"], "remaining": forecast["remaining"],
              "isOverduePending": overdue, "overdueText": _text(locale, "実施確認待ち", "Awaiting confirmation", "等待执行确认") if overdue else None}
    if notice:
        active["noticeKind"] = "banked" if "banked" in str(notice.get("text", "")).lower() else "forced"
    p24, p48 = primary["probability24h"], primary["probability48h"]
    level = "very_high" if p24 >= .8 or p48 >= .85 else "high" if p24 >= .61 or p48 >= .61 else "medium" if p24 >= .3 or p48 >= .3 else "low"
    expectations = {"low": ("低", "Low", "低"), "medium": ("中", "Moderate", "中"), "high": ("高", "High", "高"), "very_high": ("非常に高い", "Very high", "很高")}
    signals = [s for s in all_signals(data, now) if s.get("verification_status") != "rejected"]
    teaser_candidates = [s for s in signals if (at := timestamp(s.get("tweet_created_at"))) and now - at <= timedelta(hours=48)
                         and (not last_random or at > last_random) and s.get("signal_type") not in {"reset_executed", "official_notice"}]
    strengths = [s.get("teaser_strength") or s.get("ai_teaser_strength") for s in teaser_candidates]
    teaser_status = "strong" if "strong" in strengths else "weak" if "weak" in strengths else "none" if "none" in strengths else "unknown"
    latest_activity = None
    if signals:
        signal = max(signals, key=lambda s: timestamp(s.get("tweet_created_at")) or datetime.min.replace(tzinfo=UTC))
        translated = signal.get(f"translated_text_{locale}") if locale in {"ja", "zh"} else None
        latest_activity = {"classification": signal.get("signal_type") if signal.get("signal_type") in {"official_notice", "reset_executed", "teaser", "irrelevant"} else "irrelevant",
                           "teaserStrength": signal.get("teaser_strength") or signal.get("ai_teaser_strength"),
                           "text": translated or signal.get("text") or None, "createdAt": signal.get("tweet_created_at"),
                           "sourceUrl": safe_url(signal.get("tweet_url")), "isReply": bool(signal.get("is_reply")),
                           "replyContextText": signal.get("reply_context_text"), "replyToHandles": [str(v) for v in (signal.get("reply_to_handles") or [])],
                           "temporalResolutionStatus": signal.get("temporal_resolution_status"),
                           "expectedStartAt": iso(timestamp(signal.get("expected_start_at"))), "expectedEndAt": iso(timestamp(signal.get("expected_end_at")))}
        if signal.get("source_kind") == "upstream_public_snapshot":
            latest_activity.update(sourceKind="upstream_public_snapshot", classification="unknown", teaserStrength=None,
                                   classificationSource="none", semanticAnalysisPerformed=False)
    public_history = [_history_view(event, locale) for event in history]
    latest = public_history[0] if public_history else {}
    latest_window = {"kind": "regular" if latest.get("recordKind") == "regular_completed" else "observed",
                     "recordKind": latest.get("recordKind", "reference"), "title": latest.get("title", _text(locale, "記録なし", "No records", "暂无记录")),
                     "summary": latest.get("summary", ""), "scopeLabel": latest.get("scopeLabel", ""), "scope": latest.get("scope", ""),
                     "openedAt": latest.get("signalAt"), "closedAt": latest.get("resetAt"),
                     "windowLabel": latest.get("windowLabel", ""), "windowLength": latest.get("windowLength", "—"),
                     "source": latest.get("source"), "sourceKind": latest.get("sourceKind", "none")}
    status_items = records(data, "openai_status_history", "status_history")
    available_status = [item for item in status_items if (at := timestamp(item.get("createdAt") or item.get("updatedAt"))) and at <= now]
    operational = "active" if any(item.get("status") not in {"resolved", "postmortem", "completed"} and not item.get("resolvedAt") for item in available_status) else "recovered" if any((at := timestamp(item.get("resolvedAt"))) and timedelta(0) <= now - at <= timedelta(hours=24) for item in available_status) else "none" if available_status else "unknown"
    if data.get("status_feed_available") is not True:
        operational = "unknown"
    updated_candidates = [timestamp(data.get("updated_at")), *(completed_at(event) for event in history), *(timestamp(s.get("tweet_created_at")) for s in signals)]
    updated = max((at for at in updated_candidates if at and at <= now), default=None)
    view_model = {"status": active["label"], "expectation": _text(locale, *expectations[level]),
                  **primary,
                  "lastUpdated": iso(updated), "regularResetForecast": forecast, "activeWindow": active,
                  "displayReasoningSummary": _text(locale, "完了済みの広域ランダムリセット履歴と現在のシグナルに基づく統計予測です。", "Statistical forecast from completed broad-scope random resets and current signals.", "根据已完成的广泛随机重置历史和当前信号进行统计预测。"),
                  "codexOperationalStatus": operational, "latestWindow": latest_window, "recentHistory": public_history}
    view_model["neuralForecast"] = neural
    view_model["statisticalBaseline"] = {key: probability[key] for key in (
        "probability12h", "probability24h", "probability48h", "probability72h")}
    from .probability import MODEL_VERSION as baseline_version
    view_model["primaryForecast"] = {"kind": "neural" if neural else "statistical_fallback",
                                    "modelVersion": neural["modelVersion"] if neural else baseline_version,
                                    "experimental": bool(neural)}
    if neural:
        view_model["displayReasoningSummary"] = _text(
            locale, "過去のリセット時刻で学習した実験的なニューラルネットワーク予測です。投稿の意味解析は行いません。",
            "Experimental neural forecast trained on historical reset times. Post semantics are not model inputs.",
            "基于历史重置时间训练的实验性神经网络预测，未使用帖文语义分析。")
    return {"schemaVersion": "public-v1", "checkedAt": iso(timestamp(data.get("checked_at")) or now), "updatedAt": iso(updated),
            "lastRandomResetAt": iso(last_random), "dataHealth": _health(data, now), "viewModel": view_model,
            "resetTeaserStatus": teaser_status, "latestTiboActivity": latest_activity, "recoveryObservation": _public_recovery(data, now)}
