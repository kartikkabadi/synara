import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { spawnProcess } from "@synara/shared/processRuntime";
import { RemoteAgent } from "./agent";
import {
  defaultJournalDir,
  endpointHash,
  ensurePrivateDirectory,
  errorCode,
  openPrivateFile,
} from "./storage";

function endpointPaths(id: string) {
  if (process.platform === "win32") throw new Error("Remote agents require a POSIX host");
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(id)) throw new Error("Invalid remote-agent endpoint id");
  const directory =
    process.env.SYNARA_AGENT_RUNTIME_DIR ??
    join(realpathSync(tmpdir()), `synara-agent-${process.getuid!()}`);
  ensurePrivateDirectory(directory);
  const key = endpointHash(id).slice(0, 32);
  const socket = join(directory, `${key}.sock`);
  if (Buffer.byteLength(socket) > 100) throw new Error("Remote-agent socket path is too long");
  return { socket, lock: join(directory, `${key}.lock`), log: join(directory, `${key}.log`), key };
}

function socketStat(path: string): Stats | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new Error(`Unsafe remote-agent socket: ${path}`);
    }
    return stat;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function connect(socketPath: string): Promise<Socket> {
  if (!socketStat(socketPath))
    throw Object.assign(new Error("Agent socket not ready"), { code: "ENOENT" });
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(
      () => socket.destroy(new Error("Agent socket connection timed out")),
      1_000,
    );
    socket.once("error", reject);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", reject);
      // The relay installs its own error handler after this promise settles.
      socket.on("error", () => {});
      resolve(socket);
    });
    socket.once("close", () => clearTimeout(timer));
  });
}

function sameFile(path: string, original: Stats): boolean {
  try {
    const current = lstatSync(path);
    return current.dev === original.dev && current.ino === original.ino;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function acquireLock(lock: string, socket: string): () => void {
  // Serializes creation and stale-owner recovery. An interrupted, empty guard
  // is preserved for operator inspection rather than risking another owner.
  const recovery = `${lock}.recovery`;
  mkdirSync(recovery, { mode: 0o700 });
  try {
    return acquireGuardedLock(lock, socket);
  } finally {
    rmdirSync(recovery);
  }
}

function acquireGuardedLock(lock: string, socket: string): () => void {
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const before = lstatSync(lock);
    if (!before.isDirectory() || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0) {
      throw new Error("Unsafe remote-agent owner directory");
    }
    const owner = join(lock, "owner");
    const fd = openPrivateFile(owner, constants.O_RDONLY);
    let pid: number;
    try {
      const raw = readFileSync(fd, "utf8");
      if (!/^\d{1,10}\n$/.test(raw)) throw new Error("Invalid remote-agent owner metadata");
      pid = Number(raw.trim());
      if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid remote-agent owner PID");
    } finally {
      closeSync(fd);
    }
    try {
      process.kill(pid, 0);
      throw new Error("Remote-agent endpoint already has a live owner");
    } catch (cause) {
      if (errorCode(cause) !== "ESRCH") throw cause;
    }
    // Only a proven dead owner can leave a stale socket. No blind unlink on
    // connection errors: those can also mean a busy or starting live daemon.
    if (!sameFile(lock, before)) throw new Error("Remote-agent owner changed during recovery");
    const staleSocket = socketStat(socket);
    if (staleSocket && sameFile(socket, staleSocket)) unlinkSync(socket);
    unlinkSync(owner);
    rmdirSync(lock); // Unknown files are preserved and make recovery fail closed.
    mkdirSync(lock, { mode: 0o700 });
  }
  const ownership = lstatSync(lock);
  const owner = join(lock, "owner");
  const fd = openPrivateFile(owner, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    writeFileSync(fd, `${process.pid}\n`);
  } finally {
    closeSync(fd);
  }
  return () => {
    if (!sameFile(lock, ownership)) return;
    unlinkSync(owner);
    rmdirSync(lock);
  };
}

export async function runDaemon(id: string): Promise<void> {
  process.umask(0o077);
  const paths = endpointPaths(id);
  const release = acquireLock(paths.lock, paths.socket);
  let ownedSocket: Stats | undefined;
  let current: Socket | undefined;
  let stopping = false;
  const server = createServer((socket) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    current?.destroy();
    current = socket;
    agent.attachInput(socket, socket);
  });
  const agentRoot = defaultJournalDir();
  ensurePrivateDirectory(agentRoot);
  const endpoints = join(agentRoot, "endpoints");
  ensurePrivateDirectory(endpoints);
  const agent = new RemoteAgent(null, {
    journalDir: join(endpoints, paths.key),
    onFatal: (error) => {
      void shutdown(error);
    },
  });
  const shutdown = async (failure?: unknown) => {
    if (stopping) return;
    stopping = true;
    server.close();
    current?.destroy();
    let exitCode = failure ? 1 : 0;
    if (failure) process.stderr.write(`synara-remote-agent: ${String(failure)}\n`);
    try {
      await agent.shutdown();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`synara-remote-agent: cleanup failed: ${String(error)}\n`);
    }
    try {
      if (ownedSocket && sameFile(paths.socket, ownedSocket)) unlinkSync(paths.socket);
      release();
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`synara-remote-agent: endpoint cleanup failed: ${String(error)}\n`);
    }
    process.exit(exitCode);
  };
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("uncaughtException", (error) => {
    void shutdown(error);
  });
  process.on("unhandledRejection", (error) => {
    void shutdown(error);
  });
  server.on("error", (error) => {
    void shutdown(error);
  });
  server.listen(paths.socket, () => {
    chmodSync(paths.socket, 0o600);
    ownedSocket = socketStat(paths.socket);
  });
}

export async function connectDaemon(id: string): Promise<void> {
  const paths = endpointPaths(id);
  const deadline = Date.now() + 10_000;
  let launched = false;
  let socket: Socket | undefined;
  while (!socket) {
    try {
      socket = await connect(paths.socket);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ECONNREFUSED") throw error;
      if (Date.now() >= deadline)
        throw new Error(`Remote-agent startup timed out; inspect ${paths.log}`);
      if (!launched) {
        const entrypoint = process.argv[1];
        if (!entrypoint) throw new Error("Missing remote-agent entrypoint");
        const log = openPrivateFile(
          paths.log,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
        );
        try {
          const daemon = spawnProcess(process.execPath, [entrypoint, "--daemon", id], {
            ownProcessGroup: true,
            stdio: ["ignore", log, log],
            env: process.env,
          });
          await new Promise<void>((resolve, reject) => {
            daemon.once("spawn", resolve);
            daemon.once("error", reject);
          });
          daemon.unref();
        } finally {
          closeSync(log);
        }
        launched = true;
      }
      await delay(50);
    }
  }
  const relay = socket;
  const disconnect = () => {
    process.stdin.unpipe(relay);
    process.stdin.pause();
    process.stdin.destroy();
    relay.destroy();
  };
  relay.on("error", (error) => {
    process.stderr.write(`synara-remote-agent: transport failed: ${error.message}\n`);
    process.exitCode = 1;
    disconnect();
  });
  relay.once("close", disconnect);
  process.stdin.on("error", disconnect);
  process.stdout.on("error", disconnect);
  process.on("SIGINT", disconnect);
  process.on("SIGTERM", disconnect);
  process.stdin.pipe(relay);
  relay.pipe(process.stdout);
}
