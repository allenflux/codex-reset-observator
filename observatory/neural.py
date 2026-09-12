"""Small, regularized neural forecast with purged temporal evaluation.

Training uses sklearn. Deployment reads JSON weights and needs only Python's stdlib.
No social text, LLM, or future announcement fields enter the feature vector.
"""

from __future__ import annotations

import bisect
import hashlib
import json
import math
import statistics
import warnings
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).parent / "data"
MODEL_PATH = DATA_DIR / "neural_model.json"
MODEL_VERSION = "reset-mlp-8-tanh-v1"
FEATURES = [
    "log_days_since_reset", "log_previous_interval_days", "log_mean_last_3_intervals_days",
    "resets_last_7_days", "resets_last_30_days", "weekday_sin", "weekday_cos",
]
HORIZON = timedelta(hours=48)


def parse_time(value: str) -> datetime:
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("timezone_required")
    return result.astimezone(UTC)


def eligible_events(rows: list[dict[str, Any]], now: datetime) -> tuple[list[datetime], dict[str, Any]]:
    accepted: dict[str, datetime] = {}
    excluded: dict[str, int] = {}
    timestamp_seen: set[datetime] = set()
    for row in rows:
        reason = ""
        details = row.get("details") or {}
        key = str(row.get("id") or row.get("key") or "")
        try:
            date = parse_time(row.get("completed_at") or row.get("resetAt") or "")
        except (ValueError, TypeError):
            reason, date = "invalid_time", now
        if not reason:
            if not key or key in accepted or date in timestamp_seen:
                reason = "duplicate"
            elif date > now:
                reason = "future"
            elif row.get("recordKind") not in {"confirmed_global", "banked_distribution"}:
                reason = "reference_or_regular"
            elif details.get("cycleType") not in {"ランダムリセット", "随机重置", "Random reset"}:
                reason = "non_random_cycle"
            elif row.get("randomResetTargetScope") == "conditional":
                reason = "limited_scope"
            elif (row.get("scope") or details.get("scope")) not in {
                "全有料プラン", "全ユーザー", "所有付费套餐", "所有用户", "All paid plans", "All users",
                "Codex / ChatGPT Work",
            }:
                reason = "limited_or_unknown_scope"
        if reason:
            excluded[reason] = excluded.get(reason, 0) + 1
        else:
            accepted[key] = date
            timestamp_seen.add(date)
    events = sorted(accepted.values())
    return events, {
        "inputRecords": len(rows), "eligibleRandomEvents": len(events), "excluded": excluded,
        "firstEventAt": events[0].isoformat() if events else None,
        "lastEventAt": events[-1].isoformat() if events else None,
        "eligibleEventIds": sorted(accepted),
    }


def features_at(events: list[datetime], origin: datetime) -> list[float]:
    """Use only events at or before the forecast origin."""
    past = events[:bisect.bisect_right(events, origin)]
    if len(past) < 4:
        raise ValueError("at_least_four_past_resets_required")
    age = (origin - past[-1]).total_seconds() / 86400
    gaps = [(right - left).total_seconds() / 86400 for left, right in zip(past[-4:-1], past[-3:], strict=True)]
    weekday = origin.weekday() + origin.hour / 24
    return [
        math.log1p(age), math.log1p(gaps[-1]), math.log1p(statistics.mean(gaps)),
        float(sum(origin - time <= timedelta(days=7) for time in past)),
        float(sum(origin - time <= timedelta(days=30) for time in past)),
        math.sin(2 * math.pi * weekday / 7), math.cos(2 * math.pi * weekday / 7),
    ]


def make_samples(events: list[datetime], observed_until: datetime) -> list[dict[str, Any]]:
    if len(events) < 4:
        return []
    origin = events[3].replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    result = []
    # Labels with a full 48-hour follow-up only; the open tail is censored.
    while origin + HORIZON <= observed_until:
        later = bisect.bisect_right(events, origin)
        next_event = events[later] if later < len(events) else None
        label = 0  # no event in 48h
        if next_event and next_event <= origin + HORIZON:
            label = 1 if next_event <= origin + timedelta(hours=24) else 2
        result.append({"origin": origin, "features": features_at(events, origin), "label": label})
        origin += timedelta(hours=24)
    return result


def split_samples(samples: list[dict[str, Any]]) -> tuple[list[Any], list[Any], list[Any]]:
    if len(samples) < 45:
        raise ValueError("need_at_least_45_mature_daily_samples")
    validation_start = samples[int(len(samples) * .60)]["origin"]
    test_start = samples[int(len(samples) * .80)]["origin"]
    train = [row for row in samples if row["origin"] + HORIZON < validation_start]
    valid = [row for row in samples if validation_start <= row["origin"] and row["origin"] + HORIZON < test_start]
    test = [row for row in samples if row["origin"] >= test_start]
    return train, valid, test


