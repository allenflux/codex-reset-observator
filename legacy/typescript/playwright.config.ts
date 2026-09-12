import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);
const localBaseURL = "http://127.0.0.1:3000";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  forbidOnly: isCI,
  fullyParallel: false,
  retries: isCI ? 1 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? "github" : "list",
  use: {
    baseURL: localBaseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "corepack pnpm start",
    url: localBaseURL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    env: {
      // Keep local E2E runs away from any developer .env.local credentials.
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      CRON_SECRET: "",
      TIBO_WEBHOOK_SECRET: "",
      CODEX_USAGE_MONITOR_SECRET: "",
      GEMINI_API_KEY: "",
    },
  },
});
