import copy
import json
import math
from datetime import UTC, datetime, timedelta

import pytest

from observatory import distillation as student
from observatory.collection_config import CollectionSettings
from observatory.collection_store import CollectionStorageError

START = datetime(2026, 1, 1, tzinfo=UTC)
NOW = START + timedelta(days=40)


def prediction(at, *, p24=.2, p48=.4, post=None):
    teacher = {
        "checkedAt": at.isoformat(), "fetchedAt": (at + timedelta(seconds=10)).isoformat(),
        "probability24h": p24, "probability48h": p48, "sourceStale": False,
        "lastRandomResetAt": (START - timedelta(days=1)).isoformat(),
        "context": {"resetTeaserStatus": "none", "codexOperationalStatus": "none",
                    "officialNoticeActive": False, "noticeStartsAt": None, "noticeEndsAt": None,
                    "latestPostAt": post.isoformat() if post else None,
                    "latestPostClassification": "irrelevant", "latestPostTeaserStrength": None,
                    "isReply": False, "isQuote": False},
    }
    return {"modelVersion": student.TEACHER_VERSION, "features": {"teacherForecast": teacher},
            "timestamp": teacher["fetchedAt"], "probability24h": p24, "probability48h": p48}


def dataset(days=30):
    rows = []
    for day in range(days):
        for hour in (0, 6, 12, 18):
            at = START + timedelta(days=day, hours=hour)
            value = .2 + .06 * math.sin(2 * math.pi * day / 7) + .02 * math.sin(2 * math.pi * hour / 24)
            rows.append(prediction(at, p24=value, p48=value + (1 - value) * .3,
                                   post=at.replace(hour=0) - timedelta(hours=1)))
    return {"predictions": rows}


def constant_model(p24=.3, p48=.55):
    return {"features": student.FEATURES, "mean": [0.0] * len(student.FEATURES),
            "scale": [1.0] * len(student.FEATURES),
            "weights": [[[0.0] * 8 for _ in student.FEATURES], [[0.0] * 2 for _ in range(8)]],
            "biases": [[0.0] * 8, [student._logit(p24), student._logit((p48 - p24) / (1 - p24))]],
            "modelVersion": student.MODEL_VERSION,
            "trainedAt": (START - timedelta(days=1)).isoformat(),
            "observedUntil": (START - timedelta(days=2)).isoformat()}


def test_probabilities_and_probability_derived_text_are_never_inputs():
    teacher = prediction(START)["features"]["teacherForecast"]
    expected = student.features_at(teacher)
    teacher.update({"probability24h": float("nan"), "probability48h": 1.0, "probability12h": .999,
                    "probability72h": .999, "expectation": "high", "displayReasoningSummary": "90%"})
    teacher["context"].update({"probability24h": 1, "expectation": "very high", "text": "reset now"})
    assert student.features_at(teacher) == expected
    assert len(expected) == len(student.FEATURES)
    assert all(math.isfinite(value) for value in expected)


@pytest.mark.parametrize("status,feature", [
    ("none", "status_operational"), ("active", "status_incident"),
    ("recovered", "status_recovered"), ("unknown", "status_unknown"),
])
def test_live_source_status_enumeration_has_distinct_features(status, feature):
    teacher = prediction(START)["features"]["teacherForecast"]
    teacher["context"]["codexOperationalStatus"] = status
    values = dict(zip(student.FEATURES, student.features_at(teacher), strict=True))
    assert values[feature] == 1
    assert sum(value for key, value in values.items() if key.startswith("status_")) == 1


def test_samples_filter_model_staleness_and_all_future_information():
    rows = [prediction(START)]
    other = prediction(START + timedelta(hours=1))
    other["modelVersion"] = "reset-mlp-8-tanh-v1"
    stale = prediction(START + timedelta(hours=2))
    stale["features"]["teacherForecast"]["sourceStale"] = True
    future_post = prediction(START + timedelta(hours=3), post=NOW)
    future_fetch = prediction(START + timedelta(hours=4))
    future_fetch["features"]["teacherForecast"]["fetchedAt"] = (NOW + timedelta(hours=1)).isoformat()
    future_origin = prediction(NOW + timedelta(hours=2))
    samples, quality = student.prepare_samples({"predictions": rows + [other, stale, future_post, future_fetch, future_origin]}, now=NOW)
    assert len(samples) == 1
    assert samples[0]["origin"] == START
    assert quality["excluded"] == {"other_model": 1, "invalid_or_stale_teacher": 4}


@pytest.mark.parametrize("values", [(float("nan"), .5), (.7, .3), (-.1, .2), (.2, 1.1), (True, .4), (10**400, .5)])
def test_invalid_teacher_targets_are_excluded(values):
    samples, quality = student.prepare_samples({"predictions": [prediction(START, p24=values[0], p48=values[1])]}, now=NOW)
    assert not samples
    assert quality["excluded"]["invalid_or_stale_teacher"] == 1


