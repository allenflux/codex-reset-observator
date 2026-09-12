"""The Python templates preserve localized pages and the public data boundary."""

from copy import deepcopy
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any

import pytest
from fastapi.testclient import TestClient
from jinja2 import Environment, FileSystemLoader, select_autoescape

from observatory.app import ROOT, create_app
from observatory.config import Settings
from observatory.presentation import COPY, page_context, safe_url

NOW = datetime(2026, 9, 12, 10, tzinfo=UTC)


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.elements: list[tuple[str, dict[str, str | None]]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.elements.append((tag, dict(attrs)))


def render(snapshot: dict[str, Any], locale: str = "en", page: str = "home") -> str:
    environment = Environment(
        loader=FileSystemLoader(ROOT / "templates"), autoescape=select_autoescape()
    )
    return environment.get_template(f"{page}.html").render(**page_context(snapshot, locale, page))


@pytest.fixture
def snapshot() -> dict[str, Any]:
    return {
        "schemaVersion": "public-v1",
        "checkedAt": NOW.isoformat(),
        "updatedAt": "2026-09-11T12:00:00Z",
        "dataHealth": {"overall": "degraded", "stale": True},
        "viewModel": {
            "probability24h": 0.245,
            "probability48h": 0.765,
            "codexOperationalStatus": "unknown",
            "displayReasoningSummary": "Available historical observations.",
            "activeWindow": {"kind": "none", "active": False},
            "latestWindow": {"title": "A recorded reset", "closedAt": "2026-09-09T09:00:00Z"},
            "recentHistory": [
                {
                    "title": "Recorded event",
                    "recordKind": "confirmed_global",
                    "resetAt": "2026-09-09T09:00:00Z",
                    "summary": "A confirmed reset.",
                    "source": "https://x.com/thsottiaux/status/123",
                },
                {
                    "title": "A reference event",
                    "recordKind": "reference",
                    "date": "2026-09-10T10:00:00Z",
                },
            ],
        },
        "randomResetEventTimes": ["2026-09-01T12:00:00Z", "2026-09-03T18:00:00Z"],
    }


@pytest.fixture
def client():
    with TestClient(create_app(Settings(database_path=":memory:"), clock=lambda: NOW)) as browser:
        yield browser


@pytest.mark.parametrize("locale,base", [("ja", ""), ("en", "/en"), ("zh", "/zh")])
@pytest.mark.parametrize(
    "page,suffix", [("home", ""), ("history", "/history"), ("about", "/about"), ("faq", "/faq")]
)
def test_localized_pages_render_without_javascript(
    client, locale: str, base: str, page: str, suffix: str
):
    response = client.get(base + suffix or "/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert f'<html lang="{locale}">' in response.text
    assert COPY[locale][f"title_{page}"] in response.text
    assert (
        f'<link rel="canonical" href="http://localhost:8000{base + suffix or "/"}">'
        in response.text
    )
    assert 'href="/static/site.css"' in response.text
    assert "__NEXT_DATA__" not in response.text
    if page == "home":
        assert 'role="progressbar"' in response.text
        assert COPY[locale]["latest_post"] in response.text
        assert COPY[locale]["heatmap"] in response.text
        assert COPY[locale]["offline"] in response.text


def test_language_switch_preserves_current_page(snapshot):
    for page in ("home", "history", "about", "faq"):
        context = page_context(snapshot, "zh", page)
        assert {item["url"] for item in context["languages"]} == {
            (base + ("" if page == "home" else f"/{page}")) or "/" for base in ("", "/en", "/zh")
        }


def test_forecast_rounding_unknown_values_and_public_only_rendering(snapshot):
    snapshot["viewModel"]["reasoningSummary"] = "private model rationale"
    snapshot["viewModel"]["action"] = "private action"
    html = render(snapshot)
    parser = PageParser()
    parser.feed(html)
    bars = [
        attributes for _, attributes in parser.elements if attributes.get("role") == "progressbar"
    ]
    assert [bar["aria-valuenow"] for bar in bars] == ["25", "77"]
    assert "private model rationale" not in html and "private action" not in html
    for invalid in (None, "25%", True, -0.1, 1.1, float("nan"), float("inf")):
        data = deepcopy(snapshot)
        data["viewModel"]["probability24h"] = invalid
        html = render(data)
        parser = PageParser()
        parser.feed(html)
        bars = [
            attributes
            for _, attributes in parser.elements
            if attributes.get("role") == "progressbar"
        ]
        assert "aria-valuenow" not in bars[0]
        assert bars[0]["aria-valuetext"] == "Unknown"


def test_untrusted_post_and_history_are_escaped_and_unsafe_sources_not_linked(snapshot):
    payload = '<img src=x onerror="alert(1)">'
    snapshot["latestTiboActivity"] = {
        "text": payload,
        "replyContextText": "</script><script>alert(2)</script>",
        "sourceUrl": "javascript:alert(3)",
        "classification": "irrelevant",
    }
    snapshot["viewModel"]["recentHistory"][0].update(title=payload, source="javascript:alert(4)")
    snapshot["viewModel"]["latestWindow"]["source"] = "data:text/html,unsafe"
    snapshot["viewModel"]["activeWindow"]["source"] = "//evil.example"
    html = render(snapshot)
    assert "<img src=x" not in html
    assert "&lt;img" in html
    assert "<script>alert(2)</script>" not in html
    assert 'href="javascript:' not in html and 'href="data:' not in html
    assert 'href="//evil.example' not in html


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "//example.org",
        "https://user:pass@example.org/",
        "https://example.org/\n",
        "https://[broken",
        "file:///tmp/file",
        "https://example.org:invalid/",
    ],
)
def test_rejects_unsafe_url_schemes_credentials_and_control_characters(url):
    assert safe_url(url) is None


