import json
from copy import deepcopy
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from observatory import teacher

NOW = datetime(2026, 9, 24, 1, tzinfo=UTC)


def payload():
    return {
        "schemaVersion": "public-v1", "checkedAt": NOW.isoformat(),
        "updatedAt": (NOW - timedelta(minutes=5)).isoformat(),
        "lastRandomResetAt": (NOW - timedelta(days=2)).isoformat(),
        "dataHealth": {"stale": False}, "resetTeaserStatus": "none",
        "viewModel": {
            "probability12h": 0.1, "probability24h": 0.3,
            "probability48h": 0.5, "probability72h": 0.7,
            "codexOperationalStatus": "none", "expectation": "Very high",
            "displayReasoningSummary": "private-unused-reasoning",
            "activeWindow": {"active": False, "openedAt": NOW.isoformat(),
                             "expectedAt": None, "expectedEndAt": None},
        },
        "latestTiboActivity": {
            "createdAt": (NOW - timedelta(hours=1)).isoformat(), "classification": "irrelevant",
            "teaserStrength": None, "text": "private-unused-text", "isReply": False,
        },
    }


def fetch(value=None, **kwargs):
    value = payload() if value is None else value
    with httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, content=json.dumps(value))
    )) as client:
        return teacher.fetch_teacher_forecast(now=NOW, client=client, **kwargs)


def test_public_forecast_keeps_attribution_and_structured_fields_only():
    record = fetch()
    assert record["modelVersion"] == teacher.MODEL_VERSION
    assert record["source"] == teacher.SOURCE
    assert record["sourceUrl"] == teacher.SOURCE_URL
    assert record["probability24h"] == 0.3
    assert record["probability48h"] == 0.5
    assert record["fetchedAt"] == record["checkedAt"] == NOW.isoformat()
    assert record["context"]["latestPostClassification"] == "irrelevant"
    assert record["context"]["latestPostTeaserStrength"] == "unknown"
    assert record["context"]["noticeStartsAt"] is None
    assert record["context"]["isQuote"] is None
    assert "private-unused" not in json.dumps(record)
    assert "expectation" not in record
    assert teacher.teacher_status(record, NOW)["fresh"] is True


@pytest.mark.parametrize("value", [-1, 1.01, float("nan"), float("inf"), True, "0.3", None])
def test_invalid_required_probability_is_rejected(value):
    source = payload()
    source["viewModel"]["probability24h"] = value
    with pytest.raises(teacher.TeacherSourceError, match="invalid_forecast"):
        fetch(source)


@pytest.mark.parametrize("change", [
    {"probability48h": 0.2}, {"probability12h": 0.4}, {"probability72h": 0.4},
])
def test_forecast_horizons_must_be_monotonic(change):
    source = payload()
    source["viewModel"].update(change)
    with pytest.raises(teacher.TeacherSourceError, match="invalid_forecast"):
        fetch(source)


def test_missing_optional_context_and_horizons_remain_unknown():
    source = {"checkedAt": NOW.isoformat(), "dataHealth": {"stale": False},
              "viewModel": {"probability24h": 0.2, "probability48h": 0.4}}
    record = fetch(source)
    assert record["probability12h"] is record["probability72h"] is None
    assert record["context"]["latestPostClassification"] == "unknown"
    assert record["context"]["officialNoticeActive"] is None
    assert record["lastRandomResetAt"] is None


@pytest.mark.parametrize("value", ["2026-09-24T01:00:00", "not-a-time", 123, "x" * 100])
def test_invalid_source_timestamp_is_rejected(value):
    source = payload()
    source["checkedAt"] = value
    with pytest.raises(teacher.TeacherSourceError, match="invalid_forecast"):
        fetch(source)


@pytest.mark.parametrize("value", [
    "0001-01-01T00:00:00+23:00", "9999-12-31T23:59:59-23:00",
    "9999-12-31T23:59:59+00:00",
])
def test_extreme_source_timestamps_return_only_safe_error_codes(value):
    source = payload()
    source.update(checkedAt=value, updatedAt=value)
    with pytest.raises(teacher.TeacherSourceError) as error:
        fetch(source)
    assert str(error.value) == "teacher_source_invalid_forecast"


def test_extreme_public_record_validation_cannot_overflow_date_arithmetic():
    record = fetch()
    record.update(checkedAt="9999-12-31T23:59:59+00:00", updatedAt="9999-12-31T23:59:59+00:00")
    assert teacher.teacher_status(record, NOW)["reason"] == "future_timestamp"
    record["checkedAt"] = "0001-01-01T00:00:00+23:00"
    with pytest.raises(teacher.TeacherSourceError, match="teacher_source_invalid_forecast"):
        teacher.validate_teacher_forecast(record)


def test_extreme_integer_probability_is_rejected_without_float_conversion_overflow():
    source = payload()
    source["viewModel"]["probability24h"] = 10 ** 1000
    with pytest.raises(teacher.TeacherSourceError, match="teacher_source_invalid_forecast"):
        fetch(source)


