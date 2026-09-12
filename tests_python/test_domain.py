from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from observatory.domain import build_snapshot, classify_post, load_data, safe_url
from observatory.domain_utils import iso
from observatory.history import canonical_history, next_regular_reset, random_events
from observatory.probability import (
    active_notice,
    build_hazard,
    calculate_probability,
    calculate_raw,
    fit_logit_intercept,
    integrate_hazard,
    project_to_origin,
    timing_coverage,
)

NOW = datetime(2026, 9, 12, tzinfo=UTC)
ROOT = Path(__file__).resolve().parents[1]


def event(identifier="reset", at=NOW - timedelta(days=2), **extra):
    row = {"id": identifier, "recordKind": "confirmed_global", "kind": "reset_completed", "status": "closed",
           "opened_at": iso(at), "completed_at": iso(at), "closed_at": iso(at), "scope": "全有料プラン",
           "details": {"cycleType": "ランダムリセット", "resetMethod": "強制リセット", "scope": "全有料プラン"}}
    row.update(extra)
    return row


def test_neural_is_primary_and_baseline_remains_separate(monkeypatch):
    from observatory import neural

    monkeypatch.setattr(neural, "forecast", lambda history, now: {
        "modelVersion": "test-neural", "probability24h": .2, "probability48h": .4})
    data = {"reset_history": [event()]}
    view = build_snapshot(data, "zh", NOW)["viewModel"]
    assert (view["probability24h"], view["probability48h"]) == (.2, .4)
    assert view["probability12h"] is None and view["probability72h"] is None
    assert view["statisticalBaseline"]["probability24h"] == calculate_probability(data, NOW)["probability24h"]
    assert view["primaryForecast"] == {"kind": "neural", "modelVersion": "test-neural", "experimental": True,
                                       "includesAnnouncement": False}


def test_unavailable_neural_model_falls_back_to_statistical_forecast(monkeypatch):
    from observatory import neural

    monkeypatch.setattr(neural, "forecast", lambda history, now: None)
    view = build_snapshot({"reset_history": [event()]}, "zh", NOW)["viewModel"]
    assert view["primaryForecast"]["kind"] == "statistical_fallback"
    assert view["primaryForecast"]["experimental"] is False
    for key, value in view["statisticalBaseline"].items():
        assert view[key] == value


def test_mirrored_post_does_not_create_a_reset_or_change_neural_forecast():
    data = load_data()
    before = build_snapshot(data, "zh", NOW + timedelta(days=1))
    text = "We reset Codex limits for everyone!"
    post = {**classify_post(text), "tweet_id": "123456789", "text": text,
            "tweet_url": "https://x.com/thsottiaux/status/123456789",
            "tweet_created_at": iso(NOW), "source_kind": "upstream_public_snapshot",
            "formal_adoption_allowed": False, "verification_status": "auto_unverified"}
    data["tibo_signals"] = [post]
    after = build_snapshot(data, "zh", NOW + timedelta(days=1))
    assert after["lastRandomResetAt"] == before["lastRandomResetAt"]
    assert after["viewModel"]["neuralForecast"] == before["viewModel"]["neuralForecast"]
    assert after["latestTiboActivity"]["semanticAnalysisPerformed"] is False
    assert after["latestTiboActivity"]["classification"] == "unknown"


def explicit_signal(at=NOW, **changes):
    text = "We fixed previous model quality problems. And of course, a reset is also landing by midnight today."
    return {"tweet_id": "2098612714704891959", "text": text, **classify_post(text),
            "tweet_url": "https://x.com/thsottiaux/status/2098612714704891959",
            "tweet_created_at": iso(at), "detected_at": iso(at), "expires_at": iso(at + timedelta(hours=72)),
            "formal_adoption_allowed": False, "source_kind": "upstream_public_snapshot", **changes}


def test_explicit_notice_takes_display_priority_without_faking_neural_or_execution():
    data = load_data()
    now = NOW + timedelta(hours=12)
    before = build_snapshot(data, "zh", now)
    data["tibo_signals"] = [explicit_signal()]
    after = build_snapshot(data, "zh", now)
    view = after["viewModel"]
    assert view["displayPriority"] == "official_notice"
    notice = view["activeWindow"]
    assert notice["kind"] == "official" and notice["executionConfirmed"] is False
    assert notice["timingText"] == "by midnight today" and notice["timingUnresolved"] is True
    assert notice["expectedAt"] is None and notice["expectedTimeZone"] is None
    assert view["neuralForecast"] == before["viewModel"]["neuralForecast"]
    assert view["probability24h"] == before["viewModel"]["probability24h"]
    assert view["primaryForecast"]["includesAnnouncement"] is False
    assert after["lastRandomResetAt"] == before["lastRandomResetAt"]
    assert view["recentHistory"] == before["viewModel"]["recentHistory"]
    assert after["latestTiboActivity"]["classificationSource"] == "explicit_text_rule"


