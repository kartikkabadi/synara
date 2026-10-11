import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { ProviderKind } from "../../packages/contracts/src/orchestration";
import { spawnProcess, spawnProcessSync } from "../../packages/shared/src/processRuntime";
import { teardownChildProcessTree } from "../../apps/server/src/platform/supervisedProcessTeardown";
import { parseCases } from "./config";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const abort = new AbortController();
const ownedProcesses: Array<{ name: string; child: ChildProcess }> = [];
const logDescriptors: number[] = [];
let runDir: string | undefined;

// Register cleanup intent before creating any resource, including the run directory.
process.once("SIGINT", () => abort.abort(new Error("Interrupted by SIGINT")));
process.once("SIGTERM", () => abort.abort(new Error("Interrupted by SIGTERM")));

function checkAlive(child: ChildProcess): void {
  abort.signal.throwIfAborted();
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error("The isolated dev runner exited before readiness.");
}

function launch(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  abort.signal.throwIfAborted();
  const log = openSync(join(runDir!, `${name}.log`), "wx", 0o600);
  logDescriptors.push(log);
  const child = spawnProcess(command, args, {
    cwd: root,
    env,
    stdio: ["ignore", log, log],
    ownProcessGroup: true,
  });
  ownedProcesses.push({ name, child });
  child.on("error", () => abort.abort(new Error(`${name} could not start; see its log.`)));
  return child;
}

async function waitReady(child: ChildProcess, serverPort: number, webPort: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    checkAlive(child);
    try {
      const health = await fetch(`http://127.0.0.1:${serverPort}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (health.ok) {
        const status = await health.json();
        if (
          status.startupReady === true &&
          status.orchestrationSubscriptionsReady === true &&
          status.projection?.hasFailure === false
        ) {
          const web = await fetch(`http://localhost:${webPort}/`, {
            signal: AbortSignal.timeout(2_000),
          });
          if (web.ok) return;
        }
      }
    } catch {
      // Startup may refuse connections until migrations and subscriptions finish.
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error("Isolated server/web readiness timed out. Provider tests were not started.");
}

async function main(): Promise<void> {
  parseCases(process.env.SYNARA_E2E_CASES, ProviderKind.literals);
  if (!existsSync(join(root, "node_modules/.bin/turbo")))
    throw new Error(
      "Repository dependencies are missing. Install them separately before running this harness.",
    );
  const require = createRequire(join(here, "package.json"));
  let playwrightCli: string;
  try {
    playwrightCli = require.resolve("@playwright/test/cli");
  } catch {
    throw new Error(
      "Harness dependencies are missing. Install them separately before running this harness.",
    );
  }
  const { chromium } = await import("@playwright/test");
  if (!existsSync(chromium.executablePath()))
    throw new Error(
      "Playwright Chromium is missing. Install the pinned browser separately before running this harness.",
    );

  const artifacts = join(here, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  runDir = mkdtempSync(join(artifacts, "run-"));
  const synaraHome = join(runDir, "synara-home");
  const workspace = join(runDir, "workspace");
  mkdirSync(synaraHome, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(join(workspace, "README.md"), "# Compaction test workspace\n", { flag: "wx" });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SYNARA_HOME: synaraHome,
    SYNARA_HOST: "127.0.0.1",
    SYNARA_PORT_OFFSET: String(randomInt(6_000, 45_000)),
    SYNARA_MODE: "web",
    SYNARA_NO_BROWSER: "1",
    SYNARA_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
    SYNARA_E2E_WORKSPACE_ROOT: workspace,
    SYNARA_E2E_ARTIFACT_DIR: runDir,
    PATH: `${join(root, "node_modules/.bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  };
  // Change only this isolated child's environment. Do not change account-wide auth policy.
  for (const key of [
    "SYNARA_PORT",
    "SYNARA_AUTH_TOKEN",
    "SYNARA_PUBLIC_URL",
    "SYNARA_DESKTOP_WS_URL",
    "VITE_DEV_SERVER_URL",
    "VITE_WS_URL",
    "SYNARA_LOG_PROVIDER_EVENTS",
    "SYNARA_LOG_WS_EVENTS",
  ])
    delete env[key];
  const args = [
    join(root, "scripts/dev-runner.ts"),
    "dev",
    "--home-dir",
    synaraHome,
    "--host",
    "127.0.0.1",
    "--no-browser",
  ];
  const dryRun = spawnProcessSync(process.execPath, [...args, "--dry-run"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  const dryOutput = `${dryRun.stdout ?? ""}${dryRun.stderr ?? ""}`;
  writeFileSync(join(runDir, "dev-runner-dry-run.log"), dryOutput, { mode: 0o600 });
  const ports = /serverPort=(\d+) webPort=(\d+) baseDir=([^\r\n]+)/u.exec(dryOutput);
  if (dryRun.status !== 0 || !ports || ports[3]?.trim() !== synaraHome) {
    throw new Error(
      "Dev-runner dry-run did not confirm the isolated home and ports. Refusing to launch.",
    );
  }
  const serverPort = Number(ports[1]);
  const webPort = Number(ports[2]);
  // The current dev runner checks both loopback families before choosing a pair.
  env.SYNARA_PORT_OFFSET = String(webPort - 5733);
  env.SYNARA_E2E_PORT = String(serverPort);
  env.SYNARA_E2E_WEB_PORT = String(webPort);
  abort.signal.throwIfAborted();
  const runner = launch("dev-runner", process.execPath, args, env);
  await waitReady(runner, serverPort, webPort);
  checkAlive(runner);
  // A port race can make the real launch select another pair. Never test a stranger's server.
  if (
    !readFileSync(join(runDir, "dev-runner.log"), "utf8").includes(
      `serverPort=${serverPort} webPort=${webPort} baseDir=${synaraHome}`,
    )
  ) {
    throw new Error(
      "Launch ports differ from the inspected dry-run. Refusing to start provider tests.",
    );
  }
  const suite = launch(
    "playwright",
    process.execPath,
    [playwrightCli, "test", "--config", join(here, "playwright.config.ts")],
    env,
  );
  const result = await new Promise<number>((done) => {
    suite.once("exit", (code) => done(code ?? 1));
    suite.once("error", () => done(1));
    abort.signal.addEventListener("abort", () => done(1), { once: true });
  });
  if (result !== 0)
    throw new Error(
      "Compaction suite failed or was interrupted. See playwright.log and test-results.",
    );
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : "Harness failed.");
} finally {
  // Preserve every run-owned path for inspection; never recursively delete a supplied path.
  for (const { name, child } of ownedProcesses.reverse()) {
    try {
      const result = await teardownChildProcessTree(child);
      if (
        result.signalErrors.length ||
        (name === "dev-runner" && result.capturedBeforeRootExit !== true)
      ) {
        throw new Error("Process-tree exit was not fully proven.");
      }
    } catch {
      failed = true;
      console.error(
        `Cleanup unverified for ${name} (PID ${child.pid ?? "unknown"}). Retained its log and isolated state.`,
      );
    }
  }
  for (const descriptor of logDescriptors) closeSync(descriptor);
  if (runDir) console.log(`Artifacts retained: ${runDir}`);
}
process.exitCode = failed ? 1 : 0;
