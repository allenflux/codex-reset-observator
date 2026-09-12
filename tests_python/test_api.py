from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from observatory.app import create_app
from observatory.config import Settings
from observatory.storage import SQLiteRepository
from observatory.webhooks import iso

NOW = datetime(2026, 9, 12, 10, tzinfo=UTC)
AUTH = {"Authorization": "Bearer tibo-secret"}
USAGE_AUTH = {"Authorization": "Bearer usage-secret"}
CRON_AUTH = {"Authorization": "Bearer cron-secret"}


@pytest.fixture
def backend():
    repo = SQLiteRepository()
    settings = Settings(database_path=":memory:", tibo_webhook_secret="tibo-secret",
                        codex_usage_webhook_secret="usage-secret", cron_secret="cron-secret")
    app = create_app(settings, repo, clock=lambda: NOW)
    with TestClient(app) as client:
        yield client, repo
    repo.close()


def tweet(**changes):
    return {"tweetId": "123456789", "text": "We reset Codex limits for everyone!",
            "tweetUrl": "https://x.com/thsottiaux/status/123456789", "tweetCreatedAt": iso(NOW), **changes}


def usage(**changes):
    return {"observedAt": iso(NOW - timedelta(minutes=2)), "limitId": "codex", "planType": "plus",
            "usedPercent": 90, "windowDurationMins": 10080,
            "resetsAt": int((NOW + timedelta(days=1)).timestamp()), **changes}


def test_offline_public_api_needs_no_secrets():
    with TestClient(create_app(Settings(database_path=":memory:"))) as client:
        result = client.get("/api/current?locale=zh")
        assert result.status_code == 200
        assert result.json()["schemaVersion"] == "public-v1"
        assert "viewModel" in result.json()
        assert client.get("/api/reset-marker").json()["marker"] is None
        assert client.post("/api/webhook/tibo", json=tweet()).status_code == 503
        assert client.post("/api/log-probability").status_code == 503


def test_authentication_is_required_before_body_parsing(backend):
    client, _ = backend
    for path in ("/api/webhook/tibo", "/api/webhook/tibo/heartbeat", "/api/webhook/codex-usage", "/api/log-probability", "/api/internal/reconcile-reset-display-names"):
        assert client.post(path, content="not json").status_code == 401
    assert client.get("/api/monitor/health").status_code == 401
    assert client.post("/api/webhook/tibo", headers={"Authorization": "Bearer tibo-secret extra"}, json=tweet()).status_code == 401


def test_tibo_validation_and_duplicate_delivery(backend):
    client, repo = backend
    assert client.post("/api/webhook/tibo", headers=AUTH, content="{").status_code == 400
    assert client.post("/api/webhook/tibo", headers=AUTH, json=[]).status_code == 400
    for invalid in (tweet(text=""), tweet(tweetUrl="https://x.com/thsottiaux/status/999"),
                    tweet(isReply="false"), tweet(tweetCreatedAt=iso(NOW + timedelta(hours=1))),
                    tweet(text="x" * 25_001), tweet(replyContextText="x" * 1001)):
        assert client.post("/api/webhook/tibo", headers=AUTH, json=invalid).status_code == 400
    first = client.post("/api/webhook/tibo", headers=AUTH, json=tweet())
    second = client.post("/api/webhook/tibo", headers=AUTH, json=tweet())
    assert first.status_code == second.status_code == 200
    assert first.json()["success"]
    assert not first.json()["duplicate"] and second.json()["duplicate"]
    assert not second.json()["formalAdoption"]["newlyAdopted"]
    assert len(repo.list_records("tibo_signals")) == 1


def test_oversized_and_nonfinite_json_rejected(backend):
    client, _ = backend
    result = client.post("/api/webhook/tibo", headers=AUTH, content='{"text":"' + "x" * 66_000 + '"}')
    assert result.status_code == 413
    result = client.post("/api/webhook/codex-usage", headers=USAGE_AUTH, content='{"usedPercent":NaN}')
    assert result.status_code == 400


