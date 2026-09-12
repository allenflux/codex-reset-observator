"""Minimal cross-platform Codex app-server quota polling, with private fields discarded."""

from __future__ import annotations

import json
import math
import os
import queue
import re
import subprocess
import threading
import time
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

import httpx


def parse_rate_limits(payload: Any, now: datetime | None = None) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    result = payload.get("result", payload)
    if not isinstance(result, dict):
        return None
    by_id = result.get("rateLimitsByLimitId", result.get("rate_limits_by_limit_id"))
    snapshots = list(by_id.items()) if isinstance(by_id, dict) else [(None, result.get("rateLimits", result.get("rate_limits")))]
    candidates = []
    for key, snapshot in snapshots:
        if not isinstance(snapshot, dict):
            continue
        limit_id = snapshot.get("limitId", snapshot.get("limit_id", key))
        for name in ["primary", "secondary"]:
            window = snapshot.get(name)
            if not isinstance(window, dict):
                continue
            duration = window.get("windowDurationMins", window.get("window_duration_mins"))
            used = window.get("usedPercent", window.get("used_percent"))
            resets = window.get("resetsAt", window.get("resets_at"))
            if duration != 10080 or isinstance(used, bool) or not isinstance(used, (float, int)) or not math.isfinite(used) or not 0 <= used <= 100:
                continue
            if type(resets) is not int or resets <= 0:
                continue
            plan_type = snapshot.get("planType", snapshot.get("plan_type", "unknown"))
            if not isinstance(plan_type, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", plan_type):
                plan_type = "unknown"
            item = {"observedAt": (now or datetime.now(UTC)).isoformat(), "limitId": "codex",
                    "planType": plan_type,
                    "usedPercent": used, "windowDurationMins": 10080, "resetsAt": resets}
            credits = result.get("rateLimitResetCredits", snapshot.get("rateLimitResetCredits"))
            if isinstance(credits, dict) and type(credits.get("availableCount")) is int and 0 <= credits["availableCount"] <= 1000:
                item["bankedResetAvailableCount"] = credits["availableCount"]
            candidates.append((limit_id, item))
    explicit = [item for name, item in candidates if name == "codex"]
    if len(explicit) == 1:
        return explicit[0]
    if not explicit and len(candidates) == 1:
        return candidates[0][1]
    return None


class AppServer:
    def __init__(self, executable: str) -> None:
        self.process = subprocess.Popen([executable, "app-server"], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.messages: queue.Queue[Any] = queue.Queue(maxsize=256)
        self.counter = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self.process.stdout
        while True:
            line = self.process.stdout.readline(1_000_001)
            if not line or len(line) > 1_000_000:
                self.messages.put(None)
                break
            try:
                item = json.loads(line)
                if isinstance(item, dict) and "id" in item:
                    self.messages.put(item)
            except ValueError:
                self.messages.put(None)
                break

    def send(self, message: dict[str, Any]) -> None:
        assert self.process.stdin
        self.process.stdin.write((json.dumps(message) + "\n").encode())
        self.process.stdin.flush()

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.counter += 1
        identifier = str(self.counter)
        self.send({"jsonrpc": "2.0", "id": identifier, "method": method, "params": params or {}})
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                reply = self.messages.get(timeout=max(.01, deadline-time.monotonic()))
            except queue.Empty:
                break
            if reply is None:
                break
            if str(reply.get("id")) == identifier:
                if "error" in reply:
                    raise ValueError("app_server_rpc_failed")
                return dict(reply)
        raise ValueError("app_server_timeout")

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        for pipe in [self.process.stdin, self.process.stdout]:
            if pipe:
                pipe.close()


def run_monitor(*, once: bool = False) -> None:
    secret = os.environ.get("CODEX_USAGE_MONITOR_SECRET", "").strip()
    url = os.environ.get("CODEX_USAGE_WEBHOOK_URL", "http://127.0.0.1:8000/api/webhook/codex-usage")
    parsed = urlparse(url)
    if not secret or parsed.username or parsed.password or parsed.scheme not in {"http", "https"}:
        raise ValueError("invalid_monitor_configuration")
    if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("remote_webhook_requires_https")
    interval = max(60, int(os.environ.get("CODEX_USAGE_POLL_INTERVAL_MS", "120000")) / 1000)
    executable = os.environ.get("CODEX_CLI_PATH", "").strip() or "codex"
    while True:
        server: AppServer | None = None
        try:
            server = AppServer(executable)
            server.request("initialize", {"clientInfo": {"name": "codex-reset-observatory",
                           "version": "1.0.0"}, "capabilities": {"experimentalApi": False}})
            server.send({"jsonrpc": "2.0", "method": "initialized"})
            with httpx.Client(timeout=15, follow_redirects=False) as client:
                while True:
                    snapshot = parse_rate_limits(server.request("account/rateLimits/read"))
                    if snapshot is None:
                        raise ValueError("weekly_quota_unavailable")
                    # Legacy snapshot protocol: server compares consecutive measurements.
                    # Never forward the raw account response, tokens, IDs, or diagnostics.
                    response = client.post(url, json=snapshot, headers={"Authorization": "Bearer " + secret})
                    response.raise_for_status()
                    print("Usage snapshot accepted", flush=True)
                    if once:
                        return
                    time.sleep(interval)
        except (httpx.HTTPError, ValueError, OSError):
            if once:
                raise ValueError("monitor_failed") from None
            print("Monitor unavailable; retrying in 30 seconds", flush=True)
        finally:
            if server is not None:
                server.close()
        time.sleep(30)
