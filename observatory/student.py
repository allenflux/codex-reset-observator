"""Portable pilot inference and a public, comparison-only model projection."""

from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .distillation import PILOT_MODEL_VERSION, forecast
from .neural import parse_time
from .teacher import teacher_status

MODEL_PATH = Path(__file__).with_name("data") / "teacher_student_pilot.json"
CONTEXT_FIELDS = (
    "resetTeaserStatus", "codexOperationalStatus", "officialNoticeActive",
    "noticeStartsAt", "noticeEndsAt", "latestPostAt", "latestPostClassification",
    "latestPostTeaserStrength", "isReply", "isQuote",
)
METRIC_FIELDS = (
    "mae24hPercentagePoints", "mae48hPercentagePoints", "meanMaePercentagePoints",
    "rmse24hPercentagePoints", "rmse48hPercentagePoints",
)


def input_context(teacher: dict[str, Any]) -> dict[str, Any]:
    """Keep contemporaneous inputs without the teacher's target probabilities."""
    context = teacher.get("context") or {}
    return {"checkedAt": teacher.get("checkedAt"), "fetchedAt": teacher.get("fetchedAt"),
            "lastRandomResetAt": teacher.get("lastRandomResetAt"), "sourceStale": teacher.get("sourceStale"),
            "context": {field: context.get(field) for field in CONTEXT_FIELDS}}


def _nonnegative(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def _metrics(value: Any) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    return {key: float(value[key]) for key in METRIC_FIELDS if _nonnegative(value.get(key))}


def _evaluation(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {"status": "not_available"}
    status = value.get("status")
    public: dict[str, Any] = {"status": status if status in {"pilot_holdout", "not_available"} else "not_available"}
    for key in ("trainSampleCount", "testSampleCount", "trainPostGroupCount", "testPostGroupCount"):
        if type(value.get(key)) is int and value[key] >= 0:
            public[key] = value[key]
    if public["status"] == "pilot_holdout":
        public["student"] = _metrics(value.get("student"))
        baselines = value.get("baselines")
        if isinstance(baselines, dict):
            public["baselines"] = {name: _metrics(baselines[name]) for name in (
                "training_mean", "previous_retained_hourly_teacher") if name in baselines}
    return public


def _metadata(model: dict[str, Any], fingerprint: str) -> dict[str, Any]:
    if model.get("modelVersion") != PILOT_MODEL_VERSION:
        raise ValueError("unsupported_student_model")
    public: dict[str, Any] = {
        "modelVersion": PILOT_MODEL_VERSION, "trainingMode": "pilot",
        "deploymentRole": "comparison_only", "experimental": True, "eligibleForUse": False,
        "target": "upstream_probability_imitation", "modelSha256": fingerprint,
        "trainedAt": parse_time(model["trainedAt"]).isoformat(),
        "observedUntil": parse_time(model["observedUntil"]).isoformat(),
        "sampleCount": model["sampleCount"], "observationSpanDays": model["observationSpanDays"],
        "evaluation": _evaluation(model.get("evaluation")),
    }
    if type(public["sampleCount"]) is not int or public["sampleCount"] < 1 or not _nonnegative(public["observationSpanDays"]):
        raise ValueError("invalid_student_metadata")
    if type(model.get("distinctUtcDays")) is int and model["distinctUtcDays"] >= 1:
        public["distinctUtcDays"] = model["distinctUtcDays"]
    digest = model.get("trainingDataSha256")
    if isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest):
        public["trainingDataSha256"] = digest
    return public


def student_forecast(teacher: Any, *, now: datetime | None = None,
                     model_path: Path | None = None) -> dict[str, Any]:
    """Model metadata remains visible while awaiting a fresh, post-training input."""
    now = now or datetime.now(UTC)
    result: dict[str, Any] = {
        "modelAvailable": False, "modelVersion": None, "available": False,
        "reason": "model_missing", "probability24h": None, "probability48h": None,
        "checkedAt": None, "fetchedAt": None,
    }
    path = model_path if model_path is not None else MODEL_PATH
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return result
    except OSError:
        return {**result, "reason": "model_unavailable"}
    try:
        model = json.loads(raw)
        if not isinstance(model, dict):
            raise ValueError("invalid_student_model")
        result.update(_metadata(model, hashlib.sha256(raw).hexdigest()), modelAvailable=True)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        return {**result, "reason": "model_invalid"}
    try:
        status = teacher_status(teacher, now)
        if not status["fresh"]:
            return {**result, "reason": f"context_{status['reason']}"}
        context = input_context(status["forecast"])
        result.update(checkedAt=context["checkedAt"], fetchedAt=context["fetchedAt"])
        if parse_time(context["checkedAt"]) < max(parse_time(model["trainedAt"]), parse_time(model["observedUntil"])):
            return {**result, "reason": "context_before_training"}
        prediction = forecast(model, context, now=now)
        if prediction is None:
            return {**result, "reason": "inference_unavailable"}
        return {**result, "available": True, "reason": "available",
                "probability24h": prediction["probability24h"], "probability48h": prediction["probability48h"]}
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        return {**result, "reason": "inference_unavailable"}
