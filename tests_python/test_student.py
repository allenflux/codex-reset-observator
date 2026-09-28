import hashlib
import json
import math
from datetime import UTC, datetime, timedelta

import pytest

from observatory import collector, student
from observatory.collection_config import CollectionSettings
from observatory.collection_store import CollectionStore
from observatory.distillation import FEATURES, PILOT_MODEL_VERSION
from observatory.domain import build_snapshot
from observatory.teacher import MODEL_VERSION as TEACHER_VERSION
from observatory.teacher import SOURCE, SOURCE_URL

NOW = datetime(2026, 9, 28, 3, tzinfo=UTC)


def teacher(**overrides):
    return {
        "schemaVersion": 1, "source": SOURCE, "sourceUrl": SOURCE_URL,
        "modelVersion": TEACHER_VERSION, "sourceStale": False,
        "checkedAt": (NOW - timedelta(minutes=5)).isoformat(), "fetchedAt": NOW.isoformat(),
        "probability24h": 0.8, "probability48h": 0.9,
        "lastRandomResetAt": (NOW - timedelta(days=2)).isoformat(),
        "context": {"latestPostAt": (NOW - timedelta(days=1)).isoformat(),
                    "latestPostClassification": "teaser", "latestPostTeaserStrength": "weak",
                    "probability24h": .8, "private": "private-example-secret"},
        **overrides,
    }


@pytest.fixture
def model_path(tmp_path, monkeypatch):
    payload = {
        "modelVersion": PILOT_MODEL_VERSION, "features": FEATURES,
        "mean": [0.] * len(FEATURES), "scale": [1.] * len(FEATURES),
        "weights": [[[0.] for _ in FEATURES], [[0., 0.]]],
        "biases": [[0.], [-math.log(3), 0.]],
        "trainedAt": (NOW - timedelta(hours=1)).isoformat(),
        "observedUntil": (NOW - timedelta(hours=2)).isoformat(),
        "sampleCount": 97, "observationSpanDays": 3.99, "distinctUtcDays": 5,
        "trainingDataSha256": "a" * 64,
        "evaluation": {"status": "pilot_holdout", "trainSampleCount": 25, "testSampleCount": 9,
                       "student": {"mae24hPercentagePoints": 3.1, "mae48hPercentagePoints": 2.1,
                                   "rawTargets": "private-example-secret"},
                       "baselines": {"training_mean": {"meanMaePercentagePoints": 4.2},
                                     "private": "private-example-secret"},
                       "holdoutPredictions": "private-example-secret"},
        "private": "private-example-secret",
    }
    path = tmp_path / "student.json"
    path.write_text(json.dumps(payload))
    monkeypatch.setattr(student, "MODEL_PATH", path)
    return path


def test_student_is_portable_and_public_metadata_excludes_raw_weights_and_targets(model_path):
    actual = student.student_forecast(teacher(), now=NOW)
    assert actual["available"] is True
    assert actual["probability24h"] == pytest.approx(.25)
    assert actual["probability48h"] == pytest.approx(.625)
    assert actual["modelVersion"] == PILOT_MODEL_VERSION
    assert actual["deploymentRole"] == "comparison_only"
    assert actual["eligibleForUse"] is False
    assert actual["sampleCount"] == 97
    assert actual["modelSha256"] == hashlib.sha256(model_path.read_bytes()).hexdigest()
    assert actual["evaluation"]["student"] == {"mae24hPercentagePoints": 3.1, "mae48hPercentagePoints": 2.1}
    serialized = json.dumps(actual)
    assert "private-example-secret" not in serialized
    assert "weights" not in serialized and "holdoutPredictions" not in serialized
    altered = teacher(probability24h=.01, probability48h=.02)
    assert student.student_forecast(altered, now=NOW)["probability24h"] == actual["probability24h"]


@pytest.mark.parametrize(("source", "reason"), [
    (None, "context_missing"),
    (teacher(checkedAt=(NOW - timedelta(minutes=31)).isoformat()), "context_expired"),
    (teacher(sourceStale=True), "context_upstream_stale"),
    (teacher(probability24h=float("nan")), "context_invalid"),
])
def test_unavailable_context_preserves_visible_model_metadata(model_path, source, reason):
    actual = student.student_forecast(source, now=NOW)
    assert actual["reason"] == reason
    assert actual["modelAvailable"] is True and actual["available"] is False
    assert actual["sampleCount"] == 97 and actual["trainedAt"]
    assert actual["probability24h"] is None and actual["probability48h"] is None