def test_history_ordering_reference_labels_and_localization(snapshot):
    for locale in COPY:
        context = page_context(snapshot, locale, "history")
        assert context["history_items"][0]["title"] == "A reference event"
        assert context["history_items"][0]["date"]["iso"] == "2026-09-10T10:00:00+00:00"
        assert COPY[locale]["reference_note"] in render(snapshot, locale, "history")
        assert COPY[locale]["record_confirmed_global"] in render(snapshot, locale, "history")


def test_all_original_faq_entries_and_anchors_are_preserved(snapshot):
    expected_counts = {"ja": 16, "en": 22, "zh": 16}
    for locale, count in expected_counts.items():
        context = page_context(snapshot, locale, "faq")
        assert len(context["faqs"]) == count
        html = render(snapshot, locale, "faq")
        for anchor in (
            "forecast-method",
            "teaser-forecast-method",
            "reset-scope-coverage",
            "chatgpt-work-reset",
        ):
            assert f'id="{anchor}"' in html
        assert context["json_ld"]["@type"] == "FAQPage"


def test_heatmap_uses_qualified_events_excludes_future_and_deduplicates(snapshot):
    snapshot["randomResetEventTimes"] += ["invalid", "2026-09-03T18:00:00Z", "2027-01-01T00:00:00Z"]
    chart = page_context(snapshot, "en")["heatmap"]
    assert chart["count"] == 2
    assert chart["bins"][12]["count"] == chart["bins"][18]["count"] == 1
    assert chart["interval_bins"][2]["count"] == 1
    assert chart["stats"][0] == ("Median", "2.2 days")
    snapshot.pop("randomResetEventTimes")
    assert page_context(snapshot, "en")["heatmap"]["count"] == 0


def test_neural_forecast_is_distinct_from_the_primary_forecast(snapshot):
    snapshot["viewModel"]["neuralForecast"] = {
        "modelVersion": "historical-mlp-v1",
        "trainedAt": NOW.isoformat(),
        "probability24h": 0.91,
        "probability48h": 0.97,
        "eligibleForUse": False,
        "evaluation": {
            "neural": {"meanBrier": 0.12},
            "baseline": {"meanBrier": 0.08},
            "eventCount": 35,
            "testSampleCount": 18,
        },
    }
    html = render(snapshot)
    assert "Experimental neural forecast" in html
    assert "Experimental; main forecast unchanged" in html
    assert "0.1200" in html and "0.0800" in html
    assert ">91%" in html and ">97%" in html
    assert 'aria-valuenow="25"' in html and 'aria-valuenow="77"' in html


def test_static_assets_are_served_and_unknown_routes_are_rejected(client):
    for path in ("/static/site.css", "/static/site.js", "/static/icon.svg"):
        response = client.get(path)
        assert response.status_code == 200 and response.content
    assert client.get("/fr").status_code == 404
    assert client.get("/en/missing").status_code == 404


@pytest.mark.parametrize(
    "configured,origin",
    [
        ("https://my-observatory.example/", "https://my-observatory.example"),
        ("http://localhost:9000/unused/path?query=discarded#fragment", "http://localhost:9000"),
        ("javascript:alert(1)", "https://codex.gussuriworks.com"),
        ("https://user:secret@example.org/", "https://codex.gussuriworks.com"),
    ],
)
def test_configured_origin_is_consistent_across_page_metadata_and_discovery(configured, origin):
    with TestClient(
        create_app(Settings(database_path=":memory:", site_url=configured), clock=lambda: NOW)
    ) as client:
        html = client.get("/zh").text
        assert f'<link rel="canonical" href="{origin}/zh">' in html
        assert f'<meta property="og:url" content="{origin}/zh">' in html
        assert f'hreflang="en" href="{origin}/en"' in html
        assert f'"url": "{origin}"' in html
        assert f"Sitemap: {origin}/sitemap.xml" in client.get("/robots.txt").text
        sitemap = client.get("/sitemap.xml").text
        assert f"<loc>{origin}/zh/history</loc>" in sitemap
        assert "user:secret" not in html and "query=discarded" not in html


def test_standalone_presentation_retains_default_origin(snapshot):
    assert page_context(snapshot, "en")["canonical"] == "https://codex.gussuriworks.com/en"
