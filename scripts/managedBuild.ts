// FILE: managedBuild.ts
// Purpose: Shared, configurable managed build tooling for Synara Canary and Dogfood.
// Layer: Local developer tooling

import { spawn, spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

export type ManagedBuildCommand = "setup" | "update" | "start" | "stop" | "status" | "rollback";

export interface ManagedBuildConfig {
  readonly name: string;
  readonly displayName: string;
  readonly flavor: string;
  readonly defaultRef: string;
  readonly homeDirName: string;
  readonly cacheSourceDirName: string;
  readonly homeEnvVar: string;
  readonly sourceEnvVar: string;
  readonly stateFileName: string;
  readonly pidFileName: string;
  readonly logFileName: string;
}

export interface ManagedBuildPaths {
  readonly home: string;
  readonly source: string;
  readonly state: string;
  readonly pid: string;
  readonly log: string;
}

interface ManagedBuildState {
  readonly currentCommit: string;
  readonly previousCommit: string | null;
  readonly trackedRef: string;
  readonly updatedAt: string;
}

export interface ParsedManagedBuildArgs {
  readonly command: ManagedBuildCommand;
  readonly ref: string | null;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = Path.resolve(Path.dirname(SCRIPT_PATH), "..");
const COMMIT_PATTERN = /^[0-9a-f]{40}$/iu;

export function resolveManagedBuildPaths(
  config: ManagedBuildConfig,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = OS.homedir(),
): ManagedBuildPaths {
  const home = Path.resolve(
    env[config.homeEnvVar]?.trim() || Path.join(homeDirectory, config.homeDirName),
  );
  const cacheBase = env.XDG_CACHE_HOME?.trim() || Path.join(homeDirectory, ".cache");
  const source = Path.resolve(
    env[config.sourceEnvVar]?.trim() ||
      Path.join(cacheBase, config.cacheSourceDirName, "source"),
  );
  return {
    home,
    source,
    state: Path.join(home, config.stateFileName),
    pid: Path.join(home, config.pidFileName),
    log: Path.join(home, config.logFileName),
  };
}

export function parseManagedBuildArgs(argv: ReadonlyArray<string>): ParsedManagedBuildArgs {
  const rawCommand = argv[0] ?? "status";
  if (
    !(["setup", "update", "start", "stop", "status", "rollback"] as const).includes(
      rawCommand as ManagedBuildCommand,
    )
  ) {
    throw new Error(`Unknown managed build command: ${rawCommand}`);
  }
  let ref: string | null = null;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ref") {
      const value = argv[index + 1]?.trim();
      if (!value) throw new Error("Missing value for --ref.");
      ref = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown managed build argument: ${String(argument)}`);
  }
  return { command: rawCommand as ManagedBuildCommand, ref };
}

export function resolveManagedBuildRef(
  input: ParsedManagedBuildArgs,
  trackedRef: string | null,
  defaultRef: string,
): string {
  return input.ref ?? (input.command === "update" ? trackedRef : null) ?? defaultRef;
}

export function managedBuildCloneArgs(
  originUrl: string,
  source: string,
): ReadonlyArray<string> {
  return ["clone", "--", originUrl, source];
}

export function managedBuildStartArgs(): ReadonlyArray<string> {
  return ["apps/desktop/scripts/start-electron.mjs"];
}

function run(command: string, args: ReadonlyArray<string>, cwd: string): void {
  const result = spawnSync(command, [...args], {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${String(result.status)}.`);
  }
}

