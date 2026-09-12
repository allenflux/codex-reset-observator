import copy
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from observatory import social_sync
from observatory.collection_config import CollectionSettings
from observatory.storage import SQLiteRepository, StorageError

NOW = datetime(2026, 9, 12, 12, tzinfo=UTC)
POST_ID = "2098300424520687965"


def activity(**changes):
    return {
        "sourceUrl": f"https://x.com/thsottiaux/status/{POST_ID}",
        "createdAt": "2026-09-11T06:39:40+00:00", "isReply": True,
        "text": "When I say excellent service for existing users, that includes the occasional reset",
        "replyContextText": "Will there be a reset this week?", "replyToHandles": ["@example"],
        "classification": "official_notice", "teaserStrength": "strong",
        "expectedStartAt": "2026-09-12T18:00:00Z", **changes,
    }


def payload(value=None, **changes):
    return {"schemaVersion": "public-v1", "checkedAt": NOW.isoformat(),
            "updatedAt": "2026-09-12T10:00:00Z", "dataHealth": {"stale": False},
            "latestTiboActivity": activity() if value is None else value, **changes}


def fetched(**changes):
    row = social_sync._normalize_activity(activity(**changes), NOW)
    return {"posts": [row], "metadata": {"sourceUrl": social_sync.SOURCE_URL,
                                           "coverage": "single_curated_public_post"}}


def collect(repo, result=None, now=NOW, **kwargs):
    return social_sync.collect_social_once(
        CollectionSettings(), repository=repo, clock=lambda: now,
        fetcher=kwargs.get("fetcher", lambda: copy.deepcopy(result or fetched())))


def test_fetch_original_and_identity_matched_translations_ignore_upstream_analysis():
    requests = []

    def handle(request):
        requests.append(request)
        locale = request.url.params["locale"]
        value = activity(text={"en": "I will reset usage limits tomorrow.",
                               "zh": "明天将重置用量。", "ja": "明日リセットします。"}[locale])
        return httpx.Response(200, json=payload(value))

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = social_sync.fetch_public_social(client=client, now=NOW)
    row, = result["posts"]
    assert row["text"] == "I will reset usage limits tomorrow."
    assert row["translated_text_zh"] == "明天将重置用量。"
    assert row["translated_text_ja"] == "明日リセットします。"
    assert row["tweet_id"] == POST_ID and row["is_reply"] is True
    assert row["tweet_created_at"] == "2026-09-11T06:39:40.000Z"
    assert not {"classification", "signal_type", "teaserStrength", "expectedStartAt"} & row.keys()
    assert result["metadata"]["completeTimeline"] is False
    assert result["metadata"]["upstreamStale"] is False
    assert result["metadata"]["upstreamCheckedAt"] == "2026-09-12T12:00:00.000Z"
    assert len(requests) == 3
    assert all(request.url.host == "codex.gussuriworks.com" for request in requests)
    assert all("authorization" not in request.headers for request in requests)


@pytest.mark.parametrize("change", [
    {"sourceUrl": "https://x.com/another/status/2098300424520687965"},
    {"sourceUrl": "https://x.com.evil.invalid/thsottiaux/status/2098300424520687965"},
    {"sourceUrl": "http://x.com/thsottiaux/status/2098300424520687965"},
    {"createdAt": "2026-09-15T00:00:00Z"}, {"createdAt": "2026-09-11T12:00:00"},
    {"text": "x" * 25_001}, {"text": " "}, {"isReply": "false"},
    {"isQuote": 0}, {"replyContextText": "x" * 1001},
])
def test_invalid_post_identity_context_and_time_are_rejected(change):
    with httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=payload(activity(**change)))
    )) as client, pytest.raises(social_sync.SocialSourceError, match="social_source_invalid_post"):
        social_sync.fetch_public_social(client=client, now=NOW)


def test_translation_mismatch_and_failure_leave_original_usable():
    def handle(request):
        locale = request.url.params["locale"]
        if locale == "ja":
            raise httpx.ConnectError("private-example-secret")
        return httpx.Response(200, json=payload(activity(
            createdAt="2026-09-10T00:00:00Z" if locale == "zh" else "2026-09-11T06:39:40Z")))

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = social_sync.fetch_public_social(client=client, now=NOW)
    assert result["posts"][0]["text"] == activity()["text"]
    assert "translated_text_zh" not in result["posts"][0]
    assert result["metadata"]["translations"]["zh"]["status"] == "identity_mismatch"
    assert result["metadata"]["translations"]["ja"]["status"] == "social_source_unavailable"
    assert "private-example-secret" not in json.dumps(result)


