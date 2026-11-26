import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:8788",
    viewport: { width: 1440, height: 1000 },
    headless: true,
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: ["--use-angle=swiftshader"],
    },
  },
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:8788/api/status",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: "8788",
      BLENDGUARD_PLANNER: "deterministic",
    },
  },
});
