"""Collect a public social-post mirror using structured JSON and local rules.

The upstream endpoint exposes one curated post, not a complete X timeline. Its
translations are display-only; classifications and execution estimates are never
imported as evidence. Observations and revisions stay in the configured database.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from observatory.classification import classify_post
from observatory.collection_config import CollectionSettings
from observatory.storage import Record, Repository, SQLiteRepository, StorageError
from observatory.webhooks import iso, timestamp, validate_tibo

SOURCE_ID = "public-history-social"
SOURCE_URL = "https://codex.gussuriworks.com/api/current"
MAX_RESPONSE_BYTES = 2_000_000
MAX_TEXT_LENGTH = 25_000
SOURCE_ERRORS = {
    "social_source_unavailable", "social_source_invalid_response",
    "social_source_response_too_large", "social_source_schema_changed",
    "social_source_invalid_post",
}


class SocialSourceError(ValueError):
    """A bounded public error code, without response bodies or request secrets."""


def _digest(value: Any) -> str:
    payload = json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False,
                         separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _fetch_json(client: httpx.Client, locale: str) -> Record:
    try:
        with client.stream("GET", SOURCE_URL, params={"locale": locale}, timeout=20,
                           follow_redirects=False, headers={"Accept": "application/json"}) as response:
            response.raise_for_status()
            data = bytearray()
            for chunk in response.iter_bytes(chunk_size=65_536):
                data.extend(chunk)
                if len(data) > MAX_RESPONSE_BYTES:
                    raise SocialSourceError("social_source_response_too_large")
        payload = json.loads(data)
    except httpx.HTTPError:
        raise SocialSourceError("social_source_unavailable") from None
    except (ValueError, UnicodeError, RecursionError) as exc:
        if isinstance(exc, SocialSourceError):
            raise
        raise SocialSourceError("social_source_invalid_response") from None
    if not isinstance(payload, dict) or "latestTiboActivity" not in payload:
        raise SocialSourceError("social_source_schema_changed")
    return payload


def _normalize_activity(activity: Any, now: datetime) -> Record | None:
    if activity is None:
        return None
    if not isinstance(activity, dict):
        raise SocialSourceError("social_source_invalid_post")
    # validate_tibo verifies the author, numeric ID, bounded text, UTC timestamp,
    # and optional reply/quote context. Do not trust upstream classification.
    url = activity.get("sourceUrl")
    if not isinstance(url, str) or len(url) > 500:
        raise SocialSourceError("social_source_invalid_post")
    candidate = url.rstrip("/").split("/status/")[-1].split("?")[0]
    body: Record = {"tweetId": candidate, "tweetUrl": url, "text": activity.get("text"),
                    "tweetCreatedAt": activity.get("createdAt")}
    for key in ("isReply", "isQuote", "replyContextText", "replyToHandles",
                "quoteContextText", "quoteTweetUrl", "quoteAuthorHandle"):
        if key in activity:
            body[key] = activity[key]
    try:
        row = validate_tibo(body, now)
    except (ValueError, TypeError):
        raise SocialSourceError("social_source_invalid_post") from None
    return row


def fetch_public_social(*, client: httpx.Client | None = None,
                        now: datetime | None = None) -> Record:
    """Return at most one validated source post plus bounded provenance metadata."""
    now = now or datetime.now(UTC)
    owned_client = client is None
    client = client or httpx.Client()
    try:
        payload = _fetch_json(client, "en")
        row = _normalize_activity(payload["latestTiboActivity"], now)
        metadata: Record = {
            "sourceUrl": SOURCE_URL + "?locale=en", "source": SOURCE_ID,
            "coverage": "single_curated_public_post", "completeTimeline": False,
            "originalLocale": "en", "translations": {},
            "upstreamClassificationUsed": False, "upstreamTimingUsed": False,
        }
        for source_key, field in (("checkedAt", "upstreamCheckedAt"),
                                  ("updatedAt", "upstreamUpdatedAt")):
            parsed = timestamp(payload.get(source_key))
            if parsed and parsed <= now + timedelta(minutes=5):
                metadata[field] = iso(parsed)
        health = payload.get("dataHealth")
        if isinstance(health, dict) and type(health.get("stale")) is bool:
            metadata["upstreamStale"] = health["stale"]
        if row is None:
            return {"posts": [], "metadata": metadata}
        for locale in ("zh", "ja"):
            translated_meta: Record = {"status": "unavailable"}
            metadata["translations"][locale] = translated_meta
            try:
                translated_payload = _fetch_json(client, locale)
                translated = _normalize_activity(translated_payload["latestTiboActivity"], now)
                if not translated:
                    translated_meta["status"] = "empty"
                elif (translated["tweet_id"], translated["tweet_created_at"]) != (
                        row["tweet_id"], row["tweet_created_at"]):
                    translated_meta["status"] = "identity_mismatch"
                else:
                    row[f"translated_text_{locale}"] = translated["text"]
                    translated_meta["status"] = "matched"
            except SocialSourceError as exc:
                translated_meta["status"] = str(exc)
        return {"posts": [row], "metadata": metadata}
    finally:
        if owned_client:
            client.close()


def _rules(row: Record) -> Record:
    return classify_post(row["text"], url=row["tweet_url"],
                         is_reply=row.get("is_reply"), is_quote=row.get("is_quote"))


def _validated_source(row: Any, now: datetime) -> Record:
    """Keep injected fetchers and future adapters under the same storage contract."""
    if not isinstance(row, dict):
        raise SocialSourceError("social_source_invalid_post")
    activity: Record = {"sourceUrl": row.get("tweet_url"), "createdAt": row.get("tweet_created_at"),
                        "text": row.get("text")}
    for snake, camel in (("is_reply", "isReply"), ("is_quote", "isQuote"),
                         ("reply_context_text", "replyContextText"),
                         ("reply_to_handles", "replyToHandles"),
                         ("quote_context_text", "quoteContextText"),
                         ("quote_tweet_url", "quoteTweetUrl"),
                         ("quote_author_handle", "quoteAuthorHandle")):
        if snake in row:
            activity[camel] = row[snake]
    validated = _normalize_activity(activity, now)
    if validated is None or row.get("tweet_id") != validated["tweet_id"]:
        raise SocialSourceError("social_source_invalid_post")
    for locale in ("ja", "zh"):
        field = f"translated_text_{locale}"
        if field in row:
            text = row[field]
            if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_LENGTH:
                raise SocialSourceError("social_source_invalid_post")
            validated[field] = text.strip()
    return validated


def _owned_unmodified(row: Record | None) -> bool:
    if not row or row.get("import_source") != SOURCE_ID:
        return False
    if row.get("verification_status") != "auto_unverified":
        return False
    source = row.get("imported_source_fields")
    return bool(isinstance(source, dict) and row.get("import_source_hash") == _digest(source)
                and all(row.get(key) == value for key, value in source.items())
                and all(row.get(key) == value for key, value in _rules(source).items())
                and row.get("formal_adoption_allowed") is False)


def _create_repository(settings: CollectionSettings) -> Repository:
    if settings.backend == "mysql":
        from observatory.mysql_repository import MySQLRepository

        return MySQLRepository(settings)
    if settings.backend == "sqlite":
        return SQLiteRepository(settings.sqlite_path)
    raise StorageError("Database configuration unavailable")


def _failure(repository: Repository, now: datetime, code: str) -> Record:
    with repository.transaction():
        state = repository.get("social_collection_state", SOURCE_ID) or {"id": SOURCE_ID}
        state.update(latest_attempt_at=iso(now), latest_attempt_status="failure", error=code,
                     failed_run_count=state.get("failed_run_count", 0) + 1)
        repository.put("social_collection_state", state)
    return {"ok": False, "error": code}


def collect_social_once(
    settings: CollectionSettings, *, repository: Repository | None = None,
    fetcher: Callable[[], Record] | None = None,
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> Record:
    """Append observations; preserve trusted edits, rejections and prior versions.

    Transient/empty responses never clear existing posts. Re-reading a post does
    not renew its signal expiry or first-observed timestamp. This collector never
    emits browser heartbeats or promotes a rule match to a confirmed reset.
    """
    owned_repository = repository is None
    try:
        repository = repository or _create_repository(settings)
    except (StorageError, ValueError):
        return {"ok": False, "error": "social_database_unavailable"}
    try:
        try:
            result = fetcher() if fetcher else fetch_public_social(now=clock())
            posts, metadata = result["posts"], result["metadata"]
            if not isinstance(posts, list) or len(posts) > 1 or not isinstance(metadata, dict):
                raise SocialSourceError("social_source_schema_changed")
            observed_at = clock()
        except Exception as exc:
            code = str(exc) if isinstance(exc, SocialSourceError) and str(exc) in SOURCE_ERRORS else "social_source_unavailable"
            return _failure(repository, clock(), code)
        with repository.transaction():
            inserted = updated = versions = 0
            for source in posts:
                source = _validated_source(source, observed_at)
                post_id = source["tweet_id"]
                existing = repository.get("tibo_signals", post_id)
                owned = _owned_unmodified(existing)
                if (owned and existing and existing.get("text") == source.get("text")
                        and existing.get("tweet_created_at") == source.get("tweet_created_at")):
                    # A temporary translation outage must not delete a previously
                    # identity-matched translation or manufacture a new version.
                    for locale in ("zh", "ja"):
                        field = f"translated_text_{locale}"
                        if field not in source and field in existing:
                            source[field] = existing[field]
                content_hash = _digest(source)
                versions += int(repository.put("social_post_versions", {
                    "id": post_id + ":" + content_hash, "post_id": post_id,
                    "content_sha256": content_hash, "source_fields": source,
                    "first_observed_at": iso(observed_at), "source": SOURCE_ID,
                    "source_url": SOURCE_URL + "?locale=en",
                }, once=True))
                row = {**source, **_rules(source), "verification_status": "auto_unverified",
                       "source_kind": "upstream_public_snapshot",
                       "import_source": SOURCE_ID, "import_source_hash": content_hash,
                       "imported_source_fields": source, "formal_adoption_allowed": False,
                       "first_seen_at": iso(observed_at), "detected_at": iso(observed_at),
                       "expires_at": iso(observed_at + timedelta(hours=72))}
                if existing is None:
                    inserted += int(repository.put("tibo_signals", row, once=True))
                elif owned and existing.get("import_source_hash") != content_hash:
                    for field in ("first_seen_at", "detected_at", "expires_at"):
                        row[field] = existing[field]
                    preserved = {key: value for key, value in existing.items()
                                 if key not in existing["imported_source_fields"]}
                    row = {**preserved, **row}
                    row["source_updated_at"] = iso(observed_at)
                    repository.put("tibo_signals", row)
                    updated += 1
            state = repository.get("social_collection_state", SOURCE_ID) or {"id": SOURCE_ID}
            state.update(latest_attempt_at=iso(observed_at), latest_attempt_status="success",
                         last_successful_at=iso(observed_at), error=None,
                         successful_run_count=state.get("successful_run_count", 0) + 1,
                         post_count=len(repository.list_records("tibo_signals")),
                         version_count=len(repository.list_records("social_post_versions")),
                         response_post_count=len(posts), metadata=metadata)
            if posts:
                state.update(latest_post_id=posts[0]["tweet_id"],
                             latest_post_created_at=posts[0]["tweet_created_at"])
            repository.put("social_collection_state", state)
        return {"ok": True, "observedAt": iso(observed_at), "postCount": len(posts),
                "newPosts": inserted, "updatedPosts": updated, "newVersions": versions}
    except StorageError:
        return {"ok": False, "error": "social_database_unavailable"}
    except (ValueError, KeyError, TypeError):
        try:
            return _failure(repository, clock(), "social_source_invalid_post")
        except StorageError:
            return {"ok": False, "error": "social_database_unavailable"}
    finally:
        if owned_repository:
            try:
                repository.close()
            except StorageError:
                pass