@pytest.mark.parametrize("body,code", [
    ({}, "social_source_schema_changed"), ([], "social_source_schema_changed"),
    ({"latestTiboActivity": []}, "social_source_invalid_post"),
])
def test_schema_failures_are_distinct_from_explicit_empty(body, code):
    with httpx.Client(transport=httpx.MockTransport(
        lambda request: httpx.Response(200, json=body)
    )) as client, pytest.raises(social_sync.SocialSourceError, match=code):
        social_sync.fetch_public_social(client=client, now=NOW)


def test_explicit_empty_is_a_valid_response_without_translation_requests():
    seen = []

    def handle(request):
        seen.append(request)
        return httpx.Response(200, json={"latestTiboActivity": None})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = social_sync.fetch_public_social(client=client, now=NOW)
    assert result["posts"] == [] and len(seen) == 1


def test_redirects_and_oversized_responses_are_not_followed_or_parsed():
    seen = []

    def handle(request):
        seen.append(request)
        return httpx.Response(302, headers={"location": "https://another.invalid/"})

    with httpx.Client(transport=httpx.MockTransport(handle), follow_redirects=True) as client:
        with pytest.raises(social_sync.SocialSourceError, match="social_source_unavailable"):
            social_sync.fetch_public_social(client=client, now=NOW)
    assert len(seen) == 1
    with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(
        200, content=b"x" * (social_sync.MAX_RESPONSE_BYTES + 1)
    ))) as client, pytest.raises(social_sync.SocialSourceError, match="social_source_response_too_large"):
        social_sync.fetch_public_social(client=client, now=NOW)


def test_collect_archives_source_once_uses_local_rules_and_never_renews_expiry():
    repo = SQLiteRepository()
    first = collect(repo)
    original = repo.get("tibo_signals", POST_ID)
    second = collect(repo, now=NOW + timedelta(hours=1))
    assert first["newPosts"] == first["newVersions"] == 1
    assert second["newPosts"] == second["newVersions"] == second["updatedPosts"] == 0
    assert repo.get("tibo_signals", POST_ID) == original
    assert original["signal_type"] == "irrelevant"
    assert original["classification_source"] == "rules-python-v1"
    assert original["formal_adoption_allowed"] is False
    assert original["first_seen_at"] == original["detected_at"] == "2026-09-12T12:00:00.000Z"
    assert original["expires_at"] == "2026-09-15T12:00:00.000Z"
    assert "expected_start_at" not in original
    state = repo.get("social_collection_state", social_sync.SOURCE_ID)
    assert state["successful_run_count"] == 2 and state["post_count"] == 1
    assert state["last_successful_at"] == "2026-09-12T13:00:00.000Z"
    assert repo.list_records("tibo_heartbeat") == []
    assert repo.list_records("tibo_formal_adoptions") == []


def test_revision_archives_old_content_and_keeps_original_observation_and_expiry():
    repo = SQLiteRepository()
    collect(repo)
    old = repo.get("tibo_signals", POST_ID)
    result = collect(repo, fetched(text="I will reset usage limits tomorrow."), NOW + timedelta(hours=1))
    new = repo.get("tibo_signals", POST_ID)
    assert result["updatedPosts"] == result["newVersions"] == 1
    assert result["newPosts"] == 0
    assert new["text"] == "I will reset usage limits tomorrow."
    assert new["signal_type"] == "official_notice"
    assert new["first_seen_at"] == old["first_seen_at"]
    assert new["detected_at"] == old["detected_at"]
    assert new["expires_at"] == old["expires_at"]
    versions = repo.list_records("social_post_versions")
    assert len(versions) == 2
    assert {row["source_fields"]["text"] for row in versions} == {old["text"], new["text"]}


def test_classifier_upgrade_refreshes_untouched_legacy_post_without_new_source_version():
    repo = SQLiteRepository()
    response = fetched(text="And of course, a reset is also landing by midnight today.", isReply=False)
    collect(repo, response)
    old = repo.get("tibo_signals", POST_ID)
    old.update(social_sync._rules(old["imported_source_fields"], legacy=True))
    old.pop("imported_classification_fields")
    repo.put("tibo_signals", old)
    assert old["signal_type"] == "irrelevant"
    result = collect(repo, response, now=NOW + timedelta(hours=1))
    new = repo.get("tibo_signals", POST_ID)
    assert result["updatedPosts"] == 1 and result["newVersions"] == 0
    assert new["signal_type"] == "official_notice"
    assert new["classification_source"] == "rules-python-v2"
    assert new["formal_adoption_allowed"] is False
    assert new["first_seen_at"] == old["first_seen_at"]
    assert new["expires_at"] == old["expires_at"]
    assert len(repo.list_records("social_post_versions")) == 1
    assert collect(repo, response, now=NOW + timedelta(hours=2))["updatedPosts"] == 0


