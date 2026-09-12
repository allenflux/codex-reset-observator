import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from observatory.neural import (
    eligible_events,
    features_at,
    forecast,
    make_samples,
    parse_time,
    split_samples,
)

DATA = Path(__file__).parents[1] / "observatory/data"


def test_online_event_selection_matches_scope_and_exclusions():
    rows = json.loads((DATA / "online_history.json").read_text())
    events, profile = eligible_events(rows, datetime(2026, 9, 12, tzinfo=UTC))
    assert len(events) == len(set(events)) == 35
    assert profile["excluded"] == {"limited_scope": 2, "reference_or_regular": 5, "non_random_cycle": 1}


def test_future_events_cannot_change_features():
    start = datetime(2026, 1, 1, tzinfo=UTC)
    events = [start + timedelta(days=n*3) for n in range(7)]
    origin = start + timedelta(days=11)
    assert features_at(events, origin) == features_at(events[:4], origin)


def test_censoring_horizon_boundaries_and_purged_splits():
    start = datetime(2026, 1, 1, tzinfo=UTC)
    events = [start + timedelta(days=n*3) for n in range(40)]
    until = start + timedelta(days=119, hours=4)
    samples = make_samples(events, until)
    assert all(row["origin"] + timedelta(hours=48) <= until for row in samples)
    train, valid, test = split_samples(samples)
    assert train[-1]["origin"] + timedelta(hours=48) < valid[0]["origin"]
    assert valid[-1]["origin"] + timedelta(hours=48) < test[0]["origin"]
    for row in samples:
        future = [t for t in events if row["origin"] < t <= row["origin"] + timedelta(hours=48)]
        expected = 0 if not future else 1 if future[0] <= row["origin"] + timedelta(hours=24) else 2
        assert row["label"] == expected


def test_saved_model_is_portable_coherent_and_not_used_for_earlier_dates(tmp_path):
    rows = json.loads((DATA / "online_history.json").read_text())
    model = DATA / "neural_model.json"
    output = forecast(rows, datetime(2026, 9, 13, tzinfo=UTC), model)
    assert output and 0 <= output["probability24h"] <= output["probability48h"] <= 1
    assert output["eligibleForUse"] is False
    assert forecast(rows, datetime(2026, 8, 1, tzinfo=UTC), model) is None
    assert forecast(rows, model_path=tmp_path / "missing.json") is None
    corrupt = tmp_path / "corrupt.json"
    corrupt.write_text("[]")
    assert forecast(rows, model_path=corrupt) is None


def test_timezone_and_small_sample_rejection():
    with pytest.raises(ValueError, match="timezone"):
        parse_time("2026-09-01")
    with pytest.raises(ValueError, match="45"):
        split_samples([])


def test_training_temporal_report_and_portable_serialization(tmp_path):
    pytest.importorskip("sklearn")
    from observatory.neural import train_model
    rows = json.loads((DATA / "online_history.json").read_text())
    model_path = tmp_path / "model.json"
    report = train_model(rows, datetime(2026, 9, 12, tzinfo=UTC), model_path)
    assert report["splits"]["test"]["count"] == 21
    assert report["sampleCount"] == 102
    assert report["eligibleForUse"] is False
    assert 0 <= report["neural"]["meanBrier"] <= 1
    assert forecast(rows, datetime(2026, 9, 13, tzinfo=UTC), model_path)


def test_malformed_weight_dimensions_and_zero_scale_fail_closed(tmp_path):
    rows = json.loads((DATA / "online_history.json").read_text())
    model = json.loads((DATA / "neural_model.json").read_text())
    path = tmp_path / "bad-model.json"
    bad_scale = {**model, "scale": [0] * len(model["scale"])}
    path.write_text(json.dumps(bad_scale))
    assert forecast(rows, datetime(2026, 9, 13, tzinfo=UTC), path) is None
    bad_weights = {**model, "weights": [[]]}
    path.write_text(json.dumps(bad_weights))
    assert forecast(rows, datetime(2026, 9, 13, tzinfo=UTC), path) is None


def test_combined_product_reset_is_eligible_without_accepting_partial_banked_distribution():
    base = {"id": "tibo-reset-2098685367058612394", "recordKind": "confirmed_global",
            "completed_at": "2026-09-12T08:00:00Z", "scope": "Codex / ChatGPT Work",
            "details": {"cycleType": "ランダムリセット"}, "randomResetTargetScope": "broad"}
    partial = {**base, "id": "banked-reset-2097752790177370535",
               "recordKind": "banked_distribution", "completed_at": "2026-09-09T18:23:34Z",
               "scope": "部分用户", "randomResetTargetScope": "conditional"}
    events, profile = eligible_events([base, partial], datetime(2026, 9, 12, 12, tzinfo=UTC))
    assert events == [parse_time(base["completed_at"])]
    assert profile["eligibleEventIds"] == [base["id"]]
    assert profile["excluded"] == {"limited_scope": 1}


@pytest.mark.parametrize("scope", ["部分用户", "个人用户", "Codex / ChatGPT Work (部分用户)",
                                  "Some Codex / ChatGPT Work users", "unknown", ""])
def test_neural_scope_requires_exact_recognized_broad_description(scope):
    row = {"id": "scope-check", "recordKind": "confirmed_global",
           "completed_at": "2026-09-12T08:00:00Z", "scope": scope,
           "details": {"cycleType": "ランダムリセット"}, "randomResetTargetScope": "broad"}
    events, profile = eligible_events([row], datetime(2026, 9, 12, 12, tzinfo=UTC))
    assert events == []
    assert profile["excluded"] == {"limited_or_unknown_scope": 1}


def test_explicit_conditional_combined_product_scope_is_excluded_from_neural_events():
    row = {"id": "conditional", "recordKind": "confirmed_global",
           "completed_at": "2026-09-12T08:00:00Z", "scope": "Codex / ChatGPT Work",
           "details": {"cycleType": "ランダムリセット"}, "randomResetTargetScope": "conditional"}
    events, profile = eligible_events([row], datetime(2026, 9, 12, 12, tzinfo=UTC))
    assert events == []
    assert profile["excluded"] == {"limited_scope": 1}
