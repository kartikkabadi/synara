import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { ExecutionProfile } from "@synara/contracts";

import { makeSshProcessProvider } from "./Layers/SshProcessProvider";
import type { SshSpawnPlan } from "./Services/RemoteEnvironmentResolver";
import type { SshSpawnedProcess } from "./Services/SshProcessProvider";
import { buildRemoteCommand } from "./sshCommand";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-mock-ssh-"));
const argvFile = path.join(tempDir, "argv.txt");
const mockSshPath = path.join(tempDir, "mock-ssh");

// Mock ssh: records its argv, prints the sentinel remote PID line first (like
// the remote command does on a real host), then JSON-RPC frames on stdout and
// diagnostics on stderr, and exits with MOCK_SSH_EXIT_CODE. MOCK_SSH_BANNER
// prints an unexpected line before the sentinel; MOCK_SSH_SPLIT_PID writes the
// sentinel line across two chunks.
writeFileSync(
  mockSshPath,
  [
    "#!/usr/bin/env bash",
    'printf "%s\\n" "$@" > "$MOCK_SSH_ARGV_FILE"',
    'if [ -n "$MOCK_SSH_BANNER" ]; then echo "Welcome to mock host"; fi',
    'if [ -n "$MOCK_SSH_SPLIT_PID" ]; then',
    '  printf "__SYNARA_REMO"',
    "  sleep 0.05",
    '  printf "TE_PID__=4242\\n"',
    "else",
    '  echo "__SYNARA_REMOTE_PID__=4242"',
    "fi",
    `echo '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'`,
    `echo '{"jsonrpc":"2.0","method":"sessionConfigured"}'`,
    'echo "mock-ssh diagnostics" >&2',
    'exit "${MOCK_SSH_EXIT_CODE:-0}"',
    "",
  ].join("\n"),
);
chmodSync(mockSshPath, 0o755);

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const executionProfile = Schema.decodeUnknownSync(ExecutionProfile)({
  environmentId: "env-ssh",
  providerKind: "codex",
  remoteWorkspaceRoot: "/srv/workspaces/repo",
});

const remoteCommand = buildRemoteCommand(
  { runtimeType: "ssh-process", supervisor: "none", forwardedEnvNames: [] },
  executionProfile,
);

const plan: SshSpawnPlan = {
  kind: "ssh",
  sshArgs: ["-o", "BatchMode=yes", "example.test", "--", remoteCommand],
  remoteCommand,
};

function spawnMock(
  exitCode?: number,
  extra?: { readonly env?: Record<string, string>; readonly cwd?: string; readonly ssh?: string },
): Promise<SshSpawnedProcess> {
  const provider = makeSshProcessProvider(extra?.ssh ?? mockSshPath);
  return Effect.runPromise(
    provider.spawnSsh(plan, {
      cwd: extra?.cwd ?? tempDir,
      env: {
        ...process.env,
        MOCK_SSH_ARGV_FILE: argvFile,
        ...(exitCode !== undefined ? { MOCK_SSH_EXIT_CODE: String(exitCode) } : {}),
        ...extra?.env,
      },
    }),
  );
}

function collectStdout(spawned: SshSpawnedProcess): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    spawned.child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    spawned.child.stdout.on("end", () => resolve(stdout));
  });
}

describe("SshProcessProvider (mock ssh)", () => {
  it("consumes the remote PID line and streams the remaining stdout frames", async () => {
    const spawned = await spawnMock();
    const stdout = await collectStdout(spawned);
    const exit = await spawned.exit;

    expect(await spawned.remotePid).toBe(4242);
    expect(stdout).not.toContain("4242");
    expect(stdout.split("\n").filter(Boolean)).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      '{"jsonrpc":"2.0","method":"sessionConfigured"}',
    ]);
    expect(exit.kind).toBe("clean");
  });

  it("passes the plan argv through, ending with the remote command", async () => {
    const spawned = await spawnMock();
    await spawned.exit;

    const argv = readFileSync(argvFile, "utf8").trim().split("\n");
    expect(argv).toEqual([...plan.sshArgs]);
    expect(argv.at(-1)).toBe(
      "echo \"__SYNARA_REMOTE_PID__=$$\" && cd '/srv/workspaces/repo' && exec 'codex' app-server",
    );
  });

  it("captures stderr without parsing it into stdout", async () => {
    const spawned = await spawnMock();
    const stderrChunks: string[] = [];
    spawned.onStderr((chunk) => stderrChunks.push(chunk));
    const stdout = await collectStdout(spawned);
    await spawned.exit;

    expect(stderrChunks.join("")).toContain("mock-ssh diagnostics");
    expect(stdout).not.toContain("mock-ssh diagnostics");
  });

  it("classifies exit code 255 as an ssh transport error", async () => {
    const spawned = await spawnMock(255);
    const exit = await spawned.exit;

    expect(exit.kind).toBe("ssh-transport-error");
    if (exit.kind === "ssh-transport-error") {
      expect(exit.error._tag).toBe("SshTransportError");
      expect(exit.error.stderrTail).toContain("mock-ssh diagnostics");
    }
  });

  it("classifies other non-zero exit codes as provider process errors", async () => {
    const spawned = await spawnMock(3);
    const exit = await spawned.exit;

    expect(exit.kind).toBe("provider-process-error");
    if (exit.kind === "provider-process-error") {
      expect(exit.error._tag).toBe("ProviderProcessError");
      expect(exit.error.exitCode).toBe(3);
    }
  });

  it("kill() signals the local ssh child and is a no-op after exit", async () => {
    const spawned = await spawnMock();
    await spawned.exit;
    expect(() => spawned.kill("SIGTERM")).not.toThrow();
  });

  it("reassembles the sentinel PID line when it is split across chunks", async () => {
    const spawned = await spawnMock(undefined, { env: { MOCK_SSH_SPLIT_PID: "1" } });
    const stdout = await collectStdout(spawned);

    expect(await spawned.remotePid).toBe(4242);
    expect(stdout).not.toContain("4242");
    expect(stdout).toContain('"sessionConfigured"');
  });

  it("fails loudly when unexpected output precedes the sentinel PID line", async () => {
    const spawned = await spawnMock(undefined, { env: { MOCK_SSH_BANNER: "1" } });
    const streamError = new Promise<Error>((resolve) => {
      spawned.child.stdout.once("error", resolve);
    });

    expect(await spawned.remotePid).toBeNull();
    expect((await streamError).message).toContain("Remote PID sentinel violation");
  });

  it("does not run ssh from the remote workspace root (which may not exist locally)", async () => {
    const spawned = await spawnMock(undefined, { cwd: "/nonexistent/remote/workspace/root" });
    const stdout = await collectStdout(spawned);
    const exit = await spawned.exit;

    expect(exit.kind).toBe("clean");
    expect(await spawned.remotePid).toBe(4242);
    expect(stdout).toContain('"sessionConfigured"');
  });

  it("classifies a nonexistent ssh binary as an ssh transport error", async () => {
    const spawned = await spawnMock(undefined, {
      ssh: path.join(tempDir, "no-such-ssh-binary"),
    });
    const exit = await spawned.exit;

    expect(exit.kind).toBe("ssh-transport-error");
    if (exit.kind === "ssh-transport-error") {
      expect(exit.error.reason).toContain("failed to spawn ssh");
    }
    expect(await spawned.remotePid).toBeNull();
  });
});
