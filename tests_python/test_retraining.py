import copy
import json
import math
from datetime import UTC, datetime, timedelta

import pytest

from observatory import retraining
from observatory.collection_config import CollectionSettings
from observatory.collection_store import CollectionStorageError, CollectionStore
from observatory.neural import FEATURES, eligible_events, features_at, make_samples, parse_time

ORIGIN = datetime(2026, 1, 20, tzinfo=UTC)


def event(key, at):
    return {"id": key, "completed_at": at.isoformat(), "recordKind": "confirmed_global",
            "details": {"cycleType": "Random reset", "scope": "All users"}}


def past_events():
    return [event(f"past-{day}", ORIGIN - timedelta(days=day)) for day in (15, 12, 9, 6)]


def constant_model(probabilities=(.5, .25, .25), *, version="reset-mlp-8-tanh-v1"):
    return {"modelVersion": version, "features": FEATURES, "mean": [0] * 7, "scale": [1] * 7,
            "weights": [[[0] * 8 for _ in range(7)], [[0] * 3 for _ in range(8)]],
            "biases": [[0] * 8, [math.log(p) for p in probabilities]],
            "trainedAt": ORIGIN.isoformat(), "observedUntil": ORIGIN.isoformat()}


def collect_hours(store, end=96, *, gap=(), revise=False):
    original = past_events()
    for hour in range(end + 1):
        at = ORIGIN + timedelta(hours=hour)
        if hour in gap:
            store.record_failure(fetched_at=at, error_code="network_error")
            continue
        rows = original
        if revise and hour >= 36:
            rows = [{**original[0], "completed_at": (ORIGIN - timedelta(days=14)).isoformat()},
                    *original[1:], event("new-reset", ORIGIN + timedelta(hours=36)),
                    event("late-discovery", ORIGIN - timedelta(days=1))]
        store.record_success(rows, fetched_at=at, source_metadata={"completeHistory": True})


@pytest.fixture
def trainer(monkeypatch):
    calls = []

    def train(history, until, path, *, model_version):
        calls.append({"history": copy.deepcopy(history), "until": until, "version": model_version})
        assert all(parse_time(row["completed_at"]) <= until for row in history)
        path.write_text(json.dumps(constant_model((.5, .3, .2), version=model_version)))
        events, _ = eligible_events(history, until)
        return {"observedUntil": until.isoformat(), "sampleCount": len(make_samples(events, until)),
                "selectedAlpha": 100.0}

    monkeypatch.setattr(retraining, "train_model", train)
    return calls


def test_daily_replay_keeps_later_corrections_out_of_earlier_fits_and_inputs(monkeypatch, trainer):
    inputs = []
    predict = retraining._predict_weights

    def capture_input(model, values):
        inputs.append(list(values))
        return predict(model, values)

    monkeypatch.setattr(retraining, "_predict_weights", capture_input)
    with CollectionStore() as store:
        collect_hours(store, revise=True)
        result = retraining.compare_retraining(store, constant_model(), now=ORIGIN + timedelta(hours=96))
    assert result["sampleCount"] == 3
    assert [row["label"] for row in result["predictions"]] == [2, 1, 0]
    assert [call["until"] for call in trainer] == [ORIGIN + timedelta(hours=h) for h in (0, 24, 48)]
    assert all(call["version"] == "reset-mlp-8-tanh-v2" for call in trainer)
    assert trainer[0]["history"] == trainer[1]["history"] == past_events()
    assert {row["id"] for row in trainer[2]["history"]} == {
        *(row["id"] for row in past_events()), "new-reset", "late-discovery"}
    assert trainer[2]["history"][0]["completed_at"] != trainer[0]["history"][0]["completed_at"]
    for index, call in enumerate(trainer):
        events, _ = eligible_events(call["history"], call["until"])
        expected = features_at(events, call["until"])
        assert inputs[index * 2] == inputs[index * 2 + 1] == expected
    assert result["sourceRevisionWarningCount"] == 2
    assert set(result["metrics"]) == {"incumbent", "daily_retraining", "empirical_frequency", "poisson_rate"}
    for row in result["predictions"]:
        assert set(row["probabilities"]) == set(result["metrics"])
        assert row["candidateTrainingObservedUntil"] == row["origin"]
    # Every reported score must use the same three origins and observed labels.
    for name, scores in result["metrics"].items():
        for horizon in (24, 48):
            squared_errors = []
            for row in result["predictions"]:
                target = row["label"] == 1 if horizon == 24 else row["label"] != 0
                squared_errors.append((row["probabilities"][name][f"probability{horizon}h"] - target) ** 2)
            assert scores[f"brier{horizon}h"] == pytest.approx(sum(squared_errors) / 3)