def test_heartbeat_compatibility_and_health(backend):
    client, repo = backend
    assert client.get("/api/monitor/health", headers=CRON_AUTH).status_code == 503
    payload = {"sessionId": "extension-session", "lastSuccessfulParseAt": iso(NOW),
               "lastSeenTweetId": "123456789", "selectorVersion": "extension-v2",
               "lastPageReloadStatus": "success", "lastPageReloadError": "private token",
               "lastScanSummary": {"currentUrl": "https://x.com/thsottiaux?token=secret",
                                   "scanTimestamp": iso(NOW), "articleCount": 4}}
    first = client.post("/api/webhook/tibo/heartbeat", headers=AUTH, json=payload)
    second = client.post("/api/webhook/tibo/heartbeat", headers=AUTH, json=payload)
    assert first.json()["heartbeatCount"] == 1
    assert second.json()["heartbeatCount"] == 2
    health = client.get("/api/monitor/health", headers=CRON_AUTH)
    assert health.status_code == 200 and health.json()["status"] == "healthy"
    saved = repo.get("tibo_heartbeat", "main")
    assert saved["last_page_reload_error"] is None
    assert saved["last_scan_summary"]["currentUrl"] == "https://x.com/thsottiaux"
    assert "secret" not in health.text


def test_usage_recovery_is_atomic_idempotent_and_private(backend):
    client, repo = backend
    baseline = usage()
    initial = client.post("/api/webhook/codex-usage", headers=USAGE_AUTH, json=baseline)
    assert initial.json()["recovery"] == "baseline"
    recovery = usage(observedAt=iso(NOW), usedPercent=0, resetsAt=baseline["resetsAt"] + 86400)
    result = client.post("/api/webhook/codex-usage", headers=USAGE_AUTH, json=recovery)
    assert result.json()["recovery"] == "observed"
    assert client.post("/api/webhook/codex-usage", headers=USAGE_AUTH, json=recovery).json()["recovery"] == "stale"
    assert client.post("/api/webhook/codex-usage", headers=USAGE_AUTH, json=baseline).json()["recovery"] == "stale"
    assert len(repo.list_records("codex_recovery_observations")) == 1
    assert len(repo.list_records("reset_execution_estimates")) == 1
    marker = client.get("/api/reset-marker").json()
    assert marker["resetAt"] == iso(NOW)
    public = client.get("/api/current").text
    for private in ("used_percent", "previousUsedPercent", "plan_type", "plus", "usage-secret", "source_key"):
        assert private not in public


def test_usage_protocol_and_private_fields_rejected(backend):
    client, _ = backend
    for invalid in (usage(apiKey="sensitive"), usage(usedPercent=True), usage(resetsAt=True),
                    usage(monitorProtocolVersion=2), usage(bankedResetAvailableCount=1001),
                    usage(bankedResetCountChange=True), usage(windowDurationMins=300)):
        assert client.post("/api/webhook/codex-usage", headers=USAGE_AUTH, json=invalid).status_code == 400
    result = client.post("/api/webhook/codex-usage", headers=USAGE_AUTH,
                         json=usage(monitorProtocolVersion=2, postReason="initial"))
    assert result.status_code == 200


def test_scheduled_recovery_never_becomes_random_reset(backend):
    client, repo = backend
    previous = usage(resetsAt=int(NOW.timestamp()))
    client.post("/api/webhook/codex-usage", headers=USAGE_AUTH, json=previous)
    current = usage(observedAt=iso(NOW), usedPercent=0, resetsAt=int((NOW + timedelta(days=7)).timestamp()))
    result = client.post("/api/webhook/codex-usage", headers=USAGE_AUTH, json=current)
    assert result.json()["recovery"] == "regular"
    assert len(repo.list_records("regular_reset_events")) == 1
    assert not repo.list_records("reset_execution_estimates")


def test_hourly_prediction_preserves_first_value(backend):
    client, repo = backend
    first = client.post("/api/log-probability", headers=CRON_AUTH)
    second = client.post("/api/log-probability", headers=CRON_AUTH)
    assert first.status_code == second.status_code == 200
    assert first.json()["action"] == "inserted"
    assert second.json()["action"] == "already_logged"
    assert len(repo.list_records("prediction_history")) == 1