def test_relative_notice_does_not_survive_by_repeated_polling_and_closes_after_completion():
    notice = explicit_signal()
    assert active_notice({"signals": [notice]}, NOW + timedelta(hours=23))
    assert active_notice({"signals": [notice]}, NOW + timedelta(hours=24)) is None
    assert active_notice({"signals": [notice]}, NOW + timedelta(hours=1), NOW + timedelta(minutes=30)) is None
    assert active_notice({"signals": [{**notice, "is_quote": True}]}, NOW + timedelta(hours=1)) is None


def test_later_withdrawal_closes_notice_until_a_new_explicit_announcement():
    notice = explicit_signal()
    cancelled = explicit_signal(NOW + timedelta(hours=1), tweet_id="cancel", text="The reset is cancelled.",
                                signal_type="irrelevant")
    assert active_notice({"signals": [notice, cancelled]}, NOW + timedelta(hours=2)) is None
    renewed = explicit_signal(NOW + timedelta(hours=3), tweet_id="new-announcement")
    assert active_notice({"signals": [notice, cancelled, renewed]}, NOW + timedelta(hours=4)) == renewed
    assert active_notice({"signals": [notice, {**cancelled, "is_quote": True}]}, NOW + timedelta(hours=2)) == notice


def test_current_calibrated_and_recency_math_matches_typescript_golden():
    history = json.loads((ROOT / "observatory/data/reset_history.json").read_text())
    golden = json.loads((Path(__file__).parent / "fixtures/domain_golden.json").read_text())
    for reference in golden:
        now = datetime.fromisoformat(reference["at"].replace("Z", "+00:00"))
        data = {"reset_history": history, "observation_signals": []}
        result = calculate_probability(data, now)
        for key, expected in reference["calibrated"].items():
            assert result[key] == pytest.approx(expected, abs=1e-12), key
        recency = calculate_raw(data, now, half_life_days=30)
        for key, expected in reference["recency"].items():
            assert recency[key] == pytest.approx(expected, abs=1e-12), key
        for actual_bin, expected_bin in zip(recency["hazard"]["bins"], reference["hazard"]["bins"], strict=True):
            assert actual_bin["posteriorLambdaPerHour"] == pytest.approx(expected_bin["posteriorLambdaPerHour"], abs=1e-12)
            assert actual_bin["exposureHours"] == pytest.approx(expected_bin["exposureHours"], abs=1e-10)


def test_random_targets_exclude_pending_conditional_personal_regular_and_future():
    broad_credit = event("banked", recordKind="banked_distribution", details={"cycleType": "ランダムリセット", "resetMethod": "任意リセット権配布"})
    data = {"reset_history": [event(), broad_credit, event("pending", status="pending"),
                              event("conditional", randomResetTargetScope="conditional"),
                              event("narrow", scope="specific users"), event("regular", recordKind="regular_completed"),
                              event("future", at=NOW + timedelta(hours=1)), event("reference", recordKind="reference"),
                              event("opened", completed_at=None, closed_at=None)]}
    assert {row["id"] for row in random_events(canonical_history(data, NOW), NOW)} == {"reset", "banked"}


def test_probability_deduplicates_a_social_post_without_merging_distinct_posts():
    data = {"reset_history": [event("one", source_url="https://x.com/name/status/123"), event("duplicate", source_url="https://x.com/name/status/123"), event("two", source_url="https://x.com/name/status/124")]}
    assert len(random_events(canonical_history(data, NOW), NOW)) == 2


def test_weekly_anchor_uses_recovery_and_does_not_move_on_banked_distribution():
    forced = event(at=NOW - timedelta(days=3))
    credit = event("credit", at=NOW - timedelta(days=1), recordKind="banked_distribution", details={"cycleType": "ランダムリセット", "resetMethod": "任意リセット権配布"})
    next_at, anchor = next_regular_reset([forced, credit], NOW)
    assert anchor == NOW - timedelta(days=3)
    assert next_at == NOW + timedelta(days=4)
    assert next_regular_reset([credit], NOW) == (None, None)