def test_checked_at_deduplication_precedes_hourly_selection():
    original = prediction(START)
    duplicate = copy.deepcopy(original)
    duplicate["features"]["teacherForecast"].update({"fetchedAt": (START + timedelta(minutes=5)).isoformat(),
                                                     "probability24h": .3})
    same_hour = prediction(START + timedelta(minutes=10))
    next_hour = prediction(START + timedelta(hours=1))
    samples, quality = student.prepare_samples({"predictions": [duplicate, next_hour, same_hour, original]}, now=NOW)
    assert len(samples) == 2
    assert samples[0]["targets"] == [.2, .4]
    assert quality["excluded"] == {"duplicate_checked_at": 1, "same_utc_hour": 1}


def test_temporal_split_uses_whole_days_24h_gaps_and_no_shared_posts():
    samples, _ = student.prepare_samples(dataset(), now=NOW)
    parts, purged = student.split_samples(samples)
    for earlier, later in [("train", "validation"), ("validation", "test")]:
        assert max(row["availableAt"] for row in parts[earlier]) + timedelta(hours=24) <= min(row["origin"] for row in parts[later])
        assert {row["origin"].date() for row in parts[earlier]}.isdisjoint(row["origin"].date() for row in parts[later])
        assert {row["postAt"] for row in parts[earlier] if row["postAt"]}.isdisjoint(row["postAt"] for row in parts[later] if row["postAt"])
    assert purged["time_boundary"] > 0
    for row in samples:
        row["postAt"] = "same-old-post"
    parts, purged = student.split_samples(samples)
    assert parts["train"] and not parts["validation"] and not parts["test"]
    assert purged["post_shared_with_earlier_split"] > 0


@pytest.mark.parametrize("kind", ["few", "short", "constant", "one_post"])
def test_insufficient_data_is_reported_without_writing_weights(kind, monkeypatch, tmp_path):
    source = dataset()
    if kind == "few":
        source["predictions"] = source["predictions"][::3]
    elif kind == "short":
        source = {"predictions": [prediction(START + timedelta(hours=h), p24=.1 + h / 1000) for h in range(100)]}
    elif kind == "constant":
        for row in source["predictions"]:
            row["features"]["teacherForecast"].update({"probability24h": .2, "probability48h": .4})
    else:
        for row in source["predictions"]:
            row["features"]["teacherForecast"]["context"]["latestPostAt"] = (START - timedelta(days=1)).isoformat()
    monkeypatch.setattr(student, "_fit", lambda *_: pytest.fail("Insufficient data must never fit fake weights"))
    path, report_path = tmp_path / "model.json", tmp_path / "report.json"
    report = student.train_student(source, model_path=path, report_path=report_path, now=NOW)
    assert report["status"] == "insufficient_data"
    assert report["reasons"] and not report["modelWritten"]
    assert not path.exists()
    assert json.loads(report_path.read_text()) == report


def test_holdout_never_enters_tuning_or_evaluation_fit(monkeypatch, tmp_path):
    calls = []

    def fit(rows, alpha):
        calls.append(copy.deepcopy(rows))
        mean = [sum(row["targets"][i] for row in rows) / len(rows) for i in (0, 1)]
        return constant_model(*mean)

    monkeypatch.setattr(student, "_fit", fit)
    source = dataset()
    report = student.train_student(source, model_path=tmp_path / "model.json", report_path=tmp_path / "report.json", now=NOW)
    split, _ = student.split_samples(student.prepare_samples(source, now=NOW)[0])
    assert len(calls) == 5  # Three tuning fits, one pre-test fit, one final candidate fit.
    assert all(rows == split["train"] for rows in calls[:3])
    assert calls[3] == split["train"] + split["validation"]
    test_start = datetime.fromisoformat(report["splits"]["test"]["start"])
    assert all(row["availableAt"] < test_start for rows in calls[:4] for row in rows)
    assert len(calls[4]) == 120
    assert report["baselines"]["previous_observed_teacher"]["meanMaePercentagePoints"] > 0
    before = report["validationCandidates"]
    for row in source["predictions"]:
        teacher = row["features"]["teacherForecast"]
        if datetime.fromisoformat(teacher["checkedAt"]) >= test_start:
            teacher.update({"probability24h": .7, "probability48h": .9})
    changed = student.train_student(source, model_path=tmp_path / "changed.json", report_path=tmp_path / "changed-report.json", now=NOW)
    assert changed["selectedAlpha"] == report["selectedAlpha"]
    assert changed["validationCandidates"] == before
    assert changed["student"] != report["student"]


