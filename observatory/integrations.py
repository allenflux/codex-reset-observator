"""Optional official status feed. Requests never run in offline mode."""
from __future__ import annotations

from datetime import UTC, datetime
from threading import RLock
from typing import Any

import httpx

from observatory.webhooks import iso


class StatusFeed:
    def __init__(self, client: httpx.Client | None = None) -> None:
        self.client = client or httpx.Client(timeout=8, follow_redirects=False)
        self._cache: list[dict[str, Any]] = []
        self._checked: datetime | None = None
        self._lock = RLock()

    def fetch(self, now: datetime | None = None) -> tuple[list[dict[str, Any]], bool]:
        now = now or datetime.now(UTC)
        with self._lock:
            if self._checked and (now - self._checked).total_seconds() < 60:
                return self._cache, True
            try:
                response = self.client.get("https://status.openai.com/api/v2/incidents.json")
                response.raise_for_status()
                incidents = response.json().get("incidents")
                if not isinstance(incidents, list):
                    return self._cache, False
                records = []
                for incident in incidents[:100]:
                    if not isinstance(incident, dict):
                        continue
                    records.append({
                        "id": incident.get("id"), "title": incident.get("name"),
                        "status": incident.get("status"), "impact": incident.get("impact"),
                        "createdAt": incident.get("created_at"), "updatedAt": incident.get("updated_at"),
                        "resolvedAt": incident.get("resolved_at"),
                        "url": incident.get("shortlink"), "source": "openai_status", "checkedAt": iso(now),
                        "components": [{"id": item.get("id"), "name": item.get("name")}
                                       for item in incident.get("components", []) if isinstance(item, dict)],
                    })
                self._cache, self._checked = records, now
                return records, True
            except (httpx.HTTPError, ValueError, TypeError):
                return self._cache, False

    def close(self) -> None:
        self.client.close()
