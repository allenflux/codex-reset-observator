"""Train a local student from saved public forecasts, without calling an LLM.

Teacher probabilities are soft targets, never input features. Structured upstream
signals can themselves depend on the upstream site's semantic analysis. This
experiment measures imitation, not accuracy against actual reset outcomes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
import warnings
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .collection_config import CollectionSettings, create_collection_store
from .collection_store import CollectionStorageError
from .neural import parse_time
from .teacher import MAX_AGE_SECONDS

MODEL_VERSION = "teacher-student-mlp-v1"
PILOT_MODEL_VERSION = "teacher-student-mlp-pilot-v1"
TEACHER_VERSION = "upstream-public-forecast-v1"
DEFAULT_DIRECTORY = Path("var/training/teacher-student")
FEATURES = [
    "log_reset_age_days", "reset_age_unknown", "weekday_sin", "weekday_cos",
    "hour_sin", "hour_cos", "official_notice_active", "notice_start_days",
    "notice_start_unknown", "notice_end_days", "notice_end_unknown",
    "log_post_age_days", "post_age_unknown", "post_is_reply", "post_is_quote",
    "post_class_official_notice", "post_class_reset_executed", "post_class_teaser",
    "post_class_irrelevant", "post_class_unknown", "post_teaser_strong", "post_teaser_weak",
    "reset_teaser_present", "status_operational", "status_incident", "status_recovered", "status_unknown",
]
REQUIREMENTS: dict[str, Any] = {
    "minimumHourlySamples": 72, "minimumObservationSpanDays": 14,
    "minimumDistinctUtcDays": 14, "minimumDistinctTargets": 2,
    "minimumSplitSamples": {"train": 24, "validation": 8, "test": 8},
    "purgeHours": 24,
}
PILOT_REQUIREMENTS: dict[str, Any] = {
    "minimumHourlySamples": 24, "minimumObservationSpanDays": 1,
    "minimumDistinctTargets": 2, "evaluationMinimumSplitSamples": {"train": 24, "test": 8},
    "testHours": 24, "purgeHours": 24, "fixedAlpha": 100.0,
}
LIMITATIONS = [
    "The target is the source site's probability, not a confirmed reset outcome.",
    "Matching the teacher does not demonstrate better real-world reset prediction.",
    "Structured teacher signals may depend on upstream LLM analysis; this student makes no LLM calls.",
    "The public source does not expose its model version or every internal input.",
    "Hourly observations are correlated; their count is not the number of independent reset events.",
    "Final candidate weights include the holdout period; reported scores use a separate pre-holdout fit.",
    "This command never replaces the website's primary forecast or automatically publishes a model.",
]
PILOT_LIMITATIONS = LIMITATIONS + [
    "This explicitly requested pilot relaxes data-quantity requirements only for comparison deployment.",
    "Its fixed architecture and regularization are not selected using the pilot holdout.",
    "A short correlated holdout cannot establish generalization to new posts or future source algorithms.",
    "If too few held-out samples remain after excluding posts shared with training, no evaluation score is reported.",
    "The pilot is never eligible to replace the primary forecast, including during a source outage.",
]


def _optional_time(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValueError("invalid_teacher_time")
    return parse_time(value)


def features_at(teacher: dict[str, Any]) -> list[float]:
    """Read an explicit allowlist, excluding teacher probabilities and derived copy."""
    origin = parse_time(teacher["checkedAt"])
    context = teacher.get("context")
    if not isinstance(context, dict):
        raise ValueError("missing_teacher_context")
    reset = _optional_time(teacher.get("lastRandomResetAt"))
    post = _optional_time(context.get("latestPostAt"))
    if any(time is not None and time > origin for time in (reset, post)):
        raise ValueError("future_teacher_input")

    def age(time: datetime | None) -> float:
        return math.log1p((origin - time).total_seconds() / 86400) if time else 0.0

    def window(value: Any) -> tuple[float, float]:
        time = _optional_time(value)
        return (max(-30.0, min(30.0, (time - origin).total_seconds() / 86400)), 0.0) if time else (0.0, 1.0)

    start, start_unknown = window(context.get("noticeStartsAt"))
    end, end_unknown = window(context.get("noticeEndsAt"))
    weekday = origin.weekday() + origin.hour / 24
    hour = origin.hour + origin.minute / 60
    classification = context.get("latestPostClassification")
    strength = context.get("latestPostTeaserStrength")
    status = context.get("codexOperationalStatus")
    healthy = status in {"operational", "normal", "none"}
    incident = status in {"active", "degraded", "incident", "outage", "degraded_performance", "partial_outage", "major_outage"}
    recovered = status == "recovered"
    teaser = context.get("resetTeaserStatus")
    values = [
        age(reset), float(reset is None), math.sin(2 * math.pi * weekday / 7),
        math.cos(2 * math.pi * weekday / 7), math.sin(2 * math.pi * hour / 24),
        math.cos(2 * math.pi * hour / 24), float(context.get("officialNoticeActive") is True),
        start, start_unknown, end, end_unknown, age(post), float(post is None),
        float(context.get("isReply") is True), float(context.get("isQuote") is True),
        *[float(classification == name) for name in ("official_notice", "reset_executed", "teaser", "irrelevant")],
        float(classification not in {"official_notice", "reset_executed", "teaser", "irrelevant"}),
        float(strength == "strong"), float(strength == "weak"),
        float(teaser is not None and teaser not in {"none", "unknown", "unavailable"}),
        float(healthy), float(incident), float(recovered), float(not healthy and not incident and not recovered),
    ]
    if len(values) != len(FEATURES) or not all(math.isfinite(value) for value in values):
        raise ValueError("invalid_teacher_features")
    return values


def prepare_samples(dataset: dict[str, Any], *, now: datetime) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Use contemporaneously saved teacher inputs; never reconstruct old context."""
    if now.tzinfo is None:
        raise ValueError("timezone_required")
    predictions = dataset.get("predictions", [])
    if not isinstance(predictions, list):
        raise ValueError("invalid_collection_dataset")
    candidates: list[dict[str, Any]] = []
    excluded: Counter[str] = Counter()
    teacher_count = 0
    for prediction in predictions:
        if not isinstance(prediction, dict) or prediction.get("modelVersion") != TEACHER_VERSION:
            excluded["other_model"] += 1
            continue
        teacher_count += 1
        try:
            teacher = prediction["features"]["teacherForecast"]
            if not isinstance(teacher, dict) or teacher.get("sourceStale") is not False:
                raise ValueError("stale_or_unknown_source")
            origin = parse_time(teacher["checkedAt"])
            fetched = parse_time(teacher["fetchedAt"])
            if origin > now or fetched > now or fetched < origin:
                raise ValueError("future_or_inconsistent_observation")
            if (fetched - origin).total_seconds() > MAX_AGE_SECONDS:
                raise ValueError("source_expired_at_collection")
            targets = [teacher[f"probability{hours}h"] for hours in (24, 48)]
            if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                   for value in targets) or not 0 <= targets[0] <= targets[1] <= 1:
                raise ValueError("invalid_teacher_probabilities")
            values = features_at(teacher)
            post = _optional_time(teacher["context"].get("latestPostAt"))
            candidates.append({"origin": origin, "availableAt": fetched, "features": values,
                               "targets": targets, "postAt": post.isoformat() if post else None})
        except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
            # Avoid echoing raw upstream values or configuration in data-quality reports.
            excluded["invalid_or_stale_teacher"] += 1
    candidates.sort(key=lambda row: (row["origin"], row["availableAt"]))
    seen_times: set[datetime] = set()
    seen_hours: set[datetime] = set()
    samples: list[dict[str, Any]] = []
    for row in candidates:
        origin = row["origin"]
        hour = origin.replace(minute=0, second=0, microsecond=0)
        if origin in seen_times:
            excluded["duplicate_checked_at"] += 1
            continue
        seen_times.add(origin)
        if hour in seen_hours:
            excluded["same_utc_hour"] += 1
            continue
        seen_hours.add(hour)
        samples.append(row)
    span = (samples[-1]["origin"] - samples[0]["origin"]).total_seconds() / 86400 if samples else 0.0
    return samples, {
        "inputPredictionCount": len(predictions), "teacherPredictionCount": teacher_count,
        "hourlySampleCount": len(samples), "distinctUtcDays": len({row["origin"].date() for row in samples}),
        "observationSpanDays": span, "distinctTargets": len({tuple(row["targets"]) for row in samples}),
        "firstCheckedAt": samples[0]["origin"].isoformat() if samples else None,
        "lastCheckedAt": samples[-1]["origin"].isoformat() if samples else None,
        "excluded": dict(excluded),
    }