def test_reconcile_reports_generation_disabled(backend):
    client, repo = backend
    repo.put("reset_display_name_candidates", {"candidate_id": "pending", "lifecycle_status": "provisional", "ai_status": "unprocessed"})
    result = client.post("/api/internal/reconcile-reset-display-names", headers=CRON_AUTH)
    assert result.json()["writes"] == 0
    assert result.json()["geminiRequests"] == 0
    assert not result.json()["generationEnabled"]
    assert result.json()["statusSummary"] == {"no_accepted_name": 1}


def test_reconciliation_requires_one_evidence_event_and_preserves_manual_name(backend):
    client, repo = backend
    previous = usage()
    client.post("/api/webhook/codex-usage", headers=USAGE_AUTH, json=previous)
    client.post("/api/webhook/codex-usage", headers=USAGE_AUTH,
                json=usage(observedAt=iso(NOW), usedPercent=0, resetsAt=previous["resetsAt"] + 86400))
    estimate = repo.list_records("reset_execution_estimates")[0]
    estimate["tibo_source_tweet_ids"] = ["123"]
    repo.put("reset_execution_estimates", estimate)
    candidate = {"candidate_id": "candidate", "lifecycle_status": "provisional", "ai_status": "accepted",
                 "ai_name_ja": "名前", "ai_name_en": "Name", "ai_name_zh": "名称", "ai_flags": [],
                 "ai_input_mode": "notice-precompute-v1", "ai_prompt_version": "random-reset-name-v3",
                 "official_notice_tweet_id": "123", "notice_tweet_ids": ["123"]}
    repo.put("reset_display_name_candidates", candidate)
    repo.put("reset_display_names", {"event_key": estimate["reset_event_key"], "manual_name_en": "Preserve me"})
    protected = client.post("/api/internal/reconcile-reset-display-names", headers=CRON_AUTH)
    assert protected.json()["statusSummary"] == {"protected_name": 1}
    assert repo.get("reset_display_names", estimate["reset_event_key"])["manual_name_en"] == "Preserve me"
    candidate["official_notice_tweet_id"] = "999"
    candidate["notice_tweet_ids"] = ["999"]
    repo.put("reset_display_name_candidates", candidate)
    unmatched = client.post("/api/internal/reconcile-reset-display-names", headers=CRON_AUTH)
    assert unmatched.json()["statusSummary"] == {"not_authoritative": 1}


def test_prediction_log_preserves_model_identity_in_existing_jsonb_column(backend):
    client, repo = backend
    result = client.post("/api/log-probability", headers=CRON_AUTH).json()
    row = repo.list_records("prediction_history")[0]
    assert "model_version" not in row  # not a column in the existing Supabase schema
    assert row["debug_info"]["modelVersion"] == "python-hazard-odds-calibrated-v1"
    assert result["model_version"] == row["debug_info"]["modelVersion"]
    assert result["probability_12h"] == row["debug_info"]["probability12h"]


def test_individual_reset_is_not_adopted_or_used_for_global_corroboration(backend):
    client, repo = backend
    payload = tweet(text="I have just reset your usage limits for your account.")
    posted = client.post("/api/webhook/tibo", headers=AUTH, json=payload).json()
    assert posted["formalAdoption"]["newlyAdopted"] is False
    assert repo.list_records("tibo_formal_adoptions") == []
    baseline = usage()
    client.post("/api/webhook/codex-usage", headers=USAGE_AUTH, json=baseline)
    response = client.post("/api/webhook/codex-usage", headers=USAGE_AUTH,
                           json=usage(observedAt=iso(NOW), usedPercent=0, resetsAt=baseline["resetsAt"] + 86400))
    assert response.json()["recovery"] == "observed"
    assert repo.list_records("codex_recovery_observations")[0]["matched_tibo_tweet_id"] is None


def test_global_completion_is_adopted_and_rendered_in_public_history(backend):
    client, repo = backend
    result = client.post("/api/webhook/tibo", headers=AUTH, json=tweet(text="I've reset usage limits for all paid users.")).json()
    assert result["formalAdoption"]["newlyAdopted"] is True
    assert len(repo.list_records("tibo_formal_adoptions")) == 1
    snapshot = client.get("/api/current?locale=en").json()
    assert any(row["key"] == "tibo-reset-123456789" for row in snapshot["viewModel"]["recentHistory"])