def test_sparse_history_has_finite_coherent_predictions_and_censoring():
    hazard = build_hazard([{"id": "a", "resetAt": iso(NOW - timedelta(days=20))}], NOW)
    assert hazard["completedIntervalCount"] == 0
    assert hazard["totalExposureHours"] == 480
    ps = [integrate_hazard(hazard, 480, h) for h in (12, 24, 48, 72)]
    assert 0 <= ps[0] <= ps[1] <= ps[2] <= ps[3] <= 1
    assert fit_logit_intercept([(.9, False)] * 9) == 0
    assert fit_logit_intercept([(.9, False)] * 10) < 0


def test_historical_projection_does_not_import_future_status_or_signals():
    data = {"signals": [{"tweet_id": "1", "tweet_created_at": iso(NOW - timedelta(hours=2)), "detected_at": iso(NOW + timedelta(hours=1))}],
            "codex_environment": {"official_updates_24h": 999},
            "status_history": [{"id": "incident", "createdAt": iso(NOW - timedelta(hours=3)), "updatedAt": iso(NOW + timedelta(hours=1)), "resolvedAt": iso(NOW + timedelta(hours=1)), "title": "Future cause", "impact": "critical", "status": "resolved"}]}
    projected = project_to_origin(data, NOW)
    assert projected["signals"] == []
    assert "codex_environment" not in projected
    assert projected["status_history"][0]["status"] == "investigating"
    assert projected["status_history"][0]["title"] == "OpenAI Status incident"
    assert projected["status_history"][0]["impact"] is None


@pytest.mark.parametrize(("text", "expected"), [
    ("We will reset usage limits tomorrow", "official_notice"),
    ("I've reset usage limits for all paid users", "reset_executed"),
    ("I am resetting usage limits for everyone", "reset_executed"),
    ("I will reset the server tonight", "irrelevant"),
    ("No reset tonight", "irrelevant"),
    ("Imagine if we reset everyone's limits", "irrelevant"),
    ("We already reset everyone yesterday", "irrelevant"),
    ("Time to press the reset button soon", "teaser"),
    ("The context window feature is now live", "irrelevant"),
    ("Banked resets have been distributed. Reset done!", "irrelevant"),
])
def test_classifier_safety_boundaries(text, expected):
    result = classify_post(text)
    assert result["signal_type"] == expected
    if expected != "teaser":
        assert result["teaser_strength"] == "none"


def test_timed_notice_only_boosts_overlapping_horizon():
    notice = {"signal_type": "official_notice", "tweet_id": "a", "tweet_created_at": iso(NOW), "confidence": .96, "expires_at": iso(NOW + timedelta(hours=40)),
              "temporal_resolution_status": "resolved", "temporal_precision": "exact_time",
              "expected_start_at": iso(NOW + timedelta(hours=36)), "expected_end_at": iso(NOW + timedelta(hours=36))}
    assert timing_coverage(notice, NOW, 24) == 0
    assert timing_coverage(notice, NOW, 48) == 1
    assert active_notice({"signals": [notice]}, NOW) == notice
    assert active_notice({"signals": [{**notice, "verification_status": "rejected"}]}, NOW) is None
    assert active_notice({"signals": [{**notice, "is_reply": True}]}, NOW) is None


def test_public_projection_hides_private_fields_rejects_unsafe_links_and_hides_stale_recovery():
    observation = {"id": "recovery", "observedAt": iso(NOW - timedelta(minutes=10)), "status": "observed", "confidence": "strong", "cycleHint": "unexpected", "planType": "private", "previousUsedPercent": 90}
    data = {"reset_history": [event(source_url="javascript:alert(1)")], "api_key": "do-not-serialize", "recovery_observations": [observation]}
    snapshot = build_snapshot(data, "zh", NOW)
    serialized = json.dumps(snapshot)
    assert snapshot["schemaVersion"] == "public-v1"
    assert snapshot["viewModel"]["recentHistory"][0]["source"] is None
    assert snapshot["recoveryObservation"]["status"] == "observed_unconfirmed"
    for private in ("api_key", "do-not-serialize", "planType", "previousUsedPercent", "classification_reason"):
        assert private not in serialized
    data["recovery_observations"][0]["observedAt"] = iso(NOW - timedelta(hours=2))
    assert build_snapshot(data, "en", NOW)["recoveryObservation"] is None
    assert safe_url("https://example.com/path") == "https://example.com/path"
    assert safe_url("https://user:password@example.com") is None
    assert safe_url("//example.com/path") is None


