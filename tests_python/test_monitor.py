from datetime import UTC, datetime

from observatory.monitor import parse_rate_limits


def test_monitor_selects_weekly_codex_window_and_discards_private_fields():
    window = {"usedPercent": 42, "windowDurationMins": 10080, "resetsAt": 1800000000}
    payload = {"result": {"email": "private", "token": "do-not-export", "rateLimitsByLimitId": {
        "other": {"primary": window},
        "codex": {"planType": "pro", "primary": {**window, "windowDurationMins": 300}, "secondary": window},
    }, "rateLimitResetCredits": {"availableCount": 3}}}
    parsed = parse_rate_limits(payload, datetime(2026, 9, 12, tzinfo=UTC))
    assert parsed == {"observedAt": "2026-09-12T00:00:00+00:00", "limitId": "codex", "planType": "pro",
                      "usedPercent": 42, "windowDurationMins": 10080, "resetsAt": 1800000000,
                      "bankedResetAvailableCount": 3}


def test_monitor_rejects_ambiguous_and_nonfinite_windows():
    window = {"usedPercent": 42, "windowDurationMins": 10080, "resetsAt": 1800000000}
    assert parse_rate_limits({"rateLimits": {"primary": window, "secondary": window}}) is None
    assert parse_rate_limits({"rateLimits": {"primary": {**window, "usedPercent": float("nan")}}}) is None
    assert parse_rate_limits([]) is None


def test_monitor_normalizes_unexpected_plan_metadata():
    window = {"usedPercent": 42, "windowDurationMins": 10080, "resetsAt": 1800000000}
    for plan in (None, {"private": "value"}, "x" * 100):
        payload = {"rateLimits": {"primary": window, "planType": plan}}
        parsed = parse_rate_limits(payload)
        assert parsed["planType"] == "unknown"


def test_monitor_missing_executable_reports_sanitized_failure(monkeypatch):
    import pytest

    from observatory.monitor import run_monitor

    monkeypatch.setenv("CODEX_CLI_PATH", "/does-not-exist-codex")
    monkeypatch.setenv("CODEX_USAGE_MONITOR_SECRET", "private-secret")
    with pytest.raises(ValueError, match="^monitor_failed$"):
        run_monitor(once=True)
