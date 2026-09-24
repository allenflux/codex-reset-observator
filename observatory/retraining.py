"""Replay a fixed retraining procedure using collected point-in-time snapshots.

This compares a frozen incumbent with daily retraining, not with a final model
that has already seen the evaluation outcomes. Detailed outputs stay local.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import tempfile
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .collection_config import CollectionSettings, create_collection_store
from .collection_store import CollectionStorageError
from .neural import (
    FEATURES,
    MODEL_PATH,
    SUPPORTED_MODEL_VERSIONS,
    _metrics,
    _predict_weights,
    eligible_events,
    make_samples,
    parse_time,
    train_model,
)
from .training_data import CollectionSource, _Timeline, build_training_dataset


class FrozenCollection:
    def __init__(self, dataset: dict[str, Any]) -> None:
        self.dataset = dataset

    def export_dataset(self) -> dict[str, Any]:
        return self.dataset


def compare_retraining(
    source: CollectionSource, incumbent: dict[str, Any], *, now: datetime | None = None,
    model_version: str = "reset-mlp-8-tanh-v2",
) -> dict[str, Any]:
    """Use one daily origin, full 48h follow-up and identical inputs per model."""
    if incumbent.get("modelVersion") not in SUPPORTED_MODEL_VERSIONS or incumbent.get("features") != FEATURES:
        raise ValueError("unsupported_incumbent_model")
    if model_version not in SUPPORTED_MODEL_VERSIONS:
        raise ValueError("unsupported_candidate_model")
    now = now or datetime.now(UTC)
    if now.tzinfo is None:
        raise ValueError("timezone_required")
    available_at = max(parse_time(incumbent["observedUntil"]), parse_time(incumbent["trainedAt"]))
    frozen = FrozenCollection(source.export_dataset())
    timeline = _Timeline(frozen, now)
    dataset = build_training_dataset(frozen, now=now)
    rows = [row for row in dataset["samples"] if parse_time(row["origin"]) >= available_at]
    predictions: dict[str, list[list[float]]] = {
        name: [] for name in ("incumbent", "daily_retraining", "empirical_frequency", "poisson_rate")}
    details = []
    with tempfile.TemporaryDirectory(prefix="cro-retraining-") as directory:
        path = Path(directory) / "candidate.json"
        for row in rows:
            origin = parse_time(row["origin"])
            history = timeline.known_at(origin)
            # Train/tune only from the history visible at this origin. The
            # eventual label for this origin is not supplied to the trainer.
            report = train_model(history, origin, path, model_version=model_version)
            model = json.loads(path.read_text())
            predictions["incumbent"].append(_predict_weights(incumbent, row["features"]))
            predictions["daily_retraining"].append(_predict_weights(model, row["features"]))
            events, _ = eligible_events(history, origin)
            matured = make_samples(events, origin)
            prior = [(sum(r["label"] == label for r in matured) + 1) / (len(matured) + 3)
                     for label in range(3)]
            predictions["empirical_frequency"].append(prior)
            rate = len(events) / ((origin - events[0]).total_seconds() / 86400 + 10)
            p24, p48 = 1 - math.exp(-rate), 1 - math.exp(-2 * rate)
            predictions["poisson_rate"].append([1-p48, p24, p48-p24])
            details.append({
                "origin": row["origin"], "sourceRunId": row["sourceRunId"], "label": row["label"],
                "outcomeRunId": row["outcomeRunId"], "sourceRevisionWarning": row["sourceRevisionWarning"],
                "candidateTrainingObservedUntil": report["observedUntil"],
                "candidateTrainingSampleCount": report["sampleCount"],
                "selectedAlpha": report["selectedAlpha"],
                "probabilities": {name: {"probability24h": values[-1][1],
                                         "probability48h": values[-1][1] + values[-1][2]}
                                  for name, values in predictions.items()},
            })
    scores = {name: _metrics(rows, values) for name, values in predictions.items()} if rows else {}
    return {
        "schemaVersion": 1, "mode": "point_in_time_retraining_replay", "generatedAt": now.isoformat(),
        "incumbentVersion": incumbent["modelVersion"], "candidateVersion": model_version,
        "incumbentAvailableAt": available_at.isoformat(),
        "incumbentSha256": hashlib.sha256(json.dumps(incumbent, sort_keys=True).encode()).hexdigest(),
        "sampleCount": len(rows), "start": rows[0]["origin"] if rows else None,
        "end": rows[-1]["origin"] if rows else None,
        "positives24h": sum(row["label"] == 1 for row in rows),
        "positives48h": sum(row["label"] != 0 for row in rows),
        "excludedBeforeIncumbentAvailable": dataset["sampleCount"] - len(rows),
        "censoredCounts": dict(Counter(row["reason"] for row in dataset["censored"])),
        "sourceRevisionWarningCount": sum(row["sourceRevisionWarning"] for row in rows),
        "metrics": scores, "predictions": details,
        "limitations": [*dataset["limitations"],
                        "Candidate scores describe daily retraining, not the final all-data model weights.",
                        "Each historical fit uses the snapshot known then; its older history is still retrospective.",
                        "Incumbent is scored on the same observed inputs and targets; these are replayed, not logged predictions.",
                        "Daily 48h outcomes overlap and the short observation window cannot establish reliable superiority."],
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, help="Frozen collection export; otherwise read the configured database")
    parser.add_argument("--save-snapshot", type=Path, help="Keep a local copy of the collection for exact replay")
    parser.add_argument("--incumbent", type=Path, default=MODEL_PATH)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        incumbent = json.loads(args.incumbent.read_text())
        if args.snapshot:
            dataset = json.loads(args.snapshot.read_text())
        else:
            with create_collection_store(CollectionSettings.from_env()) as store:
                dataset = store.export_dataset()
        if args.save_snapshot:
            args.save_snapshot.parent.mkdir(parents=True, exist_ok=True)
            args.save_snapshot.write_text(json.dumps(dataset, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        times = [parse_time(run["fetchedAt"]) for run in dataset["runs"] if run["status"] == "success"
                 and parse_time(run["fetchedAt"]) <= datetime.now(UTC)]
        if not times:
            raise ValueError("no_successful_collection")
        result = compare_retraining(FrozenCollection(dataset), incumbent, now=max(times))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        print(json.dumps({key: result[key] for key in ("sampleCount", "start", "end", "metrics", "censoredCounts")}, indent=2))
    except ImportError:
        print("Missing training dependency. Install with: uv sync --extra ml", file=sys.stderr)
        raise SystemExit(1) from None
    except (ValueError, OSError, KeyError, TypeError, CollectionStorageError):
        # Runtime connection errors can include credentials. Keep the CLI safe to share.
        print("Comparison failed. Check collection coverage, model, and configuration.", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
