// FILE: RemoteAgentInstaller.test.ts
// Purpose: Exercises the RemoteAgentInstaller bootstrap against a fake ssh
//          client script (#99 PR IV). The fake keeps a "remote host" state
//          directory: the installed agent file's content is the protocol
//          version its hello reply reports, so install/verify round trips are
//          observable on disk.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ExecutionEnvironmentRuntime, ExecutionEnvironmentSshTransport } from "@synara/contracts";
import { Effect, Schema } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { makeRemoteAgentInstaller } from "./Layers/RemoteAgentInstaller";
import { REMOTE_AGENT_PROTOCOL_VERSION } from "./RemoteAgentVersion";

const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-remote-agent-installer-"));
const fakeSshPath = path.join(tempDir, "fake-ssh.cjs");
const fakeScpPath = path.join(tempDir, "fake-scp.cjs");
const bundlePath = path.join(tempDir, "remote-agent.cjs");

// The local "bundle" carries the protocol version as its content; whatever
// ends up installed on the fake remote host is the version hello reports.
writeFileSync(bundlePath, REMOTE_AGENT_PROTOCOL_VERSION);

// Fake ssh: last argv element (after --) is the remote command. The state dir
// (FAKE_SSH_STATE_DIR) is the remote host: installed.cjs is the agent binary,
// mode-* marker files inject failures, log.ndjson records every invocation.
writeFileSync(
  fakeSshPath,
  `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync, copyFileSync } = require("node:fs");
const { join } = require("node:path");

const stateDir = process.env.FAKE_SSH_STATE_DIR;
const command = process.argv[process.argv.length - 1];
appendFileSync(join(stateDir, "log.ndjson"), JSON.stringify({ tool: "ssh", command }) + "\\n");

if (existsSync(join(stateDir, "mode-connection-fail"))) {
  process.stderr.write("ssh: connect to host remote.example port 22: Connection refused\\n");
  process.exit(255);
}

const readStdin = (callback) => {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => callback(data));
};

const installedPath = join(stateDir, "installed.cjs");
if (command.startsWith("exec node ")) {
  if (!existsSync(installedPath)) {
    process.stderr.write("node: cannot find module\\n");
    process.exit(1);
  }
  const protocolVersion = readFileSync(installedPath, "utf8").trim();
  readStdin((data) => {
    const request = JSON.parse(data.split("\\n")[0]);
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { agentVersion: "fake-agent", protocolVersion },
      }) + "\\n",
    );
    process.exit(0);
  });
} else if (command.startsWith("mkdir -p ")) {
  if (existsSync(join(stateDir, "mode-mkdir-fail"))) {
    process.stderr.write("mkdir: permission denied\\n");
    process.exit(1);
  }
  process.exit(0);
} else if (command.startsWith("base64 -d > ")) {
  readStdin((data) => {
    writeFileSync(join(stateDir, "staged.cjs"), Buffer.from(data.trim(), "base64"));
    process.exit(0);
  });
} else if (command.startsWith("mv -f ")) {
  if (existsSync(join(stateDir, "mode-verify-fail"))) {
    // Simulate a move that silently loses the file: verification must catch it.
    process.exit(0);
  }
  copyFileSync(join(stateDir, "staged.cjs"), installedPath);
  process.exit(0);
} else {
  process.stderr.write("fake-ssh: unexpected command: " + command + "\\n");
  process.exit(2);
}
`,
);
chmodSync(fakeSshPath, 0o755);

// Fake scp: stages the local file into the state dir, like the base64 path.
writeFileSync(
  fakeScpPath,
  `#!/usr/bin/env node
const { appendFileSync, copyFileSync } = require("node:fs");
const { join } = require("node:path");
const stateDir = process.env.FAKE_SSH_STATE_DIR;
appendFileSync(join(stateDir, "log.ndjson"), JSON.stringify({ tool: "scp" }) + "\\n");
const localPath = process.argv[process.argv.length - 2];
copyFileSync(localPath, join(stateDir, "staged.cjs"));
process.exit(0);
`,
);
chmodSync(fakeScpPath, 0o755);

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const transport = Schema.decodeUnknownSync(ExecutionEnvironmentSshTransport)({
  host: "remote.example",
});
const runtime = Schema.decodeUnknownSync(ExecutionEnvironmentRuntime)({
  runtimeType: "ssh-process",
});
const descriptor = { transport, runtime };

const missingScpPath = path.join(tempDir, "no-such-scp");

