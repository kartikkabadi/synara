import { defineConfig } from "@playwright/test";
import { join } from "node:path";
import { requiredRunPath } from "./config";

const webPort = Number(process.env.SYNARA_E2E_WEB_PORT);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65535)
  throw new Error("Use run.sh to provide an isolated web port.");
const artifacts = requiredRunPath(process.env.SYNARA_E2E_ARTIFACT_DIR, "SYNARA_E2E_ARTIFACT_DIR");

export default defineConfig({
  testDir: "./tests",
  outputDir: join(artifacts, "test-results"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60 * 1000,
  reporter: [
    ["list"],
    ["html", { outputFolder: join(artifacts, "playwright-report"), open: "never" }],
  ],
  use: {
    browserName: "chromium",
    headless: process.env.SYNARA_E2E_HEADLESS !== "0",
    baseURL: `http://localhost:${webPort}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