def test_upstream_computation_age_cannot_be_refreshed_by_a_new_fetch():
    record = fetch()
    record["fetchedAt"] = (NOW + timedelta(hours=2)).isoformat()
    state = teacher.teacher_status(record, NOW + timedelta(hours=2))
    assert state["reason"] == "expired"
    assert state["ageSeconds"] == 0
    assert state["sourceAgeSeconds"] == 7200
    assert state["forecast"] is None


def test_last_success_expires_even_if_source_clock_is_recent():
    record = fetch()
    record["checkedAt"] = (NOW + timedelta(hours=2)).isoformat()
    assert teacher.teacher_status(record, NOW + timedelta(hours=2))["reason"] == "expired"
    assert teacher.teacher_status(fetch(), NOW + timedelta(minutes=30))["fresh"] is True
    assert teacher.teacher_status(fetch(), NOW + timedelta(minutes=30, seconds=1))["fresh"] is False


def test_small_clock_skew_is_tolerated_but_future_values_are_rejected():
    source = payload()
    source["checkedAt"] = (NOW + timedelta(seconds=60)).isoformat()
    assert teacher.teacher_status(fetch(source), NOW)["fresh"] is True
    source["checkedAt"] = (NOW + timedelta(seconds=61)).isoformat()
    with pytest.raises(teacher.TeacherSourceError, match="invalid_forecast"):
        fetch(source)
    record = fetch()
    record["fetchedAt"] = (NOW + timedelta(seconds=61)).isoformat()
    assert teacher.teacher_status(record, NOW)["reason"] == "future_timestamp"


def test_source_staleness_is_preserved_and_health_missing_never_means_fresh():
    source = payload()
    source["dataHealth"]["stale"] = True
    assert teacher.teacher_status(fetch(source), NOW)["reason"] == "upstream_stale"
    del source["dataHealth"]
    assert teacher.teacher_status(fetch(source), NOW)["fresh"] is False


def test_invalid_cache_identity_and_untrusted_context_fail_closed():
    original = fetch()
    for field, value in (("source", "other"), ("schemaVersion", 2),
                         ("modelVersion", "mine"), ("sourceStale", "false")):
        assert teacher.teacher_status({**original, field: value}, NOW)["reason"] == "invalid"
    record = deepcopy(original)
    record["context"]["latestPostClassification"] = "<script>unsafe</script>"
    assert teacher.teacher_status(record, NOW)["reason"] == "invalid"
    assert teacher.teacher_status(None, NOW)["reason"] == "missing"


def test_observed_context_cannot_come_from_after_upstream_computation():
    source = payload()
    source["latestTiboActivity"]["createdAt"] = (NOW + timedelta(hours=1)).isoformat()
    with pytest.raises(teacher.TeacherSourceError, match="invalid_forecast"):
        fetch(source)


def test_future_official_window_is_valid_and_distinct_from_notice_publication():
    source = payload()
    expected = (NOW + timedelta(hours=3)).isoformat()
    source["viewModel"]["activeWindow"].update(active=True, kind="official", expectedAt=expected)
    record = fetch(source)
    assert record["context"]["noticeStartsAt"] == expected
    assert record["context"]["officialNoticeActive"] is True


@pytest.mark.parametrize("kind", ["regular", "none", None])
def test_regular_or_unknown_window_is_not_an_official_notice(kind):
    source = payload()
    source["viewModel"]["activeWindow"].update(active=True, kind=kind)
    assert fetch(source)["context"]["officialNoticeActive"] is False


def test_fetch_uses_fixed_endpoint_and_does_not_follow_redirects():
    calls = []

    def transport(request):
        calls.append(request)
        return httpx.Response(302, headers={"Location": "https://example.com/private"})

    with httpx.Client(transport=httpx.MockTransport(transport), follow_redirects=True) as client:
        with pytest.raises(teacher.TeacherSourceError, match="unavailable"):
            teacher.fetch_teacher_forecast(now=NOW, client=client)
        assert not client.is_closed
    assert len(calls) == 1
    assert str(calls[0].url) == teacher.API_URL
    assert calls[0].extensions["timeout"]["read"] == 20


def test_oversized_body_and_invalid_json_are_sanitized(monkeypatch):
    monkeypatch.setattr(teacher, "MAX_RESPONSE_BYTES", 32)
    with pytest.raises(teacher.TeacherSourceError, match="response_too_large"):
        fetch()
    with httpx.Client(transport=httpx.MockTransport(
        lambda _: httpx.Response(200, text="private-invalid-response")
    )) as client:
        with pytest.raises(teacher.TeacherSourceError) as error:
            teacher.fetch_teacher_forecast(now=NOW, client=client)
    assert str(error.value) == "teacher_source_invalid_response"


def test_network_errors_do_not_leak_exception_details():
    def transport(request):
        raise httpx.ConnectError("private-token", request=request)

    with httpx.Client(transport=httpx.MockTransport(transport)) as client:
        with pytest.raises(teacher.TeacherSourceError) as error:
            teacher.fetch_teacher_forecast(now=NOW, client=client)
    assert str(error.value) == "teacher_source_unavailable"