def split_samples(samples: list[dict[str, Any]]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, int]]:
    """Chronological day blocks with a 24h gap and no shared nonempty post ID."""
    days = sorted({row["origin"].date() for row in samples})
    parts: dict[str, list[dict[str, Any]]] = {name: [] for name in ("train", "validation", "test")}
    purged: Counter[str] = Counter()
    if len(days) < 5:
        return parts, {"not_enough_days_to_split": len(samples)}
    valid_start = datetime.combine(days[int(len(days) * .6)], datetime.min.time(), UTC)
    test_start = datetime.combine(days[int(len(days) * .8)], datetime.min.time(), UTC)
    gap = timedelta(hours=REQUIREMENTS["purgeHours"])
    for row in samples:
        origin, available = row["origin"], row["availableAt"]
        if origin < valid_start:
            name, boundary = "train", valid_start
        elif origin < test_start:
            name, boundary = "validation", test_start
        else:
            parts["test"].append(row)
            continue
        if max(origin, available) + gap > boundary:
            purged["time_boundary"] += 1
        else:
            parts[name].append(row)
    post_partition: dict[str, str] = {}
    for name, rows in parts.items():
        kept = []
        for row in rows:
            post = row["postAt"]
            if post and post_partition.setdefault(post, name) != name:
                purged["post_shared_with_earlier_split"] += 1
            else:
                kept.append(row)
        parts[name] = kept
    return parts, dict(purged)


