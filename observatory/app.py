"""FastAPI application preserving the website and monitor webhook URLs."""
from __future__ import annotations

import hmac
import json
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
)
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.concurrency import run_in_threadpool

from observatory.classification import is_global_reset_signal
from observatory.collection_config import create_collection_store
from observatory.collection_store import CollectionStorageError
from observatory.config import Settings
from observatory.domain import build_snapshot, classify_post, load_data
from observatory.integrations import StatusFeed
from observatory.mysql_repository import MySQLRepository
from observatory.neural import parse_time
from observatory.presentation import get_site_origin
from observatory.probability import MODEL_VERSION as BASELINE_MODEL_VERSION
from observatory.reconciliation import reconcile_names
from observatory.storage import (
    Record,
    Repository,
    SQLiteRepository,
    StorageError,
    SupabaseRepository,
)
from observatory.webhooks import (
    build_heartbeat,
    evaluate_health,
    iso,
    process_usage,
    reset_marker,
    validate_tibo,
    validate_usage,
)

ROOT = Path(__file__).parent
NO_STORE = "no-store, no-cache, must-revalidate"
PUBLIC_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=120"


def authorize(request: Request, secret: str) -> None:
    if not secret:
        raise HTTPException(503, "configuration_unavailable")
    expected = ("Bearer " + secret).encode("utf-8")
    received = request.headers.get("authorization", "").encode("utf-8")
    if not hmac.compare_digest(received, expected):
        raise HTTPException(401, "Unauthorized")


def _reject_constant(_: str) -> None:
    raise ValueError("Non-finite JSON number")


async def json_body(request: Request, maximum: int) -> Record:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > maximum:
            raise HTTPException(413, "Request body too large")
    try:
        result = json.loads(body, parse_constant=_reject_constant)
    except (ValueError, UnicodeDecodeError, RecursionError) as exc:
        raise HTTPException(400, "Invalid JSON") from exc
    if not isinstance(result, dict):
        raise HTTPException(400, "Expected a JSON object")
    return result


def _merge_rows(initial: list[Record], incoming: list[Record], key: str) -> list[Record]:
    values = {str(row.get(key, index)): row for index, row in enumerate(initial)}
    for index, row in enumerate(incoming):
        values[str(row.get(key, f"stored-{index}"))] = row
    return list(values.values())