function makeState(): { stateDir: string; log: () => Array<{ tool: string; command?: string }> } {
  const stateDir = mkdtempSync(path.join(tempDir, "state-"));
  process.env.FAKE_SSH_STATE_DIR = stateDir;
  return {
    stateDir,
    log: () =>
      readFileSync(path.join(stateDir, "log.ndjson"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { tool: string; command?: string }),
  };
}

const makeInstaller = (scpBinaryPath: string = missingScpPath) =>
  makeRemoteAgentInstaller({ sshBinaryPath: fakeSshPath, scpBinaryPath, bundlePath });

const installedContent = (stateDir: string) =>
  readFileSync(path.join(stateDir, "installed.cjs"), "utf8");

describe("RemoteAgentInstaller", () => {
  it("does not copy when the installed agent already matches the protocol version", async () => {
    const { stateDir, log } = makeState();
    writeFileSync(path.join(stateDir, "installed.cjs"), REMOTE_AGENT_PROTOCOL_VERSION);

    await Effect.runPromise(makeInstaller().ensureAgentInstalled(descriptor));

    const commands = log().map((entry) => entry.command ?? "");
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^exec node /);
    expect(installedContent(stateDir)).toBe(REMOTE_AGENT_PROTOCOL_VERSION);
  });

  it("installs via the base64-over-ssh fallback when the agent is missing and scp is unavailable", async () => {
    const { stateDir, log } = makeState();

    await Effect.runPromise(makeInstaller().ensureAgentInstalled(descriptor));

    expect(installedContent(stateDir)).toBe(REMOTE_AGENT_PROTOCOL_VERSION);
    const commands = log().map((entry) => entry.command ?? "");
    expect(commands.some((command) => command.startsWith("mkdir -p "))).toBe(true);
    expect(commands.some((command) => command.startsWith("base64 -d > "))).toBe(true);
    expect(commands.some((command) => command.startsWith("mv -f "))).toBe(true);
    // Probe before install and verify after.
    expect(commands.filter((command) => command.startsWith("exec node "))).toHaveLength(2);
  });

  it("reinstalls on a protocol version mismatch", async () => {
    const { stateDir } = makeState();
    writeFileSync(path.join(stateDir, "installed.cjs"), "9.9.9");

    await Effect.runPromise(makeInstaller().ensureAgentInstalled(descriptor));

    expect(installedContent(stateDir)).toBe(REMOTE_AGENT_PROTOCOL_VERSION);
  });

  it("copies through scp when the client is available", async () => {
    const { stateDir, log } = makeState();

    await Effect.runPromise(makeInstaller(fakeScpPath).ensureAgentInstalled(descriptor));

    expect(installedContent(stateDir)).toBe(REMOTE_AGENT_PROTOCOL_VERSION);
    expect(log().some((entry) => entry.tool === "scp")).toBe(true);
    expect(log().some((entry) => (entry.command ?? "").startsWith("base64 -d > "))).toBe(false);
  });

  it("fails with SshConnectionFailedError when ssh cannot connect", async () => {
    const { stateDir } = makeState();
    writeFileSync(path.join(stateDir, "mode-connection-fail"), "");

    const error = await Effect.runPromise(
      makeInstaller().ensureAgentInstalled(descriptor).pipe(Effect.flip),
    );
    expect(error._tag).toBe("SshConnectionFailedError");
  });

  it("fails with InstallDirectoryCreationFailedError when mkdir fails", async () => {
    const { stateDir } = makeState();
    writeFileSync(path.join(stateDir, "mode-mkdir-fail"), "");

    const error = await Effect.runPromise(
      makeInstaller().ensureAgentInstalled(descriptor).pipe(Effect.flip),
    );
    expect(error._tag).toBe("InstallDirectoryCreationFailedError");
    expect(existsSync(path.join(stateDir, "installed.cjs"))).toBe(false);
  });

  it("fails with VerificationFailedError when the installed agent does not answer hello", async () => {
    const { stateDir } = makeState();
    writeFileSync(path.join(stateDir, "mode-verify-fail"), "");

    const error = await Effect.runPromise(
      makeInstaller().ensureAgentInstalled(descriptor).pipe(Effect.flip),
    );
    expect(error._tag).toBe("VerificationFailedError");
  });

  it("fails with ProtocolVersionMismatchError when the local bundle itself is stale", async () => {
    const { stateDir } = makeState();
    const staleBundlePath = path.join(tempDir, "stale-bundle.cjs");
    writeFileSync(staleBundlePath, "0.0.9");

    const installer = makeRemoteAgentInstaller({
      sshBinaryPath: fakeSshPath,
      scpBinaryPath: missingScpPath,
      bundlePath: staleBundlePath,
    });
    const error = await Effect.runPromise(
      installer.ensureAgentInstalled(descriptor).pipe(Effect.flip),
    );
    expect(error._tag).toBe("ProtocolVersionMismatchError");
    expect(installedContent(stateDir)).toBe("0.0.9");
  });
});