def split_pilot_samples(samples: list[dict[str, Any]]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, int]]:
    """Fixed trailing 24h test, 24h purge, excluding posts present in training."""
    parts: dict[str, list[dict[str, Any]]] = {"train": [], "test": []}
    purged: Counter[str] = Counter()
    if not samples:
        return parts, {}
    test_start = max(row["origin"] for row in samples) - timedelta(hours=PILOT_REQUIREMENTS["testHours"])
    gap = timedelta(hours=PILOT_REQUIREMENTS["purgeHours"])
    for row in samples:
        if row["origin"] > test_start:
            parts["test"].append(row)
        elif max(row["origin"], row["availableAt"]) + gap <= test_start:
            parts["train"].append(row)
        else:
            purged["time_boundary"] += 1
    training_posts = {row["postAt"] for row in parts["train"] if row["postAt"]}
    kept = []
    for row in parts["test"]:
        if row["postAt"] and row["postAt"] in training_posts:
            purged["post_shared_with_training"] += 1
        else:
            kept.append(row)
    parts["test"] = kept
    return parts, dict(purged)


def _logit(value: float) -> float:
    value = min(1 - 1e-6, max(1e-6, value))
    return math.log(value / (1 - value))


def _probabilities(logits: list[float]) -> list[float]:
    p24, extra = [1 / (1 + math.exp(-max(-700.0, min(700.0, value)))) for value in logits]
    return [p24, p24 + (1 - p24) * extra]


