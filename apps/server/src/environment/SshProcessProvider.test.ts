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

// Mock ssh: records its argv, prints a fake remote PID first (like
// `echo $$ && ...` does on a real host), then JSON-RPC frames on stdout and
// diagnostics on stderr, and exits with MOCK_SSH_EXIT_CODE.
writeFileSync(
  mockSshPath,
  [
    "#!/usr/bin/env bash",
    'printf "%s\\n" "$@" > "$MOCK_SSH_ARGV_FILE"',
    "echo 4242",
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

function spawnMock(exitCode?: number): Promise<SshSpawnedProcess> {
  const provider = makeSshProcessProvider(mockSshPath);
  return Effect.runPromise(
    provider.spawnSsh(plan, {
      cwd: tempDir,
      env: {
        ...process.env,
        MOCK_SSH_ARGV_FILE: argvFile,
        ...(exitCode !== undefined ? { MOCK_SSH_EXIT_CODE: String(exitCode) } : {}),
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
    expect(argv.at(-1)).toBe("echo $$ && cd '/srv/workspaces/repo' && exec 'codex' app-server");
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
});