def _predict_weights(model: dict[str, Any], values: list[float]) -> list[float]:
    if model.get("features") != FEATURES:
        raise ValueError("model_feature_schema_mismatch")
    activation = [(x - mean) / scale for x, mean, scale in zip(values, model["mean"], model["scale"], strict=True)]
    for index, (weights, bias) in enumerate(zip(model["weights"], model["biases"], strict=True)):
        activation = [
            offset + sum(activation[i] * weights[i][j] for i in range(len(activation)))
            for j, offset in enumerate(bias)
        ]
        if index < len(model["weights"]) - 1:
            activation = [math.tanh(x) for x in activation]
    if len(activation) != 3 or not all(math.isfinite(x) for x in activation):
        raise ValueError("invalid_model_output")
    exp = [math.exp(x - max(activation)) for x in activation]
    return [x / sum(exp) for x in exp]


def _metrics(rows: list[dict[str, Any]], probabilities: list[list[float]]) -> dict[str, float]:
    result = {}
    for hours in [24, 48]:
        predictions = [p[1] if hours == 24 else p[1] + p[2] for p in probabilities]
        targets = [float(row["label"] == 1 if hours == 24 else row["label"] != 0) for row in rows]
        result[f"brier{hours}h"] = statistics.mean((p-y)**2 for p, y in zip(predictions, targets, strict=True))
        result[f"logLoss{hours}h"] = statistics.mean(
            -y * math.log(max(p, 1e-8)) - (1-y) * math.log(max(1-p, 1e-8))
            for p, y in zip(predictions, targets, strict=True)
        )
    result["meanBrier"] = (result["brier24h"] + result["brier48h"]) / 2
    return result


def _fit(rows: list[dict[str, Any]], alpha: float) -> dict[str, Any]:
    import numpy as np
    from sklearn.exceptions import ConvergenceWarning
    from sklearn.neural_network import MLPClassifier
    from sklearn.preprocessing import StandardScaler

    y = np.array([row["label"] for row in rows])
    if set(y) != {0, 1, 2}:
        raise ValueError("all_three_outcome_classes_required_in_training")
    scaler = StandardScaler()
    x = scaler.fit_transform([row["features"] for row in rows])
    learner = MLPClassifier(hidden_layer_sizes=(8,), activation="tanh", solver="lbfgs",
                            alpha=alpha, max_iter=2000, random_state=42, tol=1e-7)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always", ConvergenceWarning)
        learner.fit(x, y)
    if any(issubclass(w.category, ConvergenceWarning) for w in caught):
        raise ValueError("neural_optimizer_did_not_converge")
    model = {"features": FEATURES, "mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist(),
             "weights": [w.tolist() for w in learner.coefs_],
             "biases": [b.tolist() for b in learner.intercepts_], "alpha": alpha,
             "classes": learner.classes_.tolist()}
    # Verify the portable implementation against the library, before saving weights.
    for row, expected in zip(rows, learner.predict_proba(x), strict=True):
        if max(abs(a-b) for a, b in zip(_predict_weights(model, row["features"]), expected, strict=True)) > 1e-10:
            raise ValueError("portable_inference_mismatch")
    return model