@pytest.mark.parametrize("field", ["trainedAt", "observedUntil"])
def test_input_predating_training_or_observation_cutoff_is_refused(model_path, field):
    model = json.loads(model_path.read_text())
    model[field] = (NOW - timedelta(minutes=1)).isoformat()
    model_path.write_text(json.dumps(model))
    actual = student.student_forecast(teacher(), now=NOW)
    assert actual["available"] is False
    assert actual["reason"] == "context_before_training"
    assert actual["modelVersion"] == PILOT_MODEL_VERSION


def test_missing_and_invalid_models_fail_closed(tmp_path):
    path = tmp_path / "missing.json"
    assert student.student_forecast(teacher(), now=NOW, model_path=path)["reason"] == "model_missing"
    path.write_text('{"private": "private-example-secret"}')
    result = student.student_forecast(teacher(), now=NOW, model_path=path)
    assert result["reason"] == "model_invalid"
    assert result["modelVersion"] is None
    assert "private-example-secret" not in json.dumps(result)


def test_student_never_replaces_primary_or_stale_teacher_fallback(model_path):
    data = {"reset_history": [], "teacher_forecast": teacher()}
    mirrored = build_snapshot(data, "zh", NOW)["viewModel"]
    assert mirrored["studentForecast"]["available"] is True
    assert mirrored["primaryForecast"]["kind"] == "upstream_mirror"
    assert mirrored["probability24h"] == .8
    assert mirrored["probability48h"] == .9
    data["teacher_forecast"] = teacher(sourceStale=True)
    stale = build_snapshot(data, "zh", NOW)["viewModel"]
    assert stale["studentForecast"]["available"] is False
    assert stale["primaryForecast"]["kind"] == "statistical_fallback"
    assert stale["probability24h"] == stale["statisticalBaseline"]["probability24h"]


def collect(store):
    return collector.collect_once(
        CollectionSettings(), store=store, clock=lambda: NOW,
        fetcher=lambda: ([], {"teacherForecast": teacher()}),
        snapshot_builder=lambda *args, **kwargs: {"viewModel": {"probability24h": .1, "probability48h": .2}},
    )


def test_collector_archives_student_identity_with_inputs_without_teacher_probabilities(model_path):
    with CollectionStore() as store:
        result = collect(store)
        assert result["ok"] is True
        assert result["studentForecastStatus"] == result["teacherForecastStatus"] == "saved"
        assert result["predictionCount"] == 3
        baseline, upstream, predicted = store.export_dataset()["predictions"]
        assert predicted["sourceRunId"] == upstream["sourceRunId"] == baseline["sourceRunId"] == result["runId"]
        assert predicted["modelVersion"] == PILOT_MODEL_VERSION
        assert predicted["probability24h"] == pytest.approx(.25)
        features = predicted["features"]
        assert features["forecastKind"] == "teacher_student_pilot"
        assert features["modelSha256"] == hashlib.sha256(model_path.read_bytes()).hexdigest()
        assert features["forecastOrigin"] == teacher()["checkedAt"]
        assert features["inputContext"]["checkedAt"] == teacher()["checkedAt"]
        assert features["inputContext"]["context"]["latestPostClassification"] == "teaser"
        assert "probability" not in json.dumps(features)
        assert "private-example-secret" not in json.dumps(features)


def test_student_archive_failure_preserves_teacher_and_history(model_path):
    class FailingStudentStore(CollectionStore):
        def record_prediction(self, **kwargs):
            if kwargs["model_version"] == PILOT_MODEL_VERSION:
                raise RuntimeError("private-example-secret")
            return super().record_prediction(**kwargs)

    with FailingStudentStore() as store:
        result = collect(store)
        assert result["ok"] is True and result["predictionCount"] == 2
        assert result["teacherForecastStatus"] == "saved"
        assert result["studentForecastStatus"] == "student_prediction_failed"
        assert store.get_status()["successfulRunCount"] == 1
        assert "private-example-secret" not in json.dumps(result)


def test_teacher_archive_failure_does_not_prevent_student_archive(model_path):
    class FailingTeacherStore(CollectionStore):
        def record_prediction(self, **kwargs):
            if kwargs["model_version"] == TEACHER_VERSION:
                raise RuntimeError("teacher-write-failed")
            return super().record_prediction(**kwargs)

    with FailingTeacherStore() as store:
        result = collect(store)
        assert result["ok"] is True and result["predictionCount"] == 2
        assert result["teacherForecastStatus"] == "teacher_prediction_failed"
        assert result["studentForecastStatus"] == "saved"
