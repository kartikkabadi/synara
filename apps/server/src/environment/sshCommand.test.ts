import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  ExecutionEnvironmentRuntime,
  ExecutionEnvironmentSshTransport,
  ExecutionProfile,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, it } from "vitest";

import {
  buildRemoteCommand,
  buildSshArgv,
  buildSshCommandString,
  posixQuote,
  SshCommandError,
} from "./sshCommand.ts";

const decodeTransport = Schema.decodeUnknownSync(ExecutionEnvironmentSshTransport);
const decodeRuntime = Schema.decodeUnknownSync(ExecutionEnvironmentRuntime);
const decodeProfile = Schema.decodeUnknownSync(ExecutionProfile);

const transport = (overrides: Record<string, unknown> = {}) =>
  decodeTransport({ host: "build.example.com", ...overrides });
const runtime = (overrides: Record<string, unknown> = {}) =>
  decodeRuntime({ runtimeType: "ssh-process", ...overrides });
const profile = (overrides: Record<string, unknown> = {}) =>
  decodeProfile({
    environmentId: "5f0c6c86-1f0e-4d54-9e39-cf6f4f3f2a10",
    providerKind: "codex",
    remoteWorkspaceRoot: "/srv/workspaces/repo",
    ...overrides,
  });

describe("posixQuote", () => {
  it("wraps values in single quotes", () => {
    assert.equal(posixQuote("/srv/work"), "'/srv/work'");
  });

  it("escapes embedded single quotes", () => {
    assert.equal(posixQuote("it's here"), "'it'\\''s here'");
  });

  it("neutralizes shell metacharacters", () => {
    assert.equal(posixQuote("$HOME && rm -rf /"), "'$HOME && rm -rf /'");
  });
});

// Parser-faithful fixture replicating OpenSSH argv handling: options taking
// an argument consume the next token, `--` terminates option parsing, the
// first non-option token is the destination, and every remaining token is
// joined with spaces to form the remote command.
const OPTIONS_WITH_ARG = new Set(["-p", "-i", "-F", "-J", "-o", "-l", "-b", "-c", "-e"]);

function parseLikeOpenSsh(argv: readonly string[]): {
  destination: string;
  remoteCommand: string;
} {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    assert.ok(token !== undefined);
    if (token === "--") {
      index += 1;
      break;
    }
    if (token.startsWith("-")) {
      index += OPTIONS_WITH_ARG.has(token) ? 2 : 1;
      continue;
    }
    break;
  }
  const destination = argv[index];
  assert.ok(destination !== undefined, "argv has no destination");
  assert.ok(!destination.startsWith("-"), `destination parses as an option: ${destination}`);
  return { destination, remoteCommand: argv.slice(index + 1).join(" ") };
}