def test_snake_case_monitor_estimate_requires_complete_high_confidence_evidence():
    estimate = {"reset_event_key": "usage-observation:1", "display_execution_at": iso(NOW - timedelta(minutes=1)),
                "execution_window_start_at": iso(NOW - timedelta(minutes=2)), "execution_window_end_at": iso(NOW - timedelta(minutes=1)),
                "recovery_observation_id": "1", "execution_time_source": "usage_observation", "execution_time_confidence": "high",
                "execution_time_precision": "approximate", "estimator_version": "usage-execution-monitor-v1"}
    history = canonical_history({"reset_execution_estimates": [estimate]}, NOW)
    assert len(history) == 1
    assert history[0]["executionTimePrecision"] == "approximate"
    for key, value in (("execution_time_confidence", "low"), ("execution_window_start_at", None), ("estimator_version", "unknown")):
        assert canonical_history({"reset_execution_estimates": [{**estimate, key: value}]}, NOW) == []


def test_online_import_wins_same_id_and_preserves_local_translations():
    data = load_data()
    online = json.loads((ROOT / "observatory/data/online_history.json").read_text())
    indexed = {row["id"]: row for row in data["reset_history"]}
    assert len(indexed) == len(online)
    for row in online:
        assert indexed[row["id"]]["completed_at"] == row["completed_at"]
    assert isinstance(indexed["local-codex-rolling-notice-reset-2026-09-08"]["title"], dict)


def test_existing_manual_display_names_win_without_generating_new_names():
    data = {"reset_history": [event()], "reset_display_names": [{"event_key": "reset", "manual_name_zh": "手动命名", "ai_name_zh": "已有模型命名", "ai_status": "accepted"}]}
    snapshot = build_snapshot(data, "zh", NOW)
    assert snapshot["viewModel"]["recentHistory"][0]["title"] == "手动命名"


def test_live_health_maps_heartbeat_and_status_feed_without_exposing_details():
    snapshot = build_snapshot({"health": {"status": "healthy", "heartbeatAgeSeconds": 15}, "source_status": "local", "status_feed_available": True}, "en", NOW)
    assert snapshot["dataHealth"]["overall"] == "ok"
    assert snapshot["dataHealth"]["stale"] is False
    assert snapshot["dataHealth"]["sources"]["supabaseSignals"] == {"state": "ok"}


def test_authoritative_online_banked_grants_keep_distinct_canonical_ids():
    from observatory.neural import eligible_events

    history = canonical_history(load_data(), NOW)
    heatmap_events = random_events(history, NOW)
    neural_events, _ = eligible_events(history, NOW)
    assert len(heatmap_events) == len(neural_events) == 35
    grants = [row for row in heatmap_events if row["id"].startswith("banked-reset-2095651088502591861")]
    assert len(grants) == 2
    assert len({row["resetAt"] for row in grants}) == 2


@pytest.mark.parametrize("available", [None, False])
def test_stale_fallback_incidents_do_not_claim_live_operational_status(available):
    data = {"status_history": [{"id": "old", "createdAt": "2026-06-01T00:00:00Z", "resolvedAt": "2026-06-02T00:00:00Z", "status": "resolved"}]}
    if available is not None:
        data["status_feed_available"] = available
    assert build_snapshot(data, "en", NOW)["viewModel"]["codexOperationalStatus"] == "unknown"
    data["status_feed_available"] = True
    assert build_snapshot(data, "en", NOW)["viewModel"]["codexOperationalStatus"] == "none"


def test_display_details_localization_does_not_change_model_eligibility():
    source = event(localizedDetails={"en": {"scope": "All paid plans", "resetMethod": "Automatic reset", "noticeType": "Official notice", "private_field": "hidden"}})
    snapshot = build_snapshot({"reset_history": [source]}, "en", NOW)
    item = snapshot["viewModel"]["recentHistory"][0]
    assert item["scope"] == "All paid plans"
    assert item["details"]["resetMethod"] == "Automatic reset"
    assert item["details"]["noticeType"] == "Official notice"
    assert "private_field" not in item["details"]
    assert len(random_events(canonical_history({"reset_history": [source]}, NOW), NOW)) == 1