def train_model(rows: list[dict[str, Any]], observed_until: datetime,
                model_path: Path = MODEL_PATH, report_path: Path | None = None) -> dict[str, Any]:
    events, quality = eligible_events(rows, observed_until)
    samples = make_samples(events, observed_until)
    train, valid, test = split_samples(samples)
    # Hyperparameters are selected only on the middle period, never the final test period.
    candidates = []
    for alpha in [1.0, 10.0, 100.0]:
        model = _fit(train, alpha)
        score = _metrics(valid, [_predict_weights(model, row["features"]) for row in valid])
        candidates.append((score["meanBrier"], alpha, score))
    _, alpha, _ = min(candidates)
    test_start = test[0]["origin"]
    development = [row for row in samples if row["origin"] + HORIZON < test_start]
    evaluation_model = _fit(development, alpha)
    neural = [_predict_weights(evaluation_model, row["features"]) for row in test]
    # Two predeclared, inexpensive baselines fit only before the holdout starts.
    prior = [(sum(row["label"] == c for row in development) + 1) / (len(development) + 3) for c in range(3)]
    development_events = [event for event in events if event < test_start]
    span_days = (test_start - development_events[0]).total_seconds() / 86400
    rate = (len(development_events) - 1 + 1) / (span_days + 10)
    p24, p48 = 1-math.exp(-rate), 1-math.exp(-2*rate)
    baseline_scores = {
        "empirical_frequency": _metrics(test, [prior for _ in test]),
        "poisson_rate": _metrics(test, [[1-p48, p24, p48-p24] for _ in test]),
    }
    metrics = _metrics(test, neural)
    best_baseline = min(baseline_scores, key=lambda name: baseline_scores[name]["meanBrier"])
    score = baseline_scores[best_baseline]
    improvement = 1 - metrics["meanBrier"] / score["meanBrier"]
    qualified = all(metrics[f"brier{h}h"] < score[f"brier{h}h"] for h in [24, 48])
    # A good score on this small corrected historical snapshot is insufficient evidence
    # for automatic publication. Require a separate prospective collection before adoption.
    report = {
        "modelVersion": MODEL_VERSION, "trainedAt": datetime.now(UTC).isoformat(),
        "observedUntil": observed_until.isoformat(), "dataQuality": quality,
        "sampleCount": len(samples), "featureNames": FEATURES,
        "target": "At least one broad-scope random reset or banked distribution in the next 24/48 hours",
        "architecture": "7 inputs -> 8 tanh neurons -> 3 softmax classes (none/0-24h/24-48h)",
        "selectedAlpha": alpha, "randomSeed": 42, "originStepHours": 24, "purgeHours": 48,
        "splits": {name: {"count": len(part), "start": part[0]["origin"].isoformat(),
                          "end": part[-1]["origin"].isoformat(),
                          "positives24h": sum(row["label"] == 1 for row in part),
                          "positives48h": sum(row["label"] != 0 for row in part)}
                   for name, part in [("train", train), ("validation", valid), ("test", test)]},
        "validationCandidates": [{"alpha": a, **s} for _, a, s in candidates],
        "neural": metrics, "baselines": baseline_scores, "bestBaseline": best_baseline,
        "relativeBrierImprovement": improvement, "beatsBaselineBothHorizons": qualified,
        "eligibleForUse": False, "deploymentStatus": "experimental",
        "limitations": [
            "Only a few dozen independent reset events; daily rows are not independent new events.",
            "48h labels overlap; aggregate holdout metrics are descriptive, not significance tests.",
            "Published history may include retrospective corrections; no point-in-time discovery log is available.",
            "No event in a period is treated as a negative assuming site coverage is complete, which is unverified.",
            "No causal relation or exact next-reset time can be inferred from these records.",
            "Automatic adoption requires prospective verification on newly collected data.",
        ],
        "holdoutPredictions": [{"origin": row["origin"].isoformat(), "label": row["label"],
                                "probability24h": p[1], "probability48h": p[1]+p[2]}
                               for row, p in zip(test, neural, strict=True)],
    }
    final_model = _fit(samples, alpha)
    fingerprint = hashlib.sha256(json.dumps(rows, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    final_model.update({"modelVersion": MODEL_VERSION, "trainedAt": report["trainedAt"],
                        "observedUntil": report["observedUntil"], "trainingDataSha256": fingerprint,
                        "eligibleForUse": False, "evaluation": {"neural": metrics, "baseline": score,
                        "testSampleCount": len(test), "eventCount": len(events),
                        "relativeBrierImprovement": improvement}})
    model_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = model_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(final_model, indent=2, allow_nan=False) + "\n")
    temporary.replace(model_path)
    if report_path:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    return report


def forecast(rows: list[dict[str, Any]], now: datetime | None = None,
             model_path: Path = MODEL_PATH) -> dict[str, Any] | None:
    now = now or datetime.now(UTC)
    if not model_path.is_file():
        return None
    try:
        model = json.loads(model_path.read_text())
        if not isinstance(model, dict):
            return None
        if model.get("modelVersion") != MODEL_VERSION or now < parse_time(model["observedUntil"]):
            return None  # never leak a model fitted in the future into historical requests
        events, _ = eligible_events(rows, now)
        probabilities = _predict_weights(model, features_at(events, now))
        return {"modelVersion": MODEL_VERSION, "trainedAt": model["trainedAt"],
                "probability24h": probabilities[1], "probability48h": probabilities[1]+probabilities[2],
                "eligibleForUse": False, "evaluation": model["evaluation"]}
    except (OSError, ValueError, TypeError, KeyError, ArithmeticError, IndexError, AttributeError):
        return None
