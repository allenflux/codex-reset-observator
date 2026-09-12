"""Python hazard/odds baseline with prequential intercept calibration.

The numerical estimator follows the September 2026 V4 rollback implementation.
The distinct Python model identity records the smaller supported input projection;
see docs/python-model-parity.md for parity evidence and deliberate boundaries.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

from .domain_utils import UTC, clamp, iso, number, records, timestamp
from .history import all_signals, canonical_history, random_events, schedule_anchor

MODEL_VERSION = "python-hazard-odds-calibrated-v1"
RAW_MODEL_VERSION = "python-hazard-odds-v1"


def build_hazard(events: list[dict], now: datetime, half_life_days: float | None = None) -> dict:
    if half_life_days is not None and (not math.isfinite(half_life_days) or half_life_days <= 0):
        raise ValueError("half_life_days must be positive and finite")
    unique = {(str(event.get("id")), timestamp(event.get("resetAt"))): event for event in events}
    times = sorted(at for (_, at) in unique if at and at <= now)
    bins: list[dict] = [{"startHour": i * 24, "endHour": (i + 1) * 24 if i < 7 else None,
             "exposureHours": 0.0, "observedEvents": 0.0} for i in range(8)]

    def exposure(duration: float, weight: float) -> None:
        cursor = 0.0
        while cursor < duration:
            index = min(7, int(cursor // 24))
            end = min(duration, bins[index]["endHour"] or float("inf"))
            bins[index]["exposureHours"] += (end - cursor) * weight
            cursor = end

    count, weighted_events, weighted_exposure = 0, 0.0, 0.0
    for previous, current in zip(times, times[1:]):
        duration = (current - previous).total_seconds() / 3600
        if duration <= 0:
            continue
        weight = math.exp(-math.log(2) * (now - current).total_seconds() / 86400 / half_life_days) if half_life_days else 1.0
        exposure(duration, weight)
        bins[min(7, int(duration // 24))]["observedEvents"] += weight
        count += 1
        weighted_events += weight
        weighted_exposure += duration * weight
    if times:
        censored = max(0.0, (now - times[-1]).total_seconds() / 3600)
        exposure(censored, 1)
        weighted_exposure += censored
    global_rate = (weighted_events + 1) / (weighted_exposure + 240)
    for item in bins:
        rate = (item["observedEvents"] + global_rate * 480) / (item["exposureHours"] + 480)
        daily = clamp(1 - math.exp(-rate * 24), .01, .35)
        item["posteriorLambdaPerHour"] = -math.log(1 - daily) / 24
        item["impliedDailyProbability"] = daily
    return {"globalLambdaPerHour": global_rate, "bins": bins, "completedIntervalCount": count,
            "completedEventCount": len(times), "weightedEventCount": weighted_events,
            "totalExposureHours": weighted_exposure, "totalExposureDays": weighted_exposure / 24}


def integrate_hazard(hazard: dict, start_age_hours: float, horizon_hours: float) -> float:
    if not math.isfinite(start_age_hours) or not math.isfinite(horizon_hours) or horizon_hours <= 0:
        return 0
    cursor, end = max(0, start_age_hours), max(0, start_age_hours) + horizon_hours
    cumulative = 0.0
    while cursor < end:
        item = hazard["bins"][min(7, int(cursor // 24))]
        segment_end = min(end, item["endHour"] or float("inf"))
        cumulative += item["posteriorLambdaPerHour"] * (segment_end - cursor)
        cursor = segment_end
    return clamp(1 - math.exp(-max(0, cumulative)))


def apply_odds_multiplier(probability: float, multiplier: float) -> float:
    if probability <= 0:
        return 0
    if probability >= 1:
        return 1
    if not math.isfinite(multiplier) or multiplier <= 0:
        return 0
    odds = probability / (1 - probability) * multiplier
    return odds / (1 + odds)


def horizons(probability24h: float, probability48h: float) -> dict[str, float]:
    p24 = clamp(probability24h)
    p48 = max(p24, clamp(probability48h))
    return {"probability12h": 1 - (1 - p24) ** .5, "probability24h": p24,
            "probability48h": p48, "probability72h": 1 - (1 - p48) ** 1.5}


def logit(value: float) -> float:
    p = clamp(value, 1e-12, 1 - 1e-12)
    return math.log(p / (1 - p))


def sigmoid(value: float) -> float:
    if value >= 0:
        return 1 / (1 + math.exp(-value))
    exponent = math.exp(value)
    return exponent / (1 + exponent)


def fit_logit_intercept(samples: list[tuple[float, bool]], prior_std_dev: float = .5, minimum_samples: int = 10) -> float:
    if len(samples) < minimum_samples or not math.isfinite(prior_std_dev) or prior_std_dev <= 0:
        return 0
    precision, alpha = 1 / prior_std_dev**2, 0.0
    for _ in range(64):
        gradient, information = -alpha * precision, precision
        for p, actual in samples:
            probability = sigmoid(logit(p) + alpha)
            gradient += int(actual) - probability
            information += probability * (1 - probability)
        step = gradient / information
        alpha = clamp(alpha + step, -20, 20)
        if abs(gradient) < 1e-12 or abs(step) < 1e-12:
            break
    return alpha


def calibration_origins(events: list[dict], now: datetime, minimum_intervals: int = 5) -> list[datetime]:
    times = sorted(at for event in events if (at := timestamp(event.get("resetAt"))) and at <= now)
    if len(times) <= minimum_intervals:
        return []
    jst = timezone(timedelta(hours=9))
    first_event = times[minimum_intervals].astimezone(jst)
    first = first_event.replace(hour=0, minute=0, second=0, microsecond=0)
    if first < first_event:
        first += timedelta(days=1)
    last = (now - timedelta(hours=24)).astimezone(jst).replace(hour=0, minute=0, second=0, microsecond=0)
    result = []
    while first <= last:
        result.append(first.astimezone(UTC))
        first += timedelta(days=1)
    return result


def signal_status(signal: dict, now: datetime) -> str:
    resolved, expires, expected = (timestamp(signal.get(key)) for key in ("resolvedAt", "expiresAt", "expectedAt"))
    if resolved and resolved <= now:
        return "resolved"
    status = signal.get("status", "active")
    if status == "expired" or (status != "resolved" and expires and expires <= now):
        return "expired"
    if expected and expected <= now:
        return status if expires and expires > now else "resolved"
    return status


def decay(created: object, now: datetime, hours: float = 48) -> float:
    at = timestamp(created)
    if not at or hours <= 0 or not math.isfinite(hours):
        return 1
    return clamp(1 - max(0, (now - at).total_seconds() / 3600) / hours)


def timing_coverage(signal: dict, now: datetime, horizon_hours: int, teaser: bool = False) -> float | None:
    if signal.get("temporal_resolution_status") != "resolved":
        return None
    start = timestamp(signal.get("expected_start_at"))
    end = timestamp(signal.get("expected_end_at")) or start
    if not start or not end or end < start:
        return None
    confidence = clamp(signal.get("temporal_confidence"))
    if teaser and now > end:
        return confidence * clamp(1 - (now - end).total_seconds() / 10800)
    if signal.get("temporal_precision") == "exact_time":
        distance = (start - now).total_seconds()
        if distance >= 0:
            return float(distance <= horizon_hours * 3600)
        return clamp(1 + distance / 10800)
    remaining_start = max(now, start)
    duration = (end - remaining_start).total_seconds()
    if duration <= 0:
        return 0
    overlap = max(0, (min(now + timedelta(hours=horizon_hours), end) - remaining_start).total_seconds())
    return clamp(overlap / duration * confidence)


def _after_boundary(signal: dict, boundary: datetime | None) -> bool:
    created = timestamp(signal.get("tweet_created_at"))
    start = timestamp(signal.get("expected_start_at"))
    secondary = timestamp(signal.get("primary_event_at"))
    return bool(created and (not boundary or created > boundary or (signal.get("is_secondary_future_signal") and secondary == boundary)
                            or (signal.get("temporal_resolution_status") == "resolved" and start and start > boundary)))


def active_notice(data: dict, now: datetime, boundary: datetime | None = None) -> dict | None:
    candidates = []
    for signal in all_signals(data, now):
        if signal.get("signal_type") != "official_notice" or number(signal.get("confidence")) < .95 or signal.get("verification_status") == "rejected" or signal.get("is_reply") or not _after_boundary(signal, boundary):
            continue
        created = timestamp(signal.get("tweet_created_at"))
        if created is None:
            continue
        expires = timestamp(signal.get("expires_at"))
        if expires and expires > now:
            candidates.append(signal)
    for local in records(data, "observation_signals"):
        observed = timestamp(local.get("observedAt"))
        if local.get("type") != "official_notice" or not observed or observed > now or (boundary and observed <= boundary) or signal_status(local, now) != "active":
            continue
        candidates.append({"signal_type": "official_notice", "confidence": 1, "tweet_created_at": local.get("observedAt"),
                           "text": local.get("title"), "tweet_url": local.get("source"), "expected_start_at": local.get("expectedAt"),
                           "expected_end_at": local.get("expectedEndAt"), "temporal_resolution_status": "unresolved"})
    return max(candidates, key=lambda signal: timestamp(signal.get("tweet_created_at")) or datetime.min.replace(tzinfo=UTC)) if candidates else None


def _local_active(data: dict, now: datetime) -> list[dict]:
    return [signal for signal in records(data, "observation_signals") if (at := timestamp(signal.get("observedAt"))) and at <= now and signal_status(signal, now) == "active"]


def _status_score(data: dict, now: datetime, boundary: datetime | None) -> float:
    environment = data.get("codex_environment") or {}
    score = 0.0
    seen = set()
    if not environment.get("openai_status_incidents_suppressed"):
        for incident in records(data, "openai_status_history", "status_history"):
            if incident.get("source") != "openai_status":
                continue
            created = timestamp(incident.get("createdAt") or incident.get("created_at"))
            updated = timestamp(incident.get("updatedAt") or incident.get("updated_at")) or created
            resolved = timestamp(incident.get("resolvedAt") or incident.get("resolved_at"))
            if incident.get("status") == "resolved" or resolved:
                resolved = resolved or updated
                if not resolved or resolved > now or now - resolved > timedelta(hours=24) or (boundary and resolved <= boundary):
                    continue
            elif updated and updated > now:
                continue
            identity = str(incident.get("id"))
            if identity in seen:
                continue
            seen.add(identity)
            score += {"critical": 3, "major": 2}.get(str(incident.get("impact", "")).lower(), 1)
        score += max(0, number(environment.get("openai_status_affected_codex_components")))
    for signal in _local_active(data, now):
        observed = timestamp(signal.get("observedAt"))
        if signal.get("type") == "status_incident" and observed and now - observed <= timedelta(hours=24) and signal.get("id") not in seen:
            seen.add(str(signal.get("id")))
            score += 1
    return clamp(score / 5)


def signal_multipliers(data: dict, now: datetime, random_boundary: datetime | None, recovery_boundary: datetime | None) -> tuple[float, float]:
    signals = [s for s in all_signals(data, now) if s.get("verification_status") != "rejected" and not s.get("is_reply") and _after_boundary(s, random_boundary)]
    formal = [s for s in signals if s.get("signal_type") == "teaser" and number(s.get("confidence")) >= .8 and not s.get("is_secondary_future_signal")]
    local = _local_active(data, now)
    boosts = [s for s in local if s.get("type") == "probability_boost" or any(s.get(key) is not None for key in ("boostValue", "boostValue24h", "boostValue48h"))]
    teaser_scores = [0.0, 0.0]
    if boosts:
        score = max(max(number(s.get("boostValue24h", s.get("boostValue"))) / .2, number(s.get("boostValue48h", s.get("boostValue"))) / .3)
                    * (decay(s.get("observedAt"), now, number(s.get("boostDecayHours"))) if s.get("boostDecayHours") is not None else 1) for s in boosts)
        teaser_scores = [clamp(score)] * 2
    elif formal:
        teaser_scores = [max(decay(s.get("tweet_created_at"), now) if timing_coverage(s, now, horizon, True) is None else number(timing_coverage(s, now, horizon, True)) for s in formal) for horizon in (24, 48)]
    strength = [1.0, 1.0]
    if formal:
        for s in formal:
            level = s.get("teaser_strength") or s.get("ai_teaser_strength")
            if level not in {"strong", "weak"}:
                continue
            for index, horizon in enumerate((24, 48)):
                coverage = timing_coverage(s, now, horizon, True)
                if coverage is not None:
                    multiplier = {"weak": (1.15, 1.2), "strong": (1.6, 1.6)}[level][index]
                    strength[index] = max(strength[index], 1 + (multiplier - 1) * coverage)
    else:
        for s in signals:
            created = timestamp(s.get("tweet_created_at"))
            if s.get("signal_type") in {"official_notice", "reset_executed"} or not created or now - created > timedelta(hours=48):
                continue
            level = s.get("teaser_strength") or s.get("ai_teaser_strength")
            if level not in {"weak", "strong"}:
                continue
            for index, horizon in enumerate((24, 48)):
                coverage = timing_coverage(s, now, horizon, True)
                progress = decay(created, now) if coverage is None else coverage
                multiplier = {"weak": (1.15, 1.2), "strong": (1.35, 1.5)}[level][index]
                strength[index] = max(strength[index], 1 + (multiplier - 1) * progress)
    env = data.get("codex_environment")
    recent = [s for s in local if (observed := timestamp(s.get("observedAt"))) and now - observed <= timedelta(hours=24)]
    env = env if isinstance(env, dict) else {
        "official_incident_hints_24h": sum(s.get("type") == "official_incident_hint" for s in recent),
        "official_updates_24h": sum(s.get("type") == "official_notice" for s in recent),
        "community_mentions_24h": sum(s.get("type") == "community_report" for s in recent),
        "issue_or_limit_anomalies_24h": sum(s.get("type") == "limit_anomaly" for s in recent),
    }
    hints = max(0, number(env.get("official_incident_hints_24h")))
    updates = clamp(env.get("official_updates_24h"), 0, 2)
    community = max(0, number(env.get("community_mentions_24h")))
    anomalies = max(0, number(env.get("issue_or_limit_anomalies_24h")))
    pressure = 1.1 if community >= 10 or anomalies >= 3 else 1.0
    status = _status_score(data, now, recovery_boundary)
    result = []
    for i in range(2):
        value = (1 + teaser_scores[i] * (.8, 1.2)[i]) * strength[i] * (1 + status * (.5, .7)[i])
        value *= ((2.5, 2.8)[i] if hints >= 2 else (1.75, 1.9)[i] if hints >= 1 else 1)
        value *= (1 + updates * (.2, .25)[i]) * (1 + clamp(community / 80) * (.15, .2)[i])
        value *= (1 + clamp(anomalies / 30) * (.25, .35)[i]) * pressure
        result.append(min((5, 6)[i], value))
    return result[0], result[1]


def project_to_origin(data: dict, origin: datetime) -> dict:
    projected = {key: data[key] for key in ("reset_history", "windows", "observation_signals") if key in data}
    projected["signals"] = all_signals(data, origin)
    projected["regular_reset_events"] = [row for row in records(data, "regular_reset_events") if (at := timestamp(row.get("completed_at"))) and at <= origin and (row.get("status") not in {"voided", "corrected"} or ((corrected := timestamp(row.get("corrected_at"))) and corrected <= origin))]
    estimates = []
    for row in records(data, "reset_execution_estimates"):
        def field(camel: str, snake: str):
            return row.get(camel, row.get(snake))
        required = [timestamp(field("createdAt", "created_at")), timestamp(field("updatedAt", "updated_at") or field("createdAt", "created_at")), timestamp(field("displayExecutionAt", "display_execution_at"))]
        future_fields = (("manualOverrideAt", "manual_override_at"), ("manualExecutionAt", "manual_execution_at"),
                         ("tiboAnnouncedAt", "tibo_announced_at"), ("officialNoticeAt", "official_notice_at"),
                         ("executionWindowStartAt", "execution_window_start_at"), ("executionWindowEndAt", "execution_window_end_at"),
                         ("recoveryPreviousObservedAt", "recovery_previous_observed_at"), ("recoveryObservedAt", "recovery_observed_at"))
        if all(at and at <= origin for at in required) and not any((at := timestamp(field(camel, snake))) and at > origin for camel, snake in future_fields):
            estimates.append(dict(row))
    projected["reset_execution_estimates"] = estimates
    incidents = []
    for incident in records(data, "openai_status_history", "status_history"):
        created = timestamp(incident.get("createdAt"))
        updated = timestamp(incident.get("updatedAt"))
        resolved = timestamp(incident.get("resolvedAt"))
        earliest = min((at for at in (created, updated, resolved) if at), default=None)
        if (created and created > origin) or not earliest or earliest > origin:
            continue
        item = dict(incident)
        if updated and updated > origin:
            item.update(title="OpenAI Status incident", status="investigating", impact=None, updatedAt=iso(created), resolvedAt=None)
        elif resolved and resolved > origin:
            item.update(status="investigating", resolvedAt=None)
        incidents.append(item)
    projected["status_history"] = incidents
    return projected


def calculate_raw(data: dict, now: datetime, half_life_days: float | None = None) -> dict:
    history = canonical_history(data, now)
    events = random_events(history, now)
    latest = timestamp(events[-1]["resetAt"]) if events else None
    hazard = build_hazard(events, now, half_life_days)
    age = max(0, (now - latest).total_seconds() / 3600) if latest else 0
    baseline = [integrate_hazard(hazard, age, h) for h in (24, 48)]
    boundary = schedule_anchor(history, now)
    multipliers = signal_multipliers(data, now, latest, boundary)
    prediction = [apply_odds_multiplier(p, m) for p, m in zip(baseline, multipliers)]
    notice = active_notice(data, now, max((at for at in (latest, boundary) if at), default=None))
    if notice:
        coverage = [timing_coverage(notice, now, h) for h in (24, 48)]
        prediction = [.9, .96] if None in coverage else [clamp(p + number(coverage[i]) * ((.9, .96)[i] - p)) for i, p in enumerate(baseline)]
    return {"modelVersion": RAW_MODEL_VERSION, **horizons(*prediction), "baseline": baseline,
            "hazard": hazard, "officialNoticeOverride": bool(notice), "multipliers": multipliers}


def calculate_probability(data: dict, now: datetime | None = None) -> dict:
    now = timestamp(now) or datetime.now(UTC)
    # Public production calculations use one ten-minute bucket.
    now = now.replace(minute=(now.minute // 10) * 10, second=0, microsecond=0)
    events = random_events(canonical_history(data, now), now)
    raw = calculate_raw(data, now)
    rows: list[dict] = []
    for origin in calibration_origins(events, now):
        past = calculate_raw(project_to_origin(data, origin), origin)
        row = {"origin": origin, "raw": past}
        for horizon in (24, 48):
            row[f"actual{horizon}h"] = any((event_at := timestamp(event["resetAt"])) and origin < event_at <= origin + timedelta(hours=horizon) for event in events)
        rows.append(row)
    predictions, audit = [], {}
    for horizon in (24, 48):
        key = f"probability{horizon}h"
        eligible = [row for row in rows if row["origin"] + timedelta(hours=horizon) <= now]
        samples = [(row["raw"][key], bool(row[f"actual{horizon}h"])) for row in eligible]
        alpha = fit_logit_intercept(samples)
        prediction = raw[key] if alpha == 0 or raw["officialNoticeOverride"] else sigmoid(logit(raw[key]) + alpha)
        predictions.append(prediction)
        audit[f"alpha{horizon}h"] = alpha
        audit[f"calibrationSampleCount{horizon}h"] = len(samples)
        audit[f"positiveCalibrationCount{horizon}h"] = sum(actual for _, actual in samples)
    return {"modelVersion": MODEL_VERSION, "calculatedAt": iso(now), **horizons(*predictions), **audit,
            "rawProbability24h": raw["probability24h"], "rawProbability48h": raw["probability48h"],
            "completedEventCount": len(events), "officialNoticeOverride": raw["officialNoticeOverride"],
            "source": "python-calibrated-baseline", "fallbackUsed": False}
