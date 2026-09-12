"""Real browser smoke tests; run explicitly with pytest -m browser."""

import os
import socket
import threading
import time
from pathlib import Path

import httpx
import pytest
import uvicorn
from playwright.sync_api import expect, sync_playwright

from observatory.app import create_app
from observatory.config import Settings
from observatory.storage import SQLiteRepository

pytestmark = pytest.mark.browser


@pytest.fixture(scope="module")
def local_site():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    repository = SQLiteRepository(":memory:")
    app = create_app(Settings(database_path=":memory:"), repository)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    worker = threading.Thread(target=server.run, daemon=True)
    worker.start()
    url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            try:
                if httpx.get(url + "/healthz", timeout=1).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(.05)
        else:
            pytest.fail("Local Python server failed to start")
        yield url
    finally:
        server.should_exit = True
        worker.join(timeout=5)
        repository.close()


@pytest.mark.parametrize("width", [1440, 390])
def test_localized_pages_interactions_and_layout(local_site, width):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        page = browser.new_page(viewport={"width": width, "height": 1000}, timezone_id="Asia/Bangkok")
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
        try:
            for route, title in [("/", "Codexリセット観測所"), ("/en", "Codex Reset Observatory"), ("/zh", "Codex 重置观测站")]:
                assert page.goto(local_site + route).status == 200
                expect(page.locator("header .brand")).to_contain_text(title)
                expect(page.get_by_role("heading", level=1)).to_be_visible()
                expect(page.get_by_role("progressbar")).to_have_count(2)
                expect(page.locator("#neural-heading")).to_be_visible()
                assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            before = page.locator("[data-heatmap-count]").first.inner_text()
            page.locator('[data-heatmap-range]').select_option("month")
            assert page.locator("[data-heatmap-count]").first.inner_text() != before
            page.locator('[data-heatmap-range]').select_option("all")
            page.locator("#refresh").click()
            expect(page.locator("#refresh")).to_be_enabled()
            expect(page.locator("#neural-heading")).to_be_visible()
            destination = os.environ.get("OBSERVATORY_SCREENSHOT_DIR")
            if destination:
                Path(destination).mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(Path(destination) / f"python-dashboard-{width}.png"), full_page=True)
            assert page.goto(local_site + "/zh/history").status == 200
            page.locator("#history-search").fill("Never-Nonexistent-Record")
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            page.locator("#history-search").fill("")
            for route in ["/zh/faq", "/en/about", "/faq", "/history"]:
                assert page.goto(local_site + route).status == 200
            assert not errors
        finally:
            browser.close()
