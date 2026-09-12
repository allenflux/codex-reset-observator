"""Command-line entry points; nothing contacts external services on import."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import httpx

from observatory.collection_store import CollectionStorageError


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Python Codex Reset Observatory")
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve", help="Start the multilingual website")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--reload", action="store_true")
    snapshot = commands.add_parser("snapshot", help="Print an offline public snapshot")
    snapshot.add_argument("--locale", choices=["ja", "en", "zh"], default="zh")
    snapshot.add_argument("--at", help="ISO date/time; defaults to current UTC time")
    classify = commands.add_parser("classify", help="Classify text with rules; no LLM")
    classify.add_argument("text")
    commands.add_parser("sync-history", help="Collect online history into the configured database")
    collect = commands.add_parser("collect", help="Continuously accumulate online history and forecasts")
    collect.add_argument("--once", action="store_true")
    status = commands.add_parser("collection-status", help="Show accumulation counts and freshness")
    status.add_argument("--check-fresh", action="store_true")
    export = commands.add_parser("export-training", help="Export point-in-time training data (never into Git)")
    export.add_argument("--output", type=Path)
    scoring = commands.add_parser("score-forecasts", help="Evaluate matured collected forecasts after 48h")
    scoring.add_argument("--output", type=Path)
    train = commands.add_parser("train", help="Train/evaluate the small neural network (install [ml])")
    train.add_argument("--history", type=Path, help="Optional file override; default reads the configured database")
    train.add_argument("--observed-until", help="End of verified observation coverage (ISO time)")
    train.add_argument("--model", type=Path)
    train.add_argument("--report", type=Path)
    monitor = commands.add_parser("monitor-usage", help="Poll the local Codex CLI and send minimal quota snapshots")
    monitor.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    try:
        from observatory.collection_config import CollectionSettings, create_collection_store
        configuration = CollectionSettings.from_env()
        if args.command == "serve":
            import uvicorn
            uvicorn.run("observatory.app:app", host=args.host, port=args.port, reload=args.reload)
        elif args.command == "snapshot":
            from observatory.domain import build_snapshot, load_data
            from observatory.neural import parse_time
            now = parse_time(args.at) if args.at else datetime.now(UTC)
            print(json.dumps(build_snapshot(load_data(), args.locale, now), ensure_ascii=False, indent=2))
        elif args.command == "classify":
            from observatory.domain import classify_post
            print(json.dumps(classify_post(args.text), ensure_ascii=False, indent=2))
        elif args.command == "sync-history":
            from observatory.collector import collect_once
            result = collect_once(configuration)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            if not result["ok"]:
                raise SystemExit(1)
        elif args.command == "collect":
            from observatory.collector import collect_once, run_collector
            if args.once:
                result = collect_once(configuration)
                print(json.dumps(result, ensure_ascii=False, indent=2))
                if not result["ok"]:
                    raise SystemExit(1)
            else:
                run_collector(configuration)
        elif args.command == "collection-status":
            from observatory.collector import collection_status
            result = collection_status(configuration)
            print(json.dumps(result, indent=2))
            if args.check_fresh and not result["fresh"]:
                raise SystemExit(1)
        elif args.command in {"export-training", "score-forecasts"}:
            from observatory.training_data import build_training_dataset, score_archived_forecasts
            with create_collection_store(configuration) as store:
                if args.command == "export-training":
                    result = build_training_dataset(store)
                    name = "prospective-dataset.json"
                else:
                    result = {"forecasts": score_archived_forecasts(store)}
                    name = "forecast-scores.json"
            target = args.output or configuration.output_dir / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
            print(f"Saved: {target}")
        elif args.command == "train":
            from observatory.neural import parse_time, train_model
            from observatory.training_data import get_training_history
            provenance = None
            if args.history:
                metadata = args.history.with_name("online_history_metadata.json")
                rows = json.loads(args.history.read_text())
                if args.observed_until:
                    until = parse_time(args.observed_until)
                elif args.history.name == "online_history.json" and metadata.is_file():
                    source_metadata = json.loads(metadata.read_text())
                    if not isinstance(source_metadata, dict) or not isinstance(source_metadata.get("fetchedAt"), str):
                        raise ValueError("invalid_history_observation_metadata")
                    until = parse_time(source_metadata["fetchedAt"])
                else:
                    parser.error("--observed-until is required for a custom history file")
            else:
                if args.observed_until:
                    parser.error("--observed-until cannot override database observation coverage")
                with create_collection_store(configuration) as store:
                    rows, until, provenance = get_training_history(store)
            model_path = args.model or configuration.output_dir / "neural_model.json"
            report_path = args.report or configuration.output_dir / "neural-evaluation.json"
            report = train_model(rows, until, model_path, report_path)
            if provenance:
                report["collectionProvenance"] = provenance
                report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
            print(json.dumps({key: report[key] for key in ["modelVersion", "sampleCount", "neural",
                             "baselines", "relativeBrierImprovement", "deploymentStatus"]}, indent=2))
            print(f"Saved model: {model_path}\nSaved evaluation: {report_path}\nExperimental output only; active model was not changed.")
        elif args.command == "monitor-usage":
            from observatory.monitor import run_monitor
            run_monitor(once=args.once)
    except KeyboardInterrupt:
        pass
    except ImportError:
        print("Missing optional dependency. Install with: uv sync --extra ml", file=sys.stderr)
        raise SystemExit(1) from None
    except (ValueError, OSError, httpx.HTTPError, CollectionStorageError):
        # Do not echo exception/request contents; they may contain runtime credentials.
        print("Command failed. Check input format, configuration and source availability.", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