def _portable_logits(model: dict[str, Any], values: list[float]) -> list[float]:
    if model.get("features") != FEATURES or len(values) != len(FEATURES):
        raise ValueError("student_feature_schema_mismatch")
    activation = [(value - mean) / scale for value, mean, scale in zip(values, model["mean"], model["scale"], strict=True)]
    for index, (weights, biases) in enumerate(zip(model["weights"], model["biases"], strict=True)):
        activation = [bias + sum(value * weight[j] for value, weight in zip(activation, weights, strict=True))
                      for j, bias in enumerate(biases)]
        if index < len(model["weights"]) - 1:
            activation = [math.tanh(value) for value in activation]
    if len(activation) != 2 or not all(math.isfinite(value) for value in activation):
        raise ValueError("invalid_student_output")
    return activation


def _predict(model: dict[str, Any], values: list[float]) -> list[float]:
    return _probabilities(_portable_logits(model, values))


def forecast(model: dict[str, Any], teacher_context: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any] | None:
    """Portable candidate inference; historical use before model availability is refused."""
    now = now or datetime.now(UTC)
    try:
        version = model.get("modelVersion")
        if now.tzinfo is None or version not in {MODEL_VERSION, PILOT_MODEL_VERSION}:
            return None
        origin = parse_time(teacher_context["checkedAt"])
        fetched = parse_time(teacher_context["fetchedAt"])
        available = max(parse_time(model["trainedAt"]), parse_time(model["observedUntil"]))
        if origin < available or origin > now or fetched > now or fetched < origin:
            return None
        if max((now - origin).total_seconds(), (now - fetched).total_seconds()) > MAX_AGE_SECONDS:
            return None
        if teacher_context.get("sourceStale") is not False:
            return None
        p24, p48 = _predict(model, features_at(teacher_context))
        return {"modelVersion": version, "probability24h": p24, "probability48h": p48,
                "experimental": True, "eligibleForUse": False,
                "target": "upstream_probability_imitation", "deploymentRole": "comparison_only",
                **{key: model.get(key) for key in ("trainedAt", "observedUntil", "sampleCount", "trainingMode",
                   "observationSpanDays", "distinctUtcDays", "trainingDataSha256", "evaluation")}}
    except (ValueError, TypeError, KeyError, IndexError, ZeroDivisionError, OverflowError):
        return None


def _fit(rows: list[dict[str, Any]], alpha: float) -> dict[str, Any]:
    import numpy as np
    from sklearn.exceptions import ConvergenceWarning
    from sklearn.neural_network import MLPRegressor
    from sklearn.preprocessing import StandardScaler

    scaler = StandardScaler()
    x = scaler.fit_transform([row["features"] for row in rows])
    targets = np.array([[_logit(p24), _logit((p48 - p24) / (1 - p24) if p24 < 1 else 0.0)]
                        for p24, p48 in (row["targets"] for row in rows)])
    learner = MLPRegressor(hidden_layer_sizes=(8,), activation="tanh", solver="adam",
                           alpha=alpha, random_state=42, max_iter=10000, tol=1e-5,
                           n_iter_no_change=30, early_stopping=False)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always", ConvergenceWarning)
        learner.fit(x, targets)
    if any(issubclass(warning.category, ConvergenceWarning) for warning in caught):
        raise ValueError("student_optimizer_did_not_converge")
    model = {"features": FEATURES, "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
             "weights": [weights.tolist() for weights in learner.coefs_],
             "biases": [bias.tolist() for bias in learner.intercepts_], "alpha": alpha}
    for row, expected in zip(rows, learner.predict(x), strict=True):
        if max(abs(a - b) for a, b in zip(_portable_logits(model, row["features"]), expected, strict=True)) > 1e-10:
            raise ValueError("student_portable_inference_mismatch")
    return model


