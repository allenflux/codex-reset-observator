import { expect, test, type Page } from "@playwright/test";

type BrowserErrors = {
  pageErrors: string[];
  consoleErrors: string[];
};

function captureBrowserErrors(page: Page): BrowserErrors {
  const errors: BrowserErrors = {
    pageErrors: [],
    consoleErrors: [],
  };

  page.on("pageerror", (error) => {
    errors.pageErrors.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.consoleErrors.push(message.text());
    }
  });

  return errors;
}

async function prepareLocalPage(page: Page) {
  // Vercel Analytics is optional on the local server; keep its browser script
  // from turning a missing local analytics route into a false E2E failure.
  await page.route("**/_vercel/insights/script.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "",
    }),
  );
  // The local E2E server intentionally has no Supabase credentials. Provide
  // an empty marker baseline so that this optional read does not create a
  // browser console error while the marker route itself is tested separately.
  await page.route("**/api/reset-marker", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "public, max-age=0, s-maxage=60" },
      body: JSON.stringify({
        schemaVersion: "reset-marker-v1",
        marker: null,
        resetAt: null,
      }),
    }),
  );
  return captureBrowserErrors(page);
}

async function expectNoBrowserErrors(errors: BrowserErrors) {
  // Allow hydration and the first client refresh to finish before checking.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(errors.pageErrors, "uncaught page errors").toEqual([]);
  expect(errors.consoleErrors, "browser console errors").toEqual([]);
}

test("Japanese home renders the dashboard without browser errors", async ({ page }) => {
  const errors = await prepareLocalPage(page);
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("heading", { name: "Codexリセット観測所", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("現在の状況", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^ランダムリセット/ }).first()).toBeVisible();
  await expect(page.getByText("24時間以内", { exact: true })).toBeVisible();
  await expectNoBrowserErrors(errors);
});

test("English home renders localized identity and dashboard labels", async ({ page }) => {
  const errors = await prepareLocalPage(page);
  const response = await page.goto("/en");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/en\/?$/);
  await expect(
    page.getByRole("heading", { name: "Codex Reset Observatory", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Current status", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Random reset/ }).first()).toBeVisible();
  await expectNoBrowserErrors(errors);
});

test("Chinese home renders localized identity and dashboard labels", async ({ page }) => {
  const errors = await prepareLocalPage(page);
  const response = await page.goto("/zh");

  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/zh\/?$/);
  await expect(
    page.getByRole("heading", { name: "Codex 重置观测站", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("当前状况", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^随机重置/ }).first()).toBeVisible();
  await expectNoBrowserErrors(errors);
});

test("locale links switch from Japanese to English and Chinese", async ({ page }) => {
  const errors = await prepareLocalPage(page);
  await page.goto("/");

  await page
    .locator("header")
    .getByRole("link", { name: "English", exact: true })
    .click();
  await expect(page).toHaveURL(/\/en\/?$/);
  await expect(
    page.getByRole("heading", { name: "Codex Reset Observatory", exact: true }),
  ).toBeVisible();

  await page
    .locator("header")
    .getByRole("link", { name: "简体中文", exact: true })
    .click();
  await expect(page).toHaveURL(/\/zh\/?$/);
  await expect(
    page.getByRole("heading", { name: "Codex 重置观测站", exact: true }),
  ).toBeVisible();
  await expectNoBrowserErrors(errors);
});

test("local current API keeps the public contract for every locale", async ({ request }) => {
  for (const locale of ["ja", "en", "zh"] as const) {
    const response = await request.get(`/api/current?locale=${locale}`);

    expect(response.status(), `HTTP status for ${locale}`).toBe(200);
    expect(response.headers()["content-type"], `content type for ${locale}`).toContain(
      "application/json",
    );

    const body = await response.json() as Record<string, unknown>;
    for (const key of ["schemaVersion", "checkedAt", "dataHealth", "viewModel"]) {
      expect(body, `${key} for ${locale}`).toHaveProperty(key);
    }
    expect(body.schemaVersion).toBe("public-v1");
    expect(body).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    expect(body).not.toHaveProperty("serviceRoleKey");
    expect(body).not.toHaveProperty("active_tibo_signals");
    expect(body).not.toHaveProperty("prediction_history");
  }
});