def test_regression_training_writes_portable_monotone_candidate(tmp_path):
    pytest.importorskip("sklearn")
    path = tmp_path / "candidate.json"
    report = student.train_student(dataset(), model_path=path, report_path=tmp_path / "report.json", now=NOW)
    model = json.loads(path.read_text())
    assert report["status"] == "trained_candidate" and report["modelWritten"]
    assert model["modelVersion"] == student.MODEL_VERSION and not model["eligibleForUse"]
    assert set(report["baselines"]) == {"development_mean", "previous_observed_teacher"}
    assert report["student"]["meanMaePercentagePoints"] < 10
    for row in student.prepare_samples(dataset(), now=NOW)[0]:
        p24, p48 = student._predict(model, row["features"])
        assert 0 <= p24 <= p48 <= 1
    fresh = datetime.now(UTC) + timedelta(days=1)
    teacher = prediction(fresh)["features"]["teacherForecast"]
    result = student.forecast(model, teacher, now=fresh + timedelta(minutes=1))
    assert result and 0 <= result["probability24h"] <= result["probability48h"] <= 1


def test_portable_mapping_matches_hand_computed_probabilities():
    expected = [.3, .55]
    assert student._predict(constant_model(), [0] * len(student.FEATURES)) == pytest.approx(expected)
    for logits in ([-1000, 1000], [1000, -1000], [-1000, -1000], [1000, 1000]):
        p24, p48 = student._probabilities(logits)
        assert 0 <= p24 <= p48 <= 1


@pytest.mark.parametrize("field", ["trainedAt", "observedUntil"])
def test_inference_refuses_origin_before_model_availability(field):
    model = constant_model()
    teacher = prediction(START)["features"]["teacherForecast"]
    now = START + timedelta(minutes=1)
    assert student.forecast(model, teacher, now=now)
    model[field] = (START + timedelta(seconds=1)).isoformat()
    assert student.forecast(model, teacher, now=now) is None


def test_fresh_fetch_does_not_make_expired_source_context_usable():
    model = constant_model()
    teacher = prediction(START)["features"]["teacherForecast"]
    assert student.forecast(model, teacher, now=START + timedelta(minutes=30))
    assert student.forecast(model, teacher, now=START + timedelta(minutes=30, seconds=1)) is None
    teacher["fetchedAt"] = (START + timedelta(minutes=40)).isoformat()
    assert student.forecast(model, teacher, now=START + timedelta(minutes=40)) is None
    samples, quality = student.prepare_samples({"predictions": [
        {"modelVersion": student.TEACHER_VERSION, "features": {"teacherForecast": teacher}},
    ]}, now=NOW)
    assert samples == []
    assert quality["excluded"]["invalid_or_stale_teacher"] == 1


def test_cli_frozen_dataset_reports_insufficient_without_database(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(student, "create_collection_store", lambda *_: pytest.fail("Must not access database"))
    source = tmp_path / "dataset.json"
    source.write_text(json.dumps({"predictions": []}))
    report = tmp_path / "report.json"
    model = tmp_path / "model.json"
    student.main(["--dataset", str(source), "--report", str(report), "--model", str(model)])
    assert json.loads(capsys.readouterr().out)["status"] == "insufficient_data"
    assert report.exists() and not model.exists()


def test_cli_database_reads_export_and_preserves_existing_model_on_insufficient_data(monkeypatch, tmp_path, capsys):
    settings = CollectionSettings(backend="sqlite")
    monkeypatch.setattr(student.CollectionSettings, "from_env", classmethod(lambda cls: settings))

    class Store:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

        def export_dataset(self):
            return {"predictions": []}

    def connect(config):
        assert config is settings
        return Store()

    monkeypatch.setattr(student, "create_collection_store", connect)
    model = tmp_path / "model.json"
    model.write_text("previous weights")
    student.main(["--report", str(tmp_path / "report.json"), "--model", str(model)])
    assert json.loads(capsys.readouterr().out)["modelWritten"] is False
    assert model.read_text() == "previous weights"


def test_cli_does_not_echo_database_secrets(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(student.CollectionSettings, "from_env", classmethod(lambda cls: CollectionSettings(backend="sqlite")))

    def unavailable(*_):
        raise CollectionStorageError("private-test-credential-in-error")

    monkeypatch.setattr(student, "create_collection_store", unavailable)
    with pytest.raises(SystemExit) as raised:
        student.main(["--report", str(tmp_path / "report.json")])
    assert raised.value.code == 1
    captured = capsys.readouterr()
    assert "Student training failed." in captured.err
    assert "private-test" not in captured.out + captured.err
    assert "Traceback" not in captured.err


def test_extreme_numeric_input_is_safe_for_cli_and_portable_inference(tmp_path, capsys):
    source = tmp_path / "extreme.json"
    source.write_text(json.dumps({"predictions": [prediction(START, p24=10**400)]}))
    student.main(["--dataset", str(source), "--report", str(tmp_path / "report.json"),
                  "--model", str(tmp_path / "model.json")])
    report = json.loads(capsys.readouterr().out)
    assert report["status"] == "insufficient_data"
    assert report["dataQuality"]["excluded"]["invalid_or_stale_teacher"] == 1
    model = constant_model()
    model["biases"][-1][0] = 10**400
    teacher = prediction(START)["features"]["teacherForecast"]
    assert student.forecast(model, teacher, now=START + timedelta(minutes=1)) is None