def create_app(
    settings: Settings | None = None,
    repository: Repository | None = None,
    *,
    clock: Callable[[], datetime] | None = None,
    snapshot_builder: Callable[..., Record] | None = None,
    collection_factory: Callable[[], Any] | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    site_origin = get_site_origin(settings.site_url)
    owned_repository = repository is None
    if repository is None:
        if settings.collection and settings.collection.backend == "mysql":
            repository = MySQLRepository(settings.collection)
        elif settings.supabase_url or settings.supabase_service_role_key:
            repository = SupabaseRepository(settings.supabase_url, settings.supabase_service_role_key)
        else:
            repository = SQLiteRepository(settings.database_path)
    repo = repository
    clock = clock or (lambda: datetime.now(UTC))
    snapshot_builder = snapshot_builder or build_snapshot
    status_feed = StatusFeed() if settings.fetch_live_status else None
    seed = load_data()
    collection_config = settings.collection
    if collection_factory is None and collection_config and collection_config.backend != "unconfigured":
        collection_factory = partial(create_collection_store, collection_config)

    def read_collection() -> tuple[Record, list[Record] | None]:
        if collection_factory is None:
            return {"configured": False, "fresh": False}, None
        try:
            with collection_factory() as store:
                status = store.get_status()
                run_id = status.get("latestSuccessfulRunId")
                rows = store.events_for_run(run_id) if run_id is not None else None
            latest = status.get("latestSuccessfulAt")
            age = (clock() - parse_time(latest)).total_seconds() if latest else None
            interval = collection_config.interval_seconds if collection_config else 3600
            return {**status, "configured": True,
                    "backend": collection_config.backend if collection_config else "injected",
                    "intervalSeconds": interval,
                    "fresh": age is not None and 0 <= age <= interval * 3,
                    "ageSeconds": round(age) if age is not None else None}, rows
        except (CollectionStorageError, ValueError, OSError):
            return {"configured": True, "fresh": False, "error": "collection_database_unavailable"}, None

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> Any:
        yield
        if owned_repository:
            repo.close()
        if status_feed:
            status_feed.close()

    application = FastAPI(title="Codex Reset Observatory", version="2.0.0", lifespan=lifespan)
    application.state.repository = repo
    application.state.settings = settings
    templates = Jinja2Templates(directory=str(ROOT / "templates"))
    application.mount("/static", StaticFiles(directory=str(ROOT / "static"), check_dir=False), name="static")

    @application.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        return JSONResponse({"error": exc.detail}, status_code=exc.status_code, headers={"Cache-Control": NO_STORE})

    @application.exception_handler(StorageError)
    async def storage_error(_: Request, exc: StorageError) -> JSONResponse:
        return JSONResponse({"error": "Database unavailable"}, status_code=503, headers={"Cache-Control": NO_STORE})

    @application.middleware("http")
    async def secure_headers(request: Request, call_next: Any) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
        )
        if request.url.path.startswith("/api/"):
            response.headers["X-Robots-Tag"] = "noindex, nofollow"
            if "cache-control" not in response.headers:
                response.headers["Cache-Control"] = NO_STORE
        return response

    def read_data(*, strict: bool = False) -> Record:
        data = dict(seed)
        source_status = "mysql" if isinstance(repo, MySQLRepository) else "local" if isinstance(repo, SQLiteRepository) else "supabase"
        collection, collected_history = read_collection()
        data["collection_status"] = collection
        if collected_history is not None:
            # A source correction/removal must replace the prior snapshot too.
            data["reset_history"] = collected_history
        try:
            for table, field, key in [
                ("tibo_signals", "tibo_signals", "tweet_id"),
                ("reset_execution_estimates", "reset_execution_estimates", "reset_event_key"),
                ("regular_reset_events", "regular_reset_events", "schedule_key"),
                ("codex_recovery_observations", "recovery_observations", "id"),
                ("prediction_history", "prediction_history", "logged_hour"),
                ("reset_display_names", "reset_display_names", "event_key"),
            ]:
                data[field] = _merge_rows(data.get(field, []), repo.list_records(table), key)
            heartbeat = repo.get("tibo_heartbeat", "main")
            data["health"] = evaluate_health(heartbeat, clock())
        except StorageError:
            if strict:
                raise
            source_status = "unavailable"
            data["health"] = {"status": "unhealthy", "detail": "database_unavailable"}
        if status_feed:
            incidents, available = status_feed.fetch(clock())
            if incidents:
                data["status_history"] = incidents
            data["status_feed_available"] = available
        data["source_status"] = source_status
        database_healthy = source_status in {"mysql", "supabase"}
        collection_healthy = not collection["configured"] or collection["fresh"]
        status_healthy = bool(data.get("status_feed_available"))
        data["checked_at"] = iso(clock())
        data["data_health"] = {
            "stale": not database_healthy or not status_healthy or not collection_healthy,
            "sources": {
                "supabaseSignals": {"state": "ok" if database_healthy else "degraded",
                                    "detail": "database_error" if source_status == "unavailable" else "missing_configuration"},
                "openAIStatus": {"state": "ok" if status_healthy else "degraded",
                                 "detail": "request_failed" if status_feed else "missing_configuration"},
            },
        }
        return data

    def get_snapshot(locale: str = "ja", *, strict: bool = False) -> Record:
        data = read_data(strict=strict)
        result = snapshot_builder(data, locale=locale, now=clock())
        # Integration point for the independently trained, non-LLM forecast.
        return result

    application.state.read_data = read_data
    application.state.get_snapshot = get_snapshot

    @application.get("/api/current")
    def current(locale: str = "ja") -> JSONResponse:
        language = locale if locale in ("ja", "en", "zh") else "ja"
        return JSONResponse(get_snapshot(language), headers={"Cache-Control": PUBLIC_CACHE})

    @application.get("/api/collection/status")
    def public_collection_status() -> JSONResponse:
        status, _ = read_collection()
        return JSONResponse(status, status_code=200 if status.get("fresh") else 503)

    @application.get("/api/reset-marker")
    def marker() -> JSONResponse:
        result = reset_marker(repo.list_records("reset_execution_estimates"), clock())
        return JSONResponse(result, headers={"Cache-Control": "public, max-age=0, s-maxage=300"})

    @application.get("/api/monitor/health")
    def monitor_health(request: Request) -> JSONResponse:
        authorize(request, settings.cron_secret)
        result = evaluate_health(repo.get("tibo_heartbeat", "main"), clock())
        return JSONResponse(result, status_code=503 if result["status"] == "unhealthy" else 200)

    @application.post("/api/webhook/tibo/heartbeat")
    async def heartbeat(request: Request) -> Record:
        authorize(request, settings.tibo_webhook_secret)
        body = await json_body(request, settings.max_body_bytes)

        def save() -> Record:
            with repo.transaction():
                try:
                    row = build_heartbeat(body, repo.get("tibo_heartbeat", "main"), clock())
                except ValueError as exc:
                    raise HTTPException(400, str(exc)) from exc
                repo.put("tibo_heartbeat", row)
                return {"success": True, "heartbeatCount": row["heartbeat_count"],
                        "maxGapSeconds": row["max_gap_seconds"], "lastGapSeconds": row["last_gap_seconds"]}
        return await run_in_threadpool(save)

    @application.post("/api/webhook/tibo")
    async def tibo(request: Request) -> Record:
        authorize(request, settings.tibo_webhook_secret)
        body = await json_body(request, settings.max_body_bytes)
        now = clock()
        try:
            row = validate_tibo(body, now)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        classified = classify_post(row["text"], url=row["tweet_url"],
                                   is_reply=row.get("is_reply"), is_quote=row.get("is_quote"))
        row.update(classified)
        row.update(verification_status="auto_unverified", classification_source="rule",
                   detected_at=iso(now), expires_at=iso(now + timedelta(hours=72)))

        def save() -> Record:
            with repo.transaction():
                existing = repo.get("tibo_signals", row["tweet_id"])
                # Retries never overwrite manual verification or prior trusted edit identity.
                if existing:
                    saved = existing
                    inserted = False
                else:
                    inserted = repo.put("tibo_signals", row, once=True)
                    saved = row if inserted else repo.get("tibo_signals", row["tweet_id"]) or row
                adopted = False
                formal = is_global_reset_signal(saved)
                if formal:
                    event_key = "tibo-reset-" + saved["tweet_id"]
                    if isinstance(repo, SupabaseRepository):
                        result = repo.rpc("claim_tibo_formal_adoption", {
                            "p_logical_post_id": saved["tweet_id"], "p_logical_post_tweet_ids": [saved["tweet_id"]],
                            "p_reset_event_key": event_key, "p_representative_tweet_id": saved["tweet_id"],
                            "p_source_tweet_ids": [saved["tweet_id"]], "p_claim_source": "new_adoption",
                            "p_identity_source": "none", "p_adopted_at": iso(now), "p_claimed_at": iso(now),
                        })
                        adopted = result.get("status") == "claimed_new"
                    else:
                        adopted = repo.put("tibo_formal_adoptions", {
                            "id": str(uuid5(NAMESPACE_URL, event_key)), "reset_event_key": event_key,
                            "logical_post_id": saved["tweet_id"], "representative_tweet_id": saved["tweet_id"],
                            "source_tweet_ids": [saved["tweet_id"]], "adopted_at": iso(now),
                        }, once=True)
                return {
                    "success": True, "signalType": saved.get("signal_type"),
                    "confidence": saved.get("confidence"), "teaserStrength": saved.get("teaser_strength"),
                    "classificationMode": "rules", "duplicate": not inserted,
                    "formalAdoption": {"newlyAdopted": adopted, "tweetId": saved["tweet_id"] if adopted else None,
                                       "title": "ランダムリセット" if adopted else None,
                                       "confidence": saved.get("confidence") if adopted else None,
                                       "sourceUrl": saved["tweet_url"] if adopted else None},
                }
        return await run_in_threadpool(save)

    @application.post("/api/webhook/codex-usage")
    async def usage(request: Request) -> Record:
        authorize(request, settings.codex_usage_webhook_secret)
        body = await json_body(request, settings.max_body_bytes)
        now = clock()
        try:
            payload = validate_usage(body, now)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return await run_in_threadpool(process_usage, repo, payload, now)

    @application.post("/api/log-probability")
    def log_probability(request: Request) -> Record:
        authorize(request, settings.cron_secret)
        now = clock()
        snapshot = get_snapshot(strict=True)
        view = snapshot.get("viewModel", {})
        logged_hour = iso(now.replace(minute=0, second=0, microsecond=0))
        row = {"logged_hour": logged_hour, "recorded_at": iso(now),
               "probability_24h": view.get("probability24h", 0), "probability_48h": view.get("probability48h", 0),
               "expectation": ("very_high" if view.get("probability24h", 0) >= .8 or view.get("probability48h", 0) >= .85
                               else "high" if max(view.get("probability24h", 0), view.get("probability48h", 0)) >= .61
                               else "medium" if max(view.get("probability24h", 0), view.get("probability48h", 0)) >= .3 else "low"),
               "reasons": str(view.get("displayReasoningSummary", "")),
               "official_notice": view.get("activeWindow", {}).get("kind") == "official",
               "incident_hint": 0, "status_incidents": 0,
               "debug_info": {"modelVersion": BASELINE_MODEL_VERSION,
                              "probability12h": view.get("probability12h"),
                              "probability72h": view.get("probability72h"),
                              "neuralForecast": {key: view["neuralForecast"].get(key) for key in (
                                  "modelVersion", "trainedAt", "probability24h", "probability48h", "eligibleForUse"
                              )} if isinstance(view.get("neuralForecast"), dict) else None}}
        inserted = repo.put("prediction_history", row, once=True)
        saved = row if inserted else repo.get("prediction_history", logged_hour) or row
        return {"ok": True, "action": "inserted" if inserted else "already_logged", "logged_hour": logged_hour,
                "recorded_at": saved.get("recorded_at"), "probability_12h": (saved.get("debug_info") or {}).get("probability12h"),
                "model_version": (saved.get("debug_info") or {}).get("modelVersion"),
                "probability_24h": saved["probability_24h"], "probability_48h": saved["probability_48h"],
                "probability_72h": (saved.get("debug_info") or {}).get("probability72h"), "expectation": saved["expectation"]}

    @application.post("/api/internal/reconcile-reset-display-names")
    def reconcile(request: Request) -> Record:
        authorize(request, settings.cron_secret)
        return reconcile_names(repo, clock())

    @application.get("/healthz")
    def healthz() -> Record:
        return {"status": "ok", "runtime": "python"}

    @application.get("/robots.txt", response_class=PlainTextResponse)
    def robots() -> str:
        return "User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: " + site_origin + "/sitemap.xml\n"

    @application.get("/sitemap.xml")
    def sitemap() -> Response:
        from xml.sax.saxutils import escape
        urls = [site_origin + ("" if locale == "ja" else "/" + locale) + (suffix or ("/" if locale == "ja" else "")) for locale in ("ja", "en", "zh")
                for suffix in ("", "/history", "/about", "/faq")]
        content = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        content += "".join("<url><loc>" + escape(url) + "</loc></url>" for url in urls) + "</urlset>"
        return Response(content, media_type="application/xml")

    def page(request: Request, locale: str, page_name: str) -> Response:
        if locale not in ("ja", "en", "zh"):
            raise HTTPException(404, "Page not found")
        from observatory.history import get_heatmap_event_times
        from observatory.presentation import page_context
        data = read_data()
        snapshot = snapshot_builder(data, locale=locale, now=clock())
        snapshot["randomResetEventTimes"] = get_heatmap_event_times(data, clock())
        context = {"request": request, **page_context(snapshot, locale, page_name, settings.site_url)}
        return templates.TemplateResponse(request=request, name=page_name + ".html", context=context)

    @application.get("/", response_class=HTMLResponse)
    def root(request: Request) -> Response:
        return page(request, "ja", "home")

    @application.get("/{locale}", response_class=HTMLResponse)
    def localized_root(request: Request, locale: str) -> Response:
        if locale in ("history", "about", "faq"):
            return page(request, "ja", locale)
        return page(request, locale, "home")

    @application.get("/{locale}/{page_name}", response_class=HTMLResponse)
    def localized_page(request: Request, locale: str, page_name: str) -> Response:
        if page_name not in ("history", "about", "faq"):
            raise HTTPException(404, "Page not found")
        return page(request, locale, page_name)

    return application


app = create_app()
