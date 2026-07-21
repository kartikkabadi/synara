import { defineConfig } from "@playwright/test";

const webPort = process.env.SYNARA_E2E_WEB_PORT ?? "5899";
const headless = process.env.SYNARA_E2E_HEADLESS !== "0";

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 5 * 60 * 1000,
  reporter: [["list"], ["html", { outputFolder: "./test-results/html", open: "never" }]],
  use: {
    browserName: "chromium",
    headless,
    baseURL: `http://localhost:${webPort}`,
    screenshot: "on",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
