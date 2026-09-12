"""Periodic collection worker; durable data goes to the configured database only."""

from __future__ import annotations

import hashlib
import json
import signal
import tempfile
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from observatory.collection_config import CollectionSettings, create_collection_store
from observatory.domain import build_snapshot, load_data
from observatory.history_sync import HISTORY_URL, sync_history
from observatory.neural import FEATURES, MODEL_PATH, eligible_events, features_at, parse_time
from observatory.probability import MODEL_VERSION as BASELINE_MODEL_VERSION


def fetch_source() -> tuple[list[dict[str, Any]], dict[str, Any]]:
    # The legacy importer can write an explicit directory. Keep all intermediate
    # files ephemeral: running the worker never rewrites package/repository data.
    with tempfile.TemporaryDirectory(prefix="observatory-source-") as directory:
        target = Path(directory)
        metadata = sync_history(target)
        rows = json.loads((target / "online_history.json").read_text())
        return rows, metadata


def collect_once(
    settings: CollectionSettings,
    *,
    store: Any = None,
    fetcher: Callable[[], tuple[list[dict[str, Any]], dict[str, Any]]] = fetch_source,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    snapshot_builder: Callable[..., dict[str, Any]] = build_snapshot,
) -> dict[str, Any]:
    owned = store is None
    try:
        store = store or create_collection_store(settings)
        try:
            rows, metadata = fetcher()
            observed_at = clock()
            # A source-provided historical timestamp must not become firstSeenAt.
            run_id = store.record_success(rows, fetched_at=observed_at, source_metadata=metadata)
        except Exception:
            try:
                store.record_failure(fetched_at=clock(), error_code="source_collection_failed",
                                     source_metadata={"sourceUrl": HISTORY_URL})
            except Exception:
                pass
            return {"ok": False, "error": "source_collection_failed"}

        predictions = 0
        prediction_status = "saved"
        try:
            data = load_data()
            data["reset_history"] = rows
            view = snapshot_builder(data, locale="zh", now=observed_at)["viewModel"]
            events, quality = eligible_events(rows, observed_at)
            vector = features_at(events, observed_at) if len(events) >= 4 else None
            common = {"featureNames": FEATURES, "featureValues": vector,
                      "eligibleEventCount": len(events), "eventCount": len(rows),
                      "historySha256": hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest(),
                      "source": "collected_public_history", "quality": quality,
                      "forecastContext": "collector_public_history_with_bundled_context",
                      "includesRuntimeWebhookSignals": False,
                      "featureVectorPurpose": "neural_history_features"}
            baseline = view.get("statisticalBaseline") or view
            store.record_prediction(timestamp=observed_at, probability24h=baseline["probability24h"],
                                    probability48h=baseline["probability48h"], model_version=BASELINE_MODEL_VERSION,
                                    features={**common, "forecastKind": "statistical_baseline"}, source_run_id=run_id)
            predictions += 1
            neural = view.get("neuralForecast")
            if neural:
                fingerprint = hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest() if MODEL_PATH.is_file() else None
                store.record_prediction(timestamp=observed_at, probability24h=neural["probability24h"],
                                        probability48h=neural["probability48h"], model_version=neural["modelVersion"],
                                        features={**common, "forecastKind": "neural_experiment",
                                                  "trainedAt": neural["trainedAt"], "modelSha256": fingerprint},
                                        source_run_id=run_id)
                predictions += 1
        except Exception:
            # Preserve the valid source snapshot even if prediction generation fails.
            prediction_status = "failed"
        return {"ok": True, "runId": run_id, "observedAt": observed_at.isoformat(),
                "eventCount": len(rows), "predictionCount": predictions, "predictionStatus": prediction_status}
    except Exception:
        return {"ok": False, "error": "collection_database_unavailable"}
    finally:
        if owned and store is not None:
            store.close()


def collection_status(settings: CollectionSettings) -> dict[str, Any]:
    with create_collection_store(settings) as store:
        status = store.get_status()
    latest = status.get("latestSuccessfulAt")
    age = (datetime.now(UTC) - parse_time(latest)).total_seconds() if latest else None
    return {**status, "backend": settings.backend, "intervalSeconds": settings.interval_seconds,
            "fresh": age is not None and 0 <= age <= settings.interval_seconds * 3,
            "ageSeconds": round(age) if age is not None else None}


def run_collector(settings: CollectionSettings) -> None:
    from observatory.notification_worker import notify_once
    from observatory.notifications import NotificationSettings
    from observatory.social_sync import collect_social_once

    notifications = NotificationSettings.from_env()
    stopping = threading.Event()
    for name in (signal.SIGINT, signal.SIGTERM):
        signal.signal(name, lambda *_: stopping.set())
    next_history = next_social = 0.0
    next_notifications = 0.0
    while not stopping.is_set():
        if settings.social_enabled and time.monotonic() >= next_social:
            result = collect_social_once(settings)
            print(json.dumps({"event": "social_collection", **result}), flush=True)
            delay = settings.social_interval_seconds if result["ok"] else min(60, settings.social_interval_seconds)
            next_social = time.monotonic() + delay
            if result["ok"] and (result.get("newPosts", 0) or result.get("updatedPosts", 0)):
                # A changed post prompts an authoritative history fetch; its
                # text/classification does not itself confirm a reset.
                next_history = 0.0
        if stopping.is_set():
            break
        if time.monotonic() >= next_history:
            result = collect_once(settings)
            print(json.dumps({"event": "collection", **result}), flush=True)
            delay = settings.interval_seconds if result["ok"] else min(300, settings.interval_seconds)
            next_history = time.monotonic() + delay
            if result["ok"]:
                next_notifications = 0.0
        if stopping.is_set():
            break
        if notifications.enabled and time.monotonic() >= next_notifications:
            result = notify_once(settings, notifications)
            print(json.dumps({"event": "reset_notifications", **result}), flush=True)
            next_notifications = time.monotonic() + notifications.interval_seconds
        wake_at = min(next_history, next_social) if settings.social_enabled else next_history
        if notifications.enabled:
            wake_at = min(wake_at, next_notifications)
        stopping.wait(max(0, wake_at - time.monotonic()))
