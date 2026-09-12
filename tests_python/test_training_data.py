from datetime import UTC, datetime, timedelta

import pytest

from observatory.collection_store import CollectionStore
from observatory.neural import eligible_events, features_at, parse_time
from observatory.training_data import (
    build_training_dataset,
    get_training_history,
    score_archived_forecasts,
)

ORIGIN = datetime(2026, 1, 20, tzinfo=UTC)


def event(key, at):
    return {"id": key, "completed_at": at.isoformat(), "recordKind": "confirmed_global",
            "details": {"cycleType": "Random reset", "scope": "All users"}}


def past_events():
    return [event(f"past-{day}", ORIGIN - timedelta(days=day)) for day in [15, 12, 9, 6]]


def archive(store, run_id, timestamp=ORIGIN):
    return store.record_prediction(timestamp=timestamp, probability24h=.25, probability48h=.4,
                                   model_version="test-model", features={"knownAt": timestamp.isoformat()},
                                   source_run_id=run_id)


def collect(store, hour, rows):
    return store.record_success(rows, fetched_at=ORIGIN + timedelta(hours=hour),
                                source_metadata={"completeHistory": True})


def test_training_history_uses_successful_fetch_cutoff_and_retrospective_provenance():
    with CollectionStore() as store:
        rows = past_events()
        collect(store, 0, rows)
        corrected = [{**rows[0], "title": "Source correction"}, *rows[1:]]
        latest = collect(store, 3, corrected)
        store.record_failure(fetched_at=ORIGIN + timedelta(hours=6), error_code="source_unavailable")
        history, until, provenance = get_training_history(store)
        assert history == corrected
        assert until == ORIGIN + timedelta(hours=3)
        assert provenance["sourceRunId"] == latest
        assert provenance["mode"] == "retrospective_latest_collected_history"
        assert provenance["initialBackfillRecords"] == 4
        assert all(parse_time(at) == ORIGIN for at in provenance["eventFirstSeenAt"].values())


def test_prospective_features_do_not_use_late_discoveries_or_source_corrections():
    with CollectionStore() as store:
        initial = past_events()
        for hour in range(73):
            rows = initial if hour < 36 else [
                {**initial[0], "completed_at": (ORIGIN - timedelta(days=2)).isoformat()},
                *initial[1:], event("late-backfill", ORIGIN - timedelta(days=1)),
            ]
            collect(store, hour, rows)
        dataset = build_training_dataset(store, now=ORIGIN + timedelta(hours=72))
        first = dataset["samples"][0]
        assert parse_time(first["origin"]) == ORIGIN
        expected, _ = eligible_events(initial, ORIGIN)
        assert first["features"] == features_at(expected, ORIGIN)
        assert first["knownEventCount"] == 4
        assert first["sourceRevisionWarning"] is True
        assert all(parse_time(row["origin"]) >= ORIGIN for row in dataset["samples"])
        assert dataset["initialBackfillRecords"] == 4
        assert dataset["sampleCount"] == 2


@pytest.mark.parametrize(("event_hour", "label"), [(0, 0), (24, 1), (48, 2), (49, 0)])
def test_forecast_targets_respect_open_origin_and_closed_horizon(event_hour, label):
    with CollectionStore() as store:
        for hour in range(50):
            rows = past_events()
            if hour >= event_hour:
                rows.append(event("new", ORIGIN + timedelta(hours=event_hour)))
            run_id = collect(store, hour, rows)
            if hour == 0:
                archive(store, run_id)
        forecast = score_archived_forecasts(store, now=ORIGIN + timedelta(hours=49))[0]
        assert forecast["status"] == "scored"
        assert forecast["label"] == label
        assert forecast["target24h"] == int(label == 1)
        assert forecast["target48h"] == int(label != 0)
        assert forecast["brier24h"] == (.25 - int(label == 1)) ** 2
        assert parse_time(forecast["outcomeObservedAt"]) == ORIGIN + timedelta(hours=48)


def test_forecast_waits_for_full_48_hour_followup():
    with CollectionStore() as store:
        for hour in range(49):
            run_id = collect(store, hour, past_events())
            if hour == 0:
                archive(store, run_id)
        pending = score_archived_forecasts(store, now=ORIGIN + timedelta(hours=47))[0]
        assert pending["status"] == "pending"
        assert pending["label"] is None
        assert "brier48h" not in pending
        ready = score_archived_forecasts(store, now=ORIGIN + timedelta(hours=48))[0]
        assert ready["status"] == "scored"


def test_missing_poll_coverage_is_unknown_instead_of_a_negative_label():
    with CollectionStore() as store:
        for hour in range(49):
            if 12 <= hour <= 16:
                store.record_failure(fetched_at=ORIGIN + timedelta(hours=hour), error_code="network_error")
                continue
            run_id = collect(store, hour, past_events())
            if hour == 0:
                archive(store, run_id)
        outcome = score_archived_forecasts(store, now=ORIGIN + timedelta(hours=48))[0]
        assert outcome["status"] == "unknown"
        assert outcome["reason"] == "collection_gap"
        assert outcome["label"] is None
        assert "brier24h" not in outcome
        dataset = build_training_dataset(store, now=ORIGIN + timedelta(hours=48))
        assert dataset["samples"] == []
        assert dataset["censored"][0]["reason"] == "collection_gap"


@pytest.mark.parametrize("late_change", ["deletion", "addition"])
def test_late_source_changes_warn_without_rewriting_issued_forecast_outcomes(late_change):
    with CollectionStore() as store:
        reset = event("new-reset", ORIGIN + timedelta(hours=12))
        for hour in range(73):
            present = 12 <= hour < 60 if late_change == "deletion" else hour >= 60
            run_id = collect(store, hour, [*past_events(), *([reset] if present else [])])
            if hour == 0:
                archive(store, run_id)
        at_maturity = score_archived_forecasts(store, now=ORIGIN + timedelta(hours=48))[0]
        later = score_archived_forecasts(store, now=ORIGIN + timedelta(hours=72))[0]
        assert at_maturity["label"] == later["label"] == (1 if late_change == "deletion" else 0)
        assert at_maturity["sourceRevisionWarning"] is False
        assert later["sourceRevisionWarning"] is True
        assert at_maturity["outcomeRunId"] == later["outcomeRunId"]
        assert at_maturity["probability48h"] == later["probability48h"] == .4


def test_no_successful_followup_cannot_label_no_event():
    with CollectionStore() as store:
        archive(store, collect(store, 0, past_events()))
        outcome = score_archived_forecasts(store, now=ORIGIN + timedelta(hours=72))[0]
        assert outcome["status"] == "unknown"
        assert outcome["reason"] == "incomplete_followup"
        assert outcome["label"] is None


def test_small_and_empty_datasets_are_kept_explicit():
    with CollectionStore() as store:
        with pytest.raises(ValueError, match="no_successful_collection"):
            get_training_history(store)
        assert build_training_dataset(store, now=ORIGIN)["samples"] == []
        assert score_archived_forecasts(store, now=ORIGIN) == []
        collect(store, 0, past_events()[:3])
        result = build_training_dataset(store, now=ORIGIN)
        assert result["censored"][0]["reason"] == "insufficient_past_events"
        with pytest.raises(ValueError, match="max_gap_hours"):
            build_training_dataset(store, now=ORIGIN, max_gap_hours=0)
