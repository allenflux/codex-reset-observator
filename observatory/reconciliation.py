"""Promote existing accepted names; never call a language model to generate names."""
from __future__ import annotations

from collections import Counter
from datetime import datetime

from observatory.storage import Record, Repository, SupabaseRepository
from observatory.webhooks import iso, reset_marker


def reconcile_names(repo: Repository, now: datetime) -> Record:
    counts: Counter[str] = Counter()
    writes = 0
    attempted = 0
    with repo.transaction():
        candidates = repo.list_records("reset_display_name_candidates")
        estimates = repo.list_records("reset_execution_estimates")
        for candidate in candidates:
            if candidate.get("lifecycle_status") != "provisional":
                counts["inactive"] += 1
                continue
            if (candidate.get("ai_status") != "accepted" or candidate.get("ai_flags")
                or candidate.get("ai_input_mode") != "notice-precompute-v1"
                or candidate.get("ai_prompt_version") != "random-reset-name-v3"
                or not all(isinstance(candidate.get("ai_name_" + locale), str)
                           and candidate["ai_name_" + locale].strip() for locale in ("ja", "en", "zh"))):
                counts["no_accepted_name"] += 1
                continue
            ids = set(candidate.get("notice_tweet_ids") or []) | set(candidate.get("source_tweet_ids") or [])
            ids.add(candidate.get("official_notice_tweet_id"))
            matching = [row for row in estimates if reset_marker([row], now)["marker"]
                        and ids.intersection(row.get("tibo_source_tweet_ids") or [])]
            if len(matching) != 1:
                counts["ambiguous_evidence" if matching else "not_authoritative"] += 1
                continue
            event_key = matching[0]["reset_event_key"]
            if candidate.get("promoted_event_key") not in (None, event_key):
                counts["conflict"] += 1
                continue
            attempted += 1
            if isinstance(repo, SupabaseRepository):
                result = repo.rpc("promote_reset_display_name_candidate", {
                    "p_candidate_id": candidate["candidate_id"], "p_canonical_event_key": event_key,
                    "p_source_tweet_id": candidate.get("official_notice_tweet_id"), "p_promoted_at": iso(now),
                })
                counts[result.get("status", "unknown")] += 1
                writes += bool(result.get("canonicalWrite"))
                continue
            previous = repo.get("reset_display_names", event_key) or {}
            protected = any(previous.get("manual_name_" + locale) for locale in ("ja", "en", "zh"))
            protected = protected or previous.get("ai_status") == "accepted"
            if protected:
                counts["protected_name"] += 1
                continue
            fields = {key: candidate[key] for key in (
                "ai_name_ja", "ai_name_en", "ai_name_zh", "ai_confidence", "ai_status", "ai_flags",
                "ai_model", "ai_prompt_version", "ai_input_mode", "input_hash"
            ) if key in candidate}
            repo.put("reset_display_names", {
                **previous, **fields, "event_key": event_key,
                "source_tweet_id": candidate.get("official_notice_tweet_id"), "updated_at": iso(now),
            })
            repo.put("reset_display_name_candidates", {
                **candidate, "lifecycle_status": "promoted", "promoted_event_key": event_key,
                "promoted_at": iso(now), "updated_at": iso(now),
            })
            writes += 1
            counts["promoted"] += 1
    return {"status": "completed", "scanned": len(candidates), "candidates": len(candidates),
            "attempted": attempted, "geminiRequests": 0, "writes": writes, "invalidated": writes > 0,
            "generationEnabled": False, "statusSummary": dict(sorted(counts.items()))}