def test_replay_excludes_unobserved_gaps_and_immature_outcomes(trainer):
    with CollectionStore() as store:
        collect_hours(store, gap=range(12, 17))
        result = retraining.compare_retraining(store, constant_model(), now=ORIGIN + timedelta(hours=96))
    assert result["sampleCount"] == 2
    assert [call["until"] for call in trainer] == [ORIGIN + timedelta(hours=h) for h in (24, 48)]
    assert result["censoredCounts"] == {"collection_gap": 1, "horizon_not_mature": 2}


@pytest.mark.parametrize("later_field", ["trainedAt", "observedUntil"])
def test_replay_waits_for_both_incumbent_training_and_observation_cutoffs(later_field, trainer):
    incumbent = constant_model()
    incumbent[later_field] = (ORIGIN + timedelta(hours=25)).isoformat()
    with CollectionStore() as store:
        collect_hours(store)
        result = retraining.compare_retraining(store, incumbent, now=ORIGIN + timedelta(hours=96))
    assert result["sampleCount"] == 1
    assert result["excludedBeforeIncumbentAvailable"] == 2
    assert result["incumbentAvailableAt"] == incumbent[later_field]
    assert trainer[0]["until"] == ORIGIN + timedelta(hours=48)


def test_replay_without_mature_samples_has_no_scores_or_training(trainer):
    with CollectionStore() as store:
        collect_hours(store, end=24)
        result = retraining.compare_retraining(store, constant_model(), now=ORIGIN + timedelta(hours=24))
    assert result["sampleCount"] == 0
    assert result["metrics"] == {}
    assert result["predictions"] == []
    assert result["start"] is None and result["end"] is None
    assert not trainer


@pytest.mark.parametrize("use_snapshot", [False, True])
def test_cli_compares_frozen_database_or_file_and_can_save_exact_snapshot(
    use_snapshot, trainer, monkeypatch, tmp_path, capsys,
):
    store = CollectionStore()
    collect_hours(store)
    dataset = store.export_dataset()
    incumbent_path = tmp_path / "incumbent.json"
    incumbent_path.write_text(json.dumps(constant_model()))
    connections = []
    configuration = CollectionSettings(backend="sqlite")
    monkeypatch.setattr(retraining.CollectionSettings, "from_env", classmethod(lambda cls: configuration))

    def connect(settings):
        assert not use_snapshot, "File replay must not connect to a database"
        connections.append(settings)
        return store

    monkeypatch.setattr(retraining, "create_collection_store", connect)
    output = tmp_path / "reports" / "comparison.json"
    saved = tmp_path / "inputs" / "snapshot.json"
    args = ["--incumbent", str(incumbent_path), "--output", str(output), "--save-snapshot", str(saved)]
    if use_snapshot:
        source_path = tmp_path / "source.json"
        source_path.write_text(json.dumps(dataset))
        args.extend(["--snapshot", str(source_path)])
        store.close()
    retraining.main(args)
    assert connections == ([] if use_snapshot else [configuration])
    assert json.loads(saved.read_text()) == dataset
    result = json.loads(output.read_text())
    assert result["sampleCount"] == 3
    assert json.loads(capsys.readouterr().out)["metrics"] == result["metrics"]
    assert len(trainer) == 3


def test_cli_database_failure_does_not_echo_connection_secrets(monkeypatch, tmp_path, capsys):
    incumbent_path = tmp_path / "incumbent.json"
    incumbent_path.write_text(json.dumps(constant_model()))
    configuration = CollectionSettings(backend="sqlite")
    monkeypatch.setattr(retraining.CollectionSettings, "from_env", classmethod(lambda cls: configuration))

    def unavailable(settings):
        raise CollectionStorageError("private-test-credential-in-connection-message")

    monkeypatch.setattr(retraining, "create_collection_store", unavailable)
    output = tmp_path / "comparison.json"
    with pytest.raises(SystemExit) as raised:
        retraining.main(["--incumbent", str(incumbent_path), "--output", str(output)])
    assert raised.value.code == 1
    captured = capsys.readouterr()
    assert "Comparison failed." in captured.err
    assert "private-test-credential" not in captured.err + captured.out
    assert "Traceback" not in captured.err
    assert not output.exists()