@pytest.mark.parametrize("change", [
    {"verification_status": "verified"}, {"verification_status": "rejected"},
    {"import_source": "browser"}, {"classification_source": "manual"},
    {"text": "Hand edited source text"}, {"signal_type": "reset_executed"},
])
def test_poll_preserves_manual_rejections_browser_rows_and_edits(change):
    repo = SQLiteRepository()
    collect(repo)
    saved = {**repo.get("tibo_signals", POST_ID), **change}
    repo.put("tibo_signals", saved)
    result = collect(repo, fetched(text="I will reset usage limits tomorrow."), NOW + timedelta(hours=1))
    assert result["updatedPosts"] == 0 and result["newVersions"] == 1
    assert repo.get("tibo_signals", POST_ID) == saved


def test_temporary_missing_translation_keeps_version_but_changed_original_drops_stale_translation():
    repo = SQLiteRepository()
    translated = fetched()
    translated["posts"][0]["translated_text_zh"] = "旧译文"
    collect(repo, translated)
    unchanged = collect(repo, now=NOW + timedelta(hours=1))
    assert unchanged["newVersions"] == 0
    assert repo.get("tibo_signals", POST_ID)["translated_text_zh"] == "旧译文"
    collect(repo, fetched(text="New English text"), now=NOW + timedelta(hours=2))
    assert "translated_text_zh" not in repo.get("tibo_signals", POST_ID)


def test_failure_and_empty_preserve_last_post_and_failures_are_sanitized():
    repo = SQLiteRepository()
    collect(repo)
    original = repo.get("tibo_signals", POST_ID)

    def failed():
        raise RuntimeError("private-example-secret")

    result = collect(repo, now=NOW + timedelta(hours=1), fetcher=failed)
    assert result == {"ok": False, "error": "social_source_unavailable"}
    state = repo.get("social_collection_state", social_sync.SOURCE_ID)
    assert state["last_successful_at"] == "2026-09-12T12:00:00.000Z"
    assert state["failed_run_count"] == 1
    assert "private-example-secret" not in json.dumps(state)
    result = collect(repo, {"posts": [], "metadata": {}}, NOW + timedelta(hours=2))
    assert result["ok"] is True and result["postCount"] == 0
    assert repo.get("tibo_signals", POST_ID) == original
    assert repo.get("social_collection_state", social_sync.SOURCE_ID)["latest_post_id"] == POST_ID


def test_changed_source_timestamp_cannot_reuse_old_translation():
    repo = SQLiteRepository()
    translated = fetched()
    translated["posts"][0]["translated_text_zh"] = "旧译文"
    collect(repo, translated)
    collect(repo, fetched(createdAt="2026-09-11T07:39:40Z"), NOW + timedelta(hours=1))
    assert "translated_text_zh" not in repo.get("tibo_signals", POST_ID)


def test_bad_injected_fetcher_cannot_persist_invalid_records():
    repo = SQLiteRepository()
    bad = fetched()
    bad["posts"][0]["tweet_id"] = "invalid"
    assert collect(repo, bad) == {"ok": False, "error": "social_source_invalid_post"}
    assert repo.list_records("tibo_signals") == []
    assert repo.list_records("social_post_versions") == []


def test_repository_failure_does_not_leak_credentials_or_select_sqlite(monkeypatch):
    def failed(settings):
        raise StorageError("private-example-secret")

    monkeypatch.setattr(social_sync, "_create_repository", failed)
    assert social_sync.collect_social_once(CollectionSettings(backend="mysql")) == {
        "ok": False, "error": "social_database_unavailable"}


def test_owned_sqlite_repository_persists_across_collection_runs(tmp_path):
    settings = CollectionSettings(backend="sqlite", sqlite_path=tmp_path / "records.sqlite3")
    first = social_sync.collect_social_once(settings, fetcher=fetched, clock=lambda: NOW)
    second = social_sync.collect_social_once(settings, fetcher=fetched,
                                             clock=lambda: NOW + timedelta(minutes=5))
    assert first["newPosts"] == 1 and second["newPosts"] == 0