describe("buildSshArgv", () => {
  it("builds a minimal argv with defaults", () => {
    assert.deepEqual(buildSshArgv(transport(), runtime(), profile()), [
      "-o",
      "BatchMode=yes",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "StrictHostKeyChecking=yes",
      "--",
      "build.example.com",
      "echo $$ && cd '/srv/workspaces/repo' && exec 'codex' app-server",
    ]);
  });

  it("parses to the exact destination and remote command under OpenSSH rules", () => {
    const argv = buildSshArgv(
      transport({ port: 2222, user: "deploy", identityFile: "/keys/id_ed25519" }),
      runtime({ forwardedEnvNames: ["HTTP_PROXY"] }),
      profile(),
    );
    assert.deepEqual(parseLikeOpenSsh(argv), {
      destination: "deploy@build.example.com",
      remoteCommand: "echo $$ && cd '/srv/workspaces/repo' && exec 'codex' app-server",
    });
  });

  it("resolves through a real OpenSSH client via ssh -G", () => {
    const argv = buildSshArgv(transport({ port: 2222, user: "deploy" }), runtime(), profile());
    const resolved = execFileSync("ssh", ["-G", ...argv], { encoding: "utf8" });
    assert.match(resolved, /^user deploy$/m);
    assert.match(resolved, /^port 2222$/m);
    assert.match(resolved, /^hostname build\.example\.com$/m);
    assert.match(resolved, /^batchmode yes$/m);
    assert.match(resolved, /^clearallforwardings yes$/m);
    assert.match(resolved, /^stricthostkeychecking (yes|true)$/m);
    assert.match(resolved, /^serveraliveinterval 15$/m);
    assert.match(resolved, /^serveralivecountmax 3$/m);
  });

  it("places the option terminator before the destination", () => {
    const argv = buildSshArgv(transport(), runtime(), profile());
    assert.equal(argv.indexOf("--"), argv.length - 3);
    assert.equal(argv[argv.length - 2], "build.example.com");
    assert.ok(argv[argv.length - 1]?.startsWith("echo $$ && "));
  });

  it("maps port, identity file, ssh config, jump host, and user", () => {
    const argv = buildSshArgv(
      transport({
        port: 2222,
        user: "deploy",
        identityFile: "/keys/id_ed25519",
        sshConfigPath: "/etc/ssh/alt_config",
        jumpHost: "bastion.example.com",
      }),
      runtime(),
      profile(),
    );
    assert.deepEqual(argv.slice(0, 10), [
      "-o",
      "BatchMode=yes",
      "-p",
      "2222",
      "-i",
      "/keys/id_ed25519",
      "-F",
      "/etc/ssh/alt_config",
      "-J",
      "bastion.example.com",
    ]);
    assert.ok(argv.includes("deploy@build.example.com"));
  });

  it("omits -p for the default port 22", () => {
    assert.ok(!buildSshArgv(transport(), runtime(), profile()).includes("-p"));
  });

  it("adds HostKeyAlias for pinned-fingerprint verification", () => {
    const argv = buildSshArgv(
      transport({
        hostKeyVerification: "pinned-fingerprint",
        hostKeyFingerprint: "SHA256:abc",
      }),
      runtime(),
      profile(),
    );
    assert.ok(argv.includes("StrictHostKeyChecking=yes"));
    assert.ok(argv.includes("HostKeyAlias=build.example.com"));
  });

  it("rejects pinned-fingerprint without a fingerprint", () => {
    assert.throws(
      () =>
        buildSshArgv(
          transport({ hostKeyVerification: "pinned-fingerprint" }),
          runtime(),
          profile(),
        ),
      SshCommandError,
    );
  });

  it("forwards env names via SendEnv without values", () => {
    const argv = buildSshArgv(
      transport(),
      runtime({ forwardedEnvNames: ["OPENAI_API_KEY", "HTTP_PROXY"] }),
      profile(),
    );
    assert.ok(argv.includes("SendEnv=OPENAI_API_KEY"));
    assert.ok(argv.includes("SendEnv=HTTP_PROXY"));
    assert.ok(argv.every((entry) => !entry.includes("$OPENAI_API_KEY")));
  });

  it("rejects invalid forwarded env names", () => {
    assert.throws(
      () => buildSshArgv(transport(), runtime({ forwardedEnvNames: ["BAD NAME"] }), profile()),
      SshCommandError,
    );
  });

  it("rejects non-ssh-process runtimes", () => {
    assert.throws(
      () => buildSshArgv(transport(), decodeRuntime({ runtimeType: "local" }), profile()),
      SshCommandError,
    );
  });

  it("rejects hosts that look like CLI options", () => {
    assert.throws(
      () => buildSshArgv({ ...transport(), host: "-oProxyCommand=evil" }, runtime(), profile()),
      SshCommandError,
    );
  });

  it("rejects users that look like CLI options", () => {
    assert.throws(
      () => buildSshArgv({ ...transport(), user: "-oProxyCommand=evil" }, runtime(), profile()),
      SshCommandError,
    );
  });

  it("rejects out-of-range ports", () => {
    for (const port of [0, 65_536, 1.5]) {
      assert.throws(
        () => buildSshArgv({ ...transport(), port }, runtime(), profile()),
        SshCommandError,
      );
    }
  });
});

describe("buildRemoteCommand", () => {
  it("captures the remote PID before exec", () => {
    assert.ok(buildRemoteCommand(runtime(), profile()).startsWith("echo $$ && "));
  });

  it("quotes workspace roots and binary paths with special characters", () => {
    const command = buildRemoteCommand(
      runtime({ remoteBinaryPath: "/opt/agent tools/codex" }),
      profile({ remoteWorkspaceRoot: "/srv/it's a dir" }),
    );
    assert.equal(
      command,
      "echo $$ && cd '/srv/it'\\''s a dir' && exec '/opt/agent tools/codex' app-server",
    );
  });

  it("defaults the remote binary to codex", () => {
    assert.ok(buildRemoteCommand(runtime(), profile()).includes("exec 'codex' app-server"));
  });

  it("rejects an empty workspace root", () => {
    assert.throws(
      () => buildRemoteCommand(runtime(), { ...profile(), remoteWorkspaceRoot: "  " }),
      SshCommandError,
    );
  });
});

describe("buildSshCommandString", () => {
  it("prefixes ssh and terminates options before the destination", () => {
    const rendered = buildSshCommandString(transport(), runtime(), profile());
    assert.ok(rendered.startsWith("ssh -o BatchMode=yes"));
    assert.ok(rendered.includes(" -- build.example.com echo $$ && cd "));
  });
});
