import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from observatory import cli, collection_config, collector, neural, training_data
from observatory.collection_config import CollectionSettings
from observatory.collection_store import CollectionStorageError, CollectionStore

OBSERVED_UNTIL = datetime(2026, 9, 12, tzinfo=UTC)
HISTORY = [{"id": "test-reset", "completed_at": "2026-09-01T00:00:00Z"}]


@pytest.fixture(autouse=True)
def isolated_configuration(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    configuration = CollectionSettings(backend="sqlite")
    monkeypatch.setattr(collection_config.CollectionSettings, "from_env", classmethod(lambda cls: configuration))
    return configuration


@pytest.fixture
def trainer(monkeypatch):
    calls = []

    def train(rows, until, model_path, report_path):
        calls.append((rows, until, model_path, report_path))
        report = {"modelVersion": "test-model", "sampleCount": 100, "neural": {"meanBrier": .2},
                  "baselines": {"simple": .1}, "relativeBrierImprovement": -.1,
                  "deploymentStatus": "experimental"}
        for path, content in ((model_path, {"testModel": True}), (report_path, report)):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(content))
        return report

    monkeypatch.setattr(neural, "train_model", train)
    return calls


def test_train_defaults_to_database_and_preserves_provenance_in_ignored_output(monkeypatch, trainer, capsys):
    store = CollectionStore()
    connected = []
    provenance = {"mode": "retrospective_latest_collected_history", "sourceRunId": 7}

    def connect(settings):
        connected.append(settings)
        return store

    def history(database):
        assert database is store
        return HISTORY, OBSERVED_UNTIL, provenance

    monkeypatch.setattr(collection_config, "create_collection_store", connect)
    monkeypatch.setattr(training_data, "get_training_history", history)
    cli.main(["train"])
    assert len(connected) == 1
    assert trainer == [(HISTORY, OBSERVED_UNTIL, Path("var/training/neural_model.json"),
                        Path("var/training/neural-evaluation.json"))]
    report = json.loads(Path("var/training/neural-evaluation.json").read_text())
    assert report["collectionProvenance"] == provenance
    assert trainer[0][2].resolve() != neural.MODEL_PATH.resolve()
    assert "active model was not changed" in capsys.readouterr().out


def test_database_coverage_override_is_rejected_before_connecting(monkeypatch, trainer, capsys):
    def unexpected_connection(settings):
        pytest.fail("Coverage override must fail before connecting")

    monkeypatch.setattr(collection_config, "create_collection_store", unexpected_connection)
    with pytest.raises(SystemExit) as raised:
        cli.main(["train", "--observed-until", "2026-09-12T00:00:00Z"])
    assert raised.value.code == 2
    assert not trainer
    assert "cannot override database observation coverage" in capsys.readouterr().err


def test_custom_history_requires_explicit_observation_end_even_beside_other_metadata(trainer, capsys):
    Path("custom.json").write_text(json.dumps(HISTORY))
    Path("online_history_metadata.json").write_text(json.dumps({"fetchedAt": "2026-09-12T00:00:00Z"}))
    with pytest.raises(SystemExit) as raised:
        cli.main(["train", "--history", "custom.json"])
    assert raised.value.code == 2
    assert not trainer
    assert "--observed-until is required" in capsys.readouterr().err


def test_file_training_uses_explicit_coverage_and_custom_artifact_paths(monkeypatch, trainer):
    def unexpected_connection(settings):
        pytest.fail("File override must not query the database")

    monkeypatch.setattr(collection_config, "create_collection_store", unexpected_connection)
    Path("custom.json").write_text(json.dumps(HISTORY))
    cli.main(["train", "--history", "custom.json", "--observed-until", "2026-09-12T07:00:00+07:00",
              "--model", "var/experiment/model.json", "--report", "var/experiment/report.json"])
    assert trainer == [(HISTORY, OBSERVED_UNTIL, Path("var/experiment/model.json"), Path("var/experiment/report.json"))]
    assert "collectionProvenance" not in json.loads(Path("var/experiment/report.json").read_text())