function capture(command: string, args: ReadonlyArray<string>, cwd: string): string {
  const result = spawnSync(command, [...args], {
    cwd,
    env: process.env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${String(result.status)}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function readState(paths: ManagedBuildPaths): ManagedBuildState | null {
  try {
    const state = JSON.parse(FS.readFileSync(paths.state, "utf8")) as Partial<ManagedBuildState>;
    if (
      typeof state.currentCommit !== "string" ||
      !COMMIT_PATTERN.test(state.currentCommit) ||
      (state.previousCommit !== null &&
        (typeof state.previousCommit !== "string" ||
          !COMMIT_PATTERN.test(state.previousCommit))) ||
      typeof state.trackedRef !== "string" ||
      typeof state.updatedAt !== "string"
    ) {
      return null;
    }
    return state as ManagedBuildState;
  } catch {
    return null;
  }
}

function writeState(paths: ManagedBuildPaths, state: ManagedBuildState): void {
  FS.mkdirSync(paths.home, { recursive: true });
  const temporaryPath = `${paths.state}.tmp`;
  FS.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  FS.renameSync(temporaryPath, paths.state);
}

function readPid(paths: ManagedBuildPaths): number | null {
  try {
    const pid = Number(FS.readFileSync(paths.pid, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveOriginUrl(): string {
  return capture("git", ["remote", "get-url", "origin"], REPO_ROOT);
}

function resolveRemoteUrl(remote: string): string {
  return capture("git", ["remote", "get-url", remote], REPO_ROOT);
}

function ensureManagedSource(paths: ManagedBuildPaths): void {
  if (FS.existsSync(Path.join(paths.source, ".git"))) return;
  if (FS.existsSync(paths.source)) {
    const entries = FS.readdirSync(paths.source);
    if (entries.length > 0) {
      throw new Error(`Managed source path exists but is not a Git checkout: ${paths.source}`);
    }
  }
  FS.mkdirSync(Path.dirname(paths.source), { recursive: true });
  run("git", managedBuildCloneArgs(resolveOriginUrl(), paths.source), REPO_ROOT);
}

function assertManagedSourceIsClean(paths: ManagedBuildPaths): void {
  const status = capture("git", ["status", "--porcelain", "--untracked-files=no"], paths.source);
  if (status.length > 0) {
    throw new Error(
      `Managed source has tracked local changes. Refusing to overwrite ${paths.source}.`,
    );
  }
}

function ensureRemote(paths: ManagedBuildPaths, remote: string): void {
  if (remote === "origin") return;
  const checkResult = spawnSync("git", ["remote", "get-url", remote], {
    cwd: paths.source,
    encoding: "utf8",
  });
  if (checkResult.status === 0) return;
  const url = resolveRemoteUrl(remote);
  const addResult = spawnSync("git", ["remote", "add", remote, url], {
    cwd: paths.source,
    encoding: "utf8",
  });
  if (addResult.status !== 0) {
    throw new Error(`Failed to add remote ${remote} to managed source: ${addResult.stderr.trim()}`);
  }
}

function parseRemoteAndRef(ref: string): { remote: string; branch: string } {
  const parts = ref.split("/");
  if (parts.length < 2) {
    return { remote: "origin", branch: ref };
  }
  return { remote: parts[0] ?? "origin", branch: parts.slice(1).join("/") };
}

function fetchRef(paths: ManagedBuildPaths, ref: string): string {
  const { remote, branch } = parseRemoteAndRef(ref);
  ensureRemote(paths, remote);
  run("git", ["fetch", "--prune", remote, branch], paths.source);
  const commit = capture("git", ["rev-parse", "FETCH_HEAD"], paths.source);
  if (!COMMIT_PATTERN.test(commit)) throw new Error(`Invalid fetched commit: ${commit}`);
  return commit;
}

function checkout(paths: ManagedBuildPaths, commit: string): void {
  run("git", ["checkout", "--detach", "--force", commit], paths.source);
}

function findElectronInstallScript(paths: ManagedBuildPaths): string | null {
  const bunCachePath = Path.join(paths.source, "node_modules", ".bun");
  if (!FS.existsSync(bunCachePath)) return null;
  for (const entry of FS.readdirSync(bunCachePath)) {
    if (!entry.startsWith("electron@")) continue;
    const installPath = Path.join(bunCachePath, entry, "node_modules", "electron", "install.js");
    if (FS.existsSync(installPath)) return installPath;
  }
  return null;
}

function build(paths: ManagedBuildPaths): void {
  run("sfw", ["bun", "install", "--frozen-lockfile"], paths.source);
  const electronInstallPath = findElectronInstallScript(paths);
  if (electronInstallPath !== null) {
    run("node", [electronInstallPath], paths.source);
  }
  run("bun", ["run", "build:desktop"], paths.source);
  run("bun", ["run", "release:smoke"], paths.source);
}

function currentSourceCommit(paths: ManagedBuildPaths): string | null {
  if (!FS.existsSync(Path.join(paths.source, ".git"))) return null;
  try {
    const commit = capture("git", ["rev-parse", "HEAD"], paths.source);
    return COMMIT_PATTERN.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

function stopManagedBuild(paths: ManagedBuildPaths): void {
  const pid = readPid(paths);
  if (pid === null || !isRunning(pid)) {
    FS.rmSync(paths.pid, { force: true });
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }
  }
  FS.rmSync(paths.pid, { force: true });
}

function startManagedBuild(config: ManagedBuildConfig, paths: ManagedBuildPaths): void {
  const existingPid = readPid(paths);
  if (existingPid !== null && isRunning(existingPid)) {
    console.log(`${config.displayName} is already running (pid ${String(existingPid)}).`);
    return;
  }
  const commit = currentSourceCommit(paths);
  if (
    commit === null ||
    !FS.existsSync(Path.join(paths.source, "apps/desktop/dist-electron/main.js"))
  ) {
    throw new Error(`${config.displayName} is not built. Run setup first.`);
  }
  FS.mkdirSync(paths.home, { recursive: true });
  const env = { ...process.env };
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RENDERER_PORT;
  delete env.SYNARA_AUTH_TOKEN;
  Object.assign(env, {
    SYNARA_DESKTOP_FLAVOR: config.flavor,
    SYNARA_DISABLE_AUTO_UPDATE: "1",
    SYNARA_HOME: paths.home,
    SYNARA_COMMIT_HASH: commit,
  });
  const logDescriptor = FS.openSync(paths.log, "a", 0o600);
  try {
    FS.writeSync(logDescriptor, `\n[${new Date().toISOString()}] Starting ${commit}\n`);
    const child = spawn("bun", [...managedBuildStartArgs()], {
      cwd: paths.source,
      env,
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
      shell: process.platform === "win32",
    });
    if (child.pid === undefined) {
      throw new Error(`${config.displayName} failed to return a process id.`);
    }
    child.unref();
    FS.writeFileSync(paths.pid, `${String(child.pid)}\n`, { mode: 0o600 });
    console.log(`Started ${config.displayName} at ${commit.slice(0, 12)} (pid ${String(child.pid)}).`);
    console.log(`Log: ${paths.log}`);
  } finally {
    FS.closeSync(logDescriptor);
  }
}

function updateManagedBuild(
  config: ManagedBuildConfig,
  paths: ManagedBuildPaths,
  ref: string,
): void {
  ensureManagedSource(paths);
  assertManagedSourceIsClean(paths);
  const previousCommit = currentSourceCommit(paths);
  const targetCommit = fetchRef(paths, ref);
  if (
    previousCommit === targetCommit &&
    FS.existsSync(Path.join(paths.source, "apps/desktop/dist-electron/main.js"))
  ) {
    const previousState = readState(paths);
    writeState(paths, {
      currentCommit: targetCommit,
      previousCommit: previousState?.previousCommit ?? null,
      trackedRef: ref,
      updatedAt: new Date().toISOString(),
    });
    startManagedBuild(config, paths);
    return;
  }
  stopManagedBuild(paths);
  try {
    checkout(paths, targetCommit);
    build(paths);
  } catch (error) {
    if (previousCommit !== null && previousCommit !== targetCommit) {
      console.error(`${config.displayName} update failed; restoring ${previousCommit.slice(0, 12)}.`);
      checkout(paths, previousCommit);
      build(paths);
      startManagedBuild(config, paths);
    }
    throw error;
  }
  const previousState = readState(paths);
  writeState(paths, {
    currentCommit: targetCommit,
    previousCommit:
      previousCommit !== null && previousCommit !== targetCommit
        ? previousCommit
        : (previousState?.previousCommit ?? null),
    trackedRef: ref,
    updatedAt: new Date().toISOString(),
  });
  startManagedBuild(config, paths);
}

function rollbackManagedBuild(config: ManagedBuildConfig, paths: ManagedBuildPaths): void {
  const state = readState(paths);
  if (state?.previousCommit === null || state?.previousCommit === undefined) {
    throw new Error(`${config.displayName} has no previous successful commit to restore.`);
  }
  assertManagedSourceIsClean(paths);
  stopManagedBuild(paths);
  const rollbackCommit = state.previousCommit;
  try {
    checkout(paths, rollbackCommit);
    build(paths);
  } catch (error) {
    console.error(`${config.displayName} rollback failed; restoring ${state.currentCommit.slice(0, 12)}.`);
    checkout(paths, state.currentCommit);
    build(paths);
    startManagedBuild(config, paths);
    throw error;
  }
  writeState(paths, {
    currentCommit: rollbackCommit,
    previousCommit: state.currentCommit,
    trackedRef: state.trackedRef,
    updatedAt: new Date().toISOString(),
  });
  startManagedBuild(config, paths);
}

function printStatus(config: ManagedBuildConfig, paths: ManagedBuildPaths): void {
  const state = readState(paths);
  const pid = readPid(paths);
  const running = pid !== null && isRunning(pid);
  console.log(`${config.displayName}: ${running ? `running (pid ${String(pid)})` : "stopped"}`);
  console.log(`Source: ${paths.source}`);
  console.log(`Data: ${paths.home}`);
  console.log(`Log: ${paths.log}`);
  console.log(`Commit: ${state?.currentCommit ?? currentSourceCommit(paths) ?? "not installed"}`);
  console.log(`Tracked ref: ${state?.trackedRef ?? "not configured"}`);
}

export function runManagedBuildCommand(
  config: ManagedBuildConfig,
  input: ParsedManagedBuildArgs,
  paths = resolveManagedBuildPaths(config),
): void {
  if (input.command === "setup" || input.command === "update") {
    updateManagedBuild(
      config,
      paths,
      resolveManagedBuildRef(input, readState(paths)?.trackedRef ?? null, config.defaultRef),
    );
    return;
  }
  if (input.command === "start") {
    startManagedBuild(config, paths);
    return;
  }
  if (input.command === "stop") {
    stopManagedBuild(paths);
    return;
  }
  if (input.command === "rollback") {
    rollbackManagedBuild(config, paths);
    return;
  }
  printStatus(config, paths);
}
