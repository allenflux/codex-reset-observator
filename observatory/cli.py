"""Command-line entry points; nothing contacts external services on import."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import httpx


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
    commands.add_parser("sync-history", help="Import the complete public online reset history")
    train = commands.add_parser("train", help="Train/evaluate the small neural network (install [ml])")
    train.add_argument("--history", type=Path, default=Path(__file__).parent / "data/online_history.json")
    train.add_argument("--observed-until", help="End of verified observation coverage (ISO time)")
    train.add_argument("--model", type=Path, default=Path(__file__).parent / "data/neural_model.json")
    train.add_argument("--report", type=Path, default=Path("reports/python-migration/neural-evaluation.json"))
    monitor = commands.add_parser("monitor-usage", help="Poll the local Codex CLI and send minimal quota snapshots")
    monitor.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    try:
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
            from observatory.history_sync import sync_history
            print(json.dumps(sync_history(), ensure_ascii=False, indent=2))
        elif args.command == "train":
            from observatory.neural import parse_time, train_model
            metadata = args.history.with_name("online_history_metadata.json")
            if args.observed_until:
                until = parse_time(args.observed_until)
            elif metadata.is_file():
                until = parse_time(json.loads(metadata.read_text())["fetchedAt"])
            else:
                parser.error("--observed-until is required for a custom history file")
            report = train_model(json.loads(args.history.read_text()), until, args.model, args.report)
            print(json.dumps({key: report[key] for key in ["modelVersion", "sampleCount", "neural",
                             "baselines", "relativeBrierImprovement", "deploymentStatus"]}, indent=2))
            print(f"Saved model: {args.model}\nSaved evaluation: {args.report}")
        elif args.command == "monitor-usage":
            from observatory.monitor import run_monitor
            run_monitor(once=args.once)
    except KeyboardInterrupt:
        pass
    except ImportError:
        print("Missing optional dependency. Install with: uv sync --extra ml", file=sys.stderr)
        raise SystemExit(1) from None
    except (ValueError, OSError, httpx.HTTPError):
        # Do not echo exception/request contents; they may contain runtime credentials.
        print("Command failed. Check input format, configuration and source availability.", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