def test_matching_import_history_can_use_its_observation_metadata(trainer):
    Path("online_history.json").write_text(json.dumps(HISTORY))
    Path("online_history_metadata.json").write_text(json.dumps({"fetchedAt": OBSERVED_UNTIL.isoformat()}))
    cli.main(["train", "--history", "online_history.json"])
    assert trainer[0][1] == OBSERVED_UNTIL


@pytest.mark.parametrize("metadata", [[], {}, {"fetchedAt": None}, {"fetchedAt": "2026-09-12"}])
def test_invalid_import_observation_metadata_fails_cleanly(metadata, trainer, capsys):
    Path("online_history.json").write_text(json.dumps(HISTORY))
    Path("online_history_metadata.json").write_text(json.dumps(metadata))
    with pytest.raises(SystemExit) as raised:
        cli.main(["train", "--history", "online_history.json"])
    assert raised.value.code == 1
    assert not trainer
    assert "Command failed." in capsys.readouterr().err


@pytest.mark.parametrize("command,filename,payload", [
    ("export-training", "prospective-dataset.json", {"samples": [], "censored": [{"reason": "pending"}]}),
    ("score-forecasts", "forecast-scores.json", {"forecasts": [{"status": "pending"}]}),
])
def test_dataset_commands_default_to_local_ignored_artifacts_without_training(
    command, filename, payload, monkeypatch, trainer,
):
    store = CollectionStore()
    monkeypatch.setattr(collection_config, "create_collection_store", lambda settings: store)
    monkeypatch.setattr(training_data, "build_training_dataset", lambda database: payload)
    monkeypatch.setattr(training_data, "score_archived_forecasts", lambda database: payload["forecasts"])
    cli.main([command])
    assert json.loads((Path("var/training") / filename).read_text()) == payload
    assert not trainer


@pytest.mark.parametrize("command", ["train", "export-training", "score-forecasts", "collection-status"])
def test_database_errors_are_sanitized_without_tracebacks(command, monkeypatch, capsys):
    def unavailable(*args, **kwargs):
        raise CollectionStorageError("private-test-credential")

    monkeypatch.setattr(collection_config, "create_collection_store", unavailable)
    monkeypatch.setattr(collector, "collection_status", unavailable)
    with pytest.raises(SystemExit) as raised:
        cli.main([command])
    assert raised.value.code == 1
    output = capsys.readouterr()
    assert "private-test-credential" not in output.err + output.out
    assert "Traceback" not in output.err
    assert "Command failed." in output.err


@pytest.mark.parametrize("args", [["sync-history"], ["collect", "--once"]])
@pytest.mark.parametrize("success", [False, True])
def test_collection_commands_surface_success_or_failure_without_retraining(args, success, monkeypatch, trainer, capsys):
    monkeypatch.setattr(collector, "collect_once", lambda settings: {"ok": success})
    if success:
        cli.main(args)
    else:
        with pytest.raises(SystemExit) as raised:
            cli.main(args)
        assert raised.value.code == 1
    assert json.loads(capsys.readouterr().out) == {"ok": success}
    assert not trainer


def test_continuous_collection_uses_worker_without_retraining(monkeypatch, trainer, isolated_configuration):
    calls = []
    monkeypatch.setattr(collector, "run_collector", lambda settings: calls.append(settings))
    cli.main(["collect"])
    assert calls == [isolated_configuration]
    assert not trainer


@pytest.mark.parametrize("fresh", [False, True])
def test_collection_freshness_exit_status(fresh, monkeypatch, capsys):
    monkeypatch.setattr(collector, "collection_status", lambda settings: {"fresh": fresh, "eventCount": 43})
    if fresh:
        cli.main(["collection-status", "--check-fresh"])
    else:
        with pytest.raises(SystemExit) as raised:
            cli.main(["collection-status", "--check-fresh"])
        assert raised.value.code == 1
    assert json.loads(capsys.readouterr().out) == {"fresh": fresh, "eventCount": 43}