def _metrics(rows: list[dict[str, Any]], predictions: list[list[float]]) -> dict[str, float]:
    scores = {}
    for index, hours in enumerate((24, 48)):
        errors = [100 * (prediction[index] - row["targets"][index])
                  for row, prediction in zip(rows, predictions, strict=True)]
        scores[f"mae{hours}hPercentagePoints"] = statistics.mean(abs(error) for error in errors)
        scores[f"rmse{hours}hPercentagePoints"] = math.sqrt(statistics.mean(error ** 2 for error in errors))
    scores["meanMaePercentagePoints"] = statistics.mean(scores[f"mae{hours}hPercentagePoints"] for hours in (24, 48))
    return scores


def _save(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
    temporary.replace(path)


def _pilot_train(dataset: dict[str, Any], *, model_path: Path, report_path: Path,
                 now: datetime) -> dict[str, Any]:
    samples, quality = prepare_samples(dataset, now=now)
    parts, purged = split_pilot_samples(samples)
    fields = [("hourlySampleCount", "minimumHourlySamples"),
              ("observationSpanDays", "minimumObservationSpanDays"),
              ("distinctTargets", "minimumDistinctTargets")]
    reasons = [requirement for field, requirement in fields if quality[field] < PILOT_REQUIREMENTS[requirement]]
    formal_parts, _ = split_samples(samples)
    unmet_formal = [requirement for field, requirement in fields + [("distinctUtcDays", "minimumDistinctUtcDays")]
                   if quality[field] < REQUIREMENTS[requirement]]
    unmet_formal.extend(f"minimum_{name}_samples_after_purging"
                       for name, minimum in REQUIREMENTS["minimumSplitSamples"].items() if len(formal_parts[name]) < minimum)
    evaluation_reasons = [f"minimum_{name}_samples_after_purging"
                          for name, minimum in PILOT_REQUIREMENTS["evaluationMinimumSplitSamples"].items()
                          if len(parts[name]) < minimum]
    evaluation: dict[str, Any] = {
        "status": "not_available", "reasons": evaluation_reasons,
        "trainSampleCount": len(parts["train"]), "testSampleCount": len(parts["test"]),
        "trainPostGroupCount": len({row["postAt"] for row in parts["train"] if row["postAt"]}),
        "testPostGroupCount": len({row["postAt"] for row in parts["test"] if row["postAt"]}),
    }
    report: dict[str, Any] = {
        "schemaVersion": 1, "modelVersion": PILOT_MODEL_VERSION, "teacherModelVersion": TEACHER_VERSION,
        "generatedAt": now.isoformat(), "status": "insufficient_data", "modelWritten": False,
        "trainingMode": "pilot", "deploymentRole": "comparison_only", "experimental": True,
        "eligibleForUse": False, "target": "upstream_probability_imitation", "requirements": PILOT_REQUIREMENTS,
        "validationRequirements": REQUIREMENTS, "unmetValidationRequirements": unmet_formal,
        "dataQuality": quality, "reasons": reasons, "featureNames": FEATURES,
        "splitMethod": "Fixed trailing (last source time - 24h, last source time] test, 24h boundary purge; exclude test posts seen in training",
        "purged": purged, "limitations": PILOT_LIMITATIONS, "evaluation": evaluation,
        "splits": {name: {"count": len(rows), "start": rows[0]["origin"].isoformat() if rows else None,
                          "end": rows[-1]["origin"].isoformat() if rows else None} for name, rows in parts.items()},
    }
    if reasons:
        report["message"] = "Not enough distinct observations for even the comparison-only pilot; no new weights were written."
        _save(report_path, report)
        return report

    alpha = PILOT_REQUIREMENTS["fixedAlpha"]
    report.update(status="trained_pilot", selectedAlpha=alpha, randomSeed=42,
                  alphaSelection="Fixed before evaluation; no tuning on this dataset")
    if not evaluation_reasons:
        train, test = parts["train"], parts["test"]
        fitted = _fit(train, alpha)
        test_predictions = [_predict(fitted, row["features"]) for row in test]
        mean = [statistics.mean(row["targets"][index] for row in train) for index in (0, 1)]
        persistence = []
        for row in test:
            past = [sample for sample in samples if sample["origin"] < row["origin"] and sample["availableAt"] <= row["origin"]]
            persistence.append(past[-1]["targets"] if past else train[-1]["targets"])
        metrics = _metrics(test, test_predictions)
        baselines = {"training_mean": _metrics(test, [mean for _ in test]),
                     "previous_retained_hourly_teacher": _metrics(test, persistence)}
        evaluation.update(status="pilot_holdout", student=metrics, baselines=baselines)
        report.update(student=metrics, baselines=baselines,
                      persistenceDefinition="Latest strictly earlier retained hourly teacher value available by the test origin; never the current target")
        report["holdoutPredictions"] = [
            {"checkedAt": row["origin"].isoformat(), "teacher24h": row["targets"][0], "teacher48h": row["targets"][1],
             "student24h": values[0], "student48h": values[1]}
            for row, values in zip(test, test_predictions, strict=True)
        ]
    final_model = _fit(samples, alpha)
    canonical = [{**row, "origin": row["origin"].isoformat(), "availableAt": row["availableAt"].isoformat()}
                 for row in samples]
    final_model.update({
        "modelVersion": PILOT_MODEL_VERSION, "teacherModelVersion": TEACHER_VERSION,
        "trainedAt": datetime.now(UTC).isoformat(), "observedUntil": max(row["availableAt"] for row in samples).isoformat(),
        "trainingMode": "pilot", "deploymentRole": "comparison_only", "experimental": True,
        "trainingDataSha256": hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest(),
        "sampleCount": len(samples), "observationSpanDays": quality["observationSpanDays"],
        "distinctUtcDays": quality["distinctUtcDays"], "eligibleForUse": False,
        "target": "upstream_probability_imitation", "evaluation": evaluation,
        "validationRequirements": REQUIREMENTS, "unmetValidationRequirements": unmet_formal,
        "requirements": PILOT_REQUIREMENTS, "limitations": PILOT_LIMITATIONS,
    })
    report.update(modelWritten=True, trainingDataSha256=final_model["trainingDataSha256"],
                  trainedAt=final_model["trainedAt"], observedUntil=final_model["observedUntil"])
    _save(model_path, final_model)
    _save(report_path, report)
    return report


def train_student(dataset: dict[str, Any], *, model_path: Path = DEFAULT_DIRECTORY / "model.json",
                  report_path: Path = DEFAULT_DIRECTORY / "report.json", now: datetime | None = None,
                  pilot: bool = False) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    if pilot:
        return _pilot_train(dataset, model_path=model_path, report_path=report_path, now=now)
    samples, quality = prepare_samples(dataset, now=now)
    parts, purged = split_samples(samples)
    reasons = []
    for field, requirement in [("hourlySampleCount", "minimumHourlySamples"),
                               ("observationSpanDays", "minimumObservationSpanDays"),
                               ("distinctUtcDays", "minimumDistinctUtcDays"),
                               ("distinctTargets", "minimumDistinctTargets")]:
        if quality[field] < REQUIREMENTS[requirement]:
            reasons.append(requirement)
    for name, minimum in REQUIREMENTS["minimumSplitSamples"].items():
        if len(parts[name]) < minimum:
            reasons.append(f"minimum_{name}_samples_after_purging")
    report: dict[str, Any] = {
        "schemaVersion": 1, "modelVersion": MODEL_VERSION, "teacherModelVersion": TEACHER_VERSION,
        "generatedAt": now.isoformat(), "status": "insufficient_data", "modelWritten": False,
        "eligibleForUse": False, "target": "upstream_probability_imitation", "requirements": REQUIREMENTS,
        "dataQuality": quality, "reasons": reasons, "featureNames": FEATURES,
        "splitMethod": "UTC days 60/20/20, 24h boundary purge, shared nonempty post times kept only in earliest split",
        "purged": purged, "limitations": LIMITATIONS,
        "splits": {name: {"count": len(rows), "start": rows[0]["origin"].isoformat() if rows else None,
                          "end": rows[-1]["origin"].isoformat() if rows else None} for name, rows in parts.items()},
    }
    if reasons:
        report["message"] = "Not enough distinct, contemporaneous teacher observations; no new weights were written."
        _save(report_path, report)
        return report
    candidates = []
    for alpha in (1.0, 10.0, 100.0):
        fitted = _fit(parts["train"], alpha)
        score = _metrics(parts["validation"], [_predict(fitted, row["features"]) for row in parts["validation"]])
        candidates.append({"alpha": alpha, **score})
    alpha = min(candidates, key=lambda score: score["meanMaePercentagePoints"])["alpha"]
    development = parts["train"] + parts["validation"]
    evaluation = _fit(development, alpha)
    test = parts["test"]
    test_predictions = [_predict(evaluation, row["features"]) for row in test]
    mean = [statistics.mean(row["targets"][index] for row in development) for index in (0, 1)]
    persistence = []
    for row in test:
        past = [sample for sample in samples if sample["origin"] < row["origin"] and sample["availableAt"] <= row["origin"]]
        persistence.append(past[-1]["targets"] if past else development[-1]["targets"])
    metrics = _metrics(test, test_predictions)
    report.update({
        "status": "trained_candidate", "modelWritten": True, "selectedAlpha": alpha,
        "randomSeed": 42, "validationCandidates": candidates, "student": metrics,
        "baselines": {"development_mean": _metrics(test, [mean for _ in test]),
                      "previous_retained_hourly_teacher": _metrics(test, persistence)},
        "persistenceDefinition": "Latest strictly earlier retained hourly teacher value available by each test origin; never the current target",
        "holdoutPredictions": [{"checkedAt": row["origin"].isoformat(),
                                "teacher24h": row["targets"][0], "teacher48h": row["targets"][1],
                                "student24h": values[0], "student48h": values[1]}
                               for row, values in zip(test, test_predictions, strict=True)],
    })
    final_model = _fit(samples, alpha)
    canonical = [{**row, "origin": row["origin"].isoformat(), "availableAt": row["availableAt"].isoformat()}
                 for row in samples]
    final_model.update({
        "modelVersion": MODEL_VERSION, "teacherModelVersion": TEACHER_VERSION,
        "trainedAt": datetime.now(UTC).isoformat(), "observedUntil": max(row["availableAt"] for row in samples).isoformat(),
        "trainingDataSha256": hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest(),
        "sampleCount": len(samples), "eligibleForUse": False, "target": "upstream_probability_imitation",
        "evaluation": {"student": metrics, "baselines": report["baselines"], "testSampleCount": len(test)},
    })
    _save(model_path, final_model)
    _save(report_path, report)
    return report


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, help="Frozen collection export; otherwise read configured MySQL")
    parser.add_argument("--model", type=Path, default=DEFAULT_DIRECTORY / "model.json")
    parser.add_argument("--report", type=Path, default=DEFAULT_DIRECTORY / "report.json")
    parser.add_argument("--pilot", action="store_true", help="Explicit small-data comparison-only pilot; never eligible as primary")
    args = parser.parse_args(argv)
    try:
        if args.dataset:
            dataset = json.loads(args.dataset.read_text())
        else:
            with create_collection_store(CollectionSettings.from_env()) as store:
                dataset = store.export_dataset()
        report = train_student(dataset, model_path=args.model, report_path=args.report, pilot=args.pilot)
        print(json.dumps({key: report[key] for key in ("status", "modelWritten", "dataQuality", "reasons", "requirements")}, indent=2))
    except ImportError:
        print("Missing training dependency. Install with: uv sync --extra ml", file=sys.stderr)
        raise SystemExit(1) from None
    except (ValueError, OSError, KeyError, TypeError, AttributeError, OverflowError, CollectionStorageError):
        print("Student training failed. Check the dataset and collection configuration.", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
