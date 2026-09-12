"""Point-in-time datasets and delayed scoring from the append-only collection log.

Successful polling establishes coverage of the published source, not proof that
the source records every real reset. Historical backfills remain retrospective.
Nothing in this module fits a model or changes deployed weights.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from .neural import FEATURES, HORIZON, eligible_events, features_at, parse_time


class CollectionSource(Protocol):
    def export_dataset(self) -> dict[str, Any]: ...


LIMITATIONS = [
    "Successful polls cover the published history; upstream completeness is unverified.",
    "Initial history is a retrospective backfill, not prospective observation.",
    "Event execution times can be estimates and the source can revise its history.",
    "Overlapping 48-hour labels and repeated polls are not independent reset events.",
]


class _Timeline:
    def __init__(self, store: CollectionSource, now: datetime) -> None:
        self.dataset = store.export_dataset()
        self.runs = sorted(
            (run for run in self.dataset["runs"]
             if run["status"] == "success" and parse_time(run["fetchedAt"]) <= now),
            key=lambda run: (parse_time(run["fetchedAt"]), run["id"]),
        )
        self.times = [parse_time(run["fetchedAt"]) for run in self.runs]
        self.versions = {(row["eventKey"], row["contentHash"]): row
                         for row in self.dataset["eventVersions"]}
        self.revision_times = []
        previous: dict[str, str] = {}
        for index, run in enumerate(self.runs):
            current = {ref["eventKey"]: ref["contentHash"] for ref in run["eventVersions"]}
            changed = any(current.get(key) != digest for key, digest in previous.items())
            if index:
                # A new key whose execution predates an earlier successful poll
                # is a delayed report/backfill, which also merits a warning.
                for key in current.keys() - previous.keys():
                    event = self.versions[(key, current[key])]["data"]
                    at = event.get("completed_at") or event.get("resetAt")
                    if at and parse_time(at) < self.times[index - 1]:
                        changed = True
            if changed:
                self.revision_times.append(self.times[index])
            previous = current

    def history(self, index: int) -> list[dict[str, Any]]:
        if index < 0:
            return []
        return [dict(self.versions[(ref["eventKey"], ref["contentHash"])]["data"])
                for ref in self.runs[index]["eventVersions"]]

    def known_at(self, origin: datetime) -> list[dict[str, Any]]:
        return self.history(bisect_right(self.times, origin) - 1)

    def revisions_after(self, origin: datetime) -> bool:
        """Flag edits/removals to known keys; newly discovered keys are additions."""
        return bisect_right(self.revision_times, origin) < len(self.revision_times)

    def outcome(self, origin: datetime, now: datetime, max_gap: timedelta) -> dict[str, Any]:
        end = origin + HORIZON
        common = {"horizonEndAt": end.isoformat(), "label": None,
                  "sourceRevisionWarning": self.revisions_after(origin)}
        if now < end:
            return {**common, "status": "pending", "reason": "horizon_not_mature"}
        left = bisect_right(self.times, origin) - 1
        right = bisect_left(self.times, end)
        if left < 0:
            return {**common, "status": "unknown", "reason": "no_origin_snapshot"}
        if right >= len(self.times):
            return {**common, "status": "unknown", "reason": "incomplete_followup"}
        checkpoints = self.times[left:right + 1]
        if (origin - checkpoints[0] > max_gap or checkpoints[-1] - end > max_gap
                or any(b - a > max_gap for a, b in zip(checkpoints, checkpoints[1:]))):
            return {**common, "status": "unknown", "reason": "collection_gap"}
        # Freeze the target to the first source snapshot after the full horizon.
        # A reset first discovered days later cannot silently relabel a forecast.
        events, _ = eligible_events(self.history(right), self.times[right])
        targets = [event for event in events if origin < event <= end]
        label = 0 if not targets else 1 if targets[0] <= origin + timedelta(hours=24) else 2
        return {**common, "status": "scored", "reason": "observed_source_history",
                "label": label, "outcomeRunId": self.runs[right]["id"],
                "outcomeObservedAt": self.times[right].isoformat(),
                "firstTargetEventAt": targets[0].isoformat() if targets else None}


def _cutoff(now: datetime | None, max_gap_hours: float) -> tuple[datetime, timedelta]:
    if not 0 < max_gap_hours <= 48:
        raise ValueError("max_gap_hours_must_be_between_zero_and_48")
    until = now or datetime.now(UTC)
    if until.tzinfo is None:
        raise ValueError("timezone_required")
    return until.astimezone(UTC), timedelta(hours=max_gap_hours)


def get_training_history(
    store: CollectionSource,
) -> tuple[list[dict[str, Any]], datetime, dict[str, Any]]:
    """Latest canonical history for an explicitly retrospective training run.

    Existing ``neural.train_model`` reconstructs earlier features from this final
    corrected snapshot. It must not be presented as prospective validation.
    """
    timeline = _Timeline(store, datetime.now(UTC))
    if not timeline.runs:
        raise ValueError("no_successful_collection")
    run = timeline.runs[-1]
    rows = timeline.history(len(timeline.runs) - 1)
    versions = [timeline.versions[(ref["eventKey"], ref["contentHash"])]
                for ref in run["eventVersions"]]
    provenance = {
        "mode": "retrospective_latest_collected_history",
        "sourceRunId": run["id"], "observedUntil": run["fetchedAt"],
        "firstCollectedAt": timeline.runs[0]["fetchedAt"],
        "initialBackfillRecords": len(timeline.runs[0]["eventVersions"]),
        "eventFirstSeenAt": {row["eventKey"]: row["eventFirstSeenAt"] for row in versions},
        "limitations": [*LIMITATIONS,
                        "Latest corrected history may include facts unavailable at past training origins.",
                        "Retrospective training assumes coverage between historical events; collection gaps are not negative evidence."],
    }
    return rows, timeline.times[-1], provenance


def build_training_dataset(
    store: CollectionSource, *, now: datetime | None = None, max_gap_hours: float = 3,
) -> dict[str, Any]:
    """Export daily prospective rows with known-at-origin features and mature labels.

    The first successful poll of each UTC day is the origin. Unknown or immature
    labels are excluded from ``samples`` and retained in ``censored`` for audit.
    """
    now, max_gap = _cutoff(now, max_gap_hours)
    timeline = _Timeline(store, now)
    samples, censored = [], []
    dates_seen = set()
    for index, origin in enumerate(timeline.times):
        if origin.date() in dates_seen:
            continue
        dates_seen.add(origin.date())
        row = {"origin": origin.isoformat(), "sourceRunId": timeline.runs[index]["id"]}
        events, quality = eligible_events(timeline.history(index), origin)
        if len(events) < 4:
            censored.append({**row, "status": "unknown", "reason": "insufficient_past_events"})
            continue
        row.update({"features": features_at(events, origin),
                    "knownEventCount": quality["eligibleRandomEvents"],
                    **timeline.outcome(origin, now, max_gap)})
        if row["status"] == "scored":
            samples.append(row)
        else:
            censored.append(row)
    return {
        "schemaVersion": 1, "mode": "prospective_point_in_time",
        "generatedAt": now.isoformat(),
        "observedUntil": timeline.times[-1].isoformat() if timeline.times else None,
        "firstCollectedAt": timeline.times[0].isoformat() if timeline.times else None,
        "initialBackfillRecords": len(timeline.runs[0]["eventVersions"]) if timeline.runs else 0,
        "features": FEATURES, "horizonHours": 48, "maxPollGapHours": max_gap_hours,
        "sampleCount": len(samples), "samples": samples, "censored": censored,
        "limitations": LIMITATIONS,
    }


def score_archived_forecasts(
    store: CollectionSource, *, now: datetime | None = None, max_gap_hours: float = 3,
) -> list[dict[str, Any]]:
    """Score stored forecasts, preserving their original values and source cutoff."""
    now, max_gap = _cutoff(now, max_gap_hours)
    timeline = _Timeline(store, now)
    results = []
    runs = {run["id"]: run for run in timeline.runs}
    for prediction in timeline.dataset["predictions"]:
        origin = parse_time(prediction["timestamp"])
        if origin > now:
            continue
        row = {**prediction, **timeline.outcome(origin, now, max_gap)}
        source_run = runs.get(prediction["sourceRunId"])
        if source_run is None or parse_time(source_run["fetchedAt"]) > origin:
            row.update(status="unknown", reason="invalid_origin_source", label=None)
        elif origin - parse_time(source_run["fetchedAt"]) > max_gap:
            row.update(status="unknown", reason="stale_origin_snapshot", label=None)
        if row["status"] == "scored":
            p24, p48 = prediction["probability24h"], prediction["probability48h"]
            label = row["label"]
            row.update(target24h=int(label == 1), target48h=int(label != 0),
                       brier24h=(p24 - int(label == 1)) ** 2,
                       brier48h=(p48 - int(label != 0)) ** 2)
        results.append(row)
    return results
