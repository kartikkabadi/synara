// FILE: remoteSetupPlan.test.ts
// Purpose: Unit coverage for the pure `synara setup` plan builders — env-file
//          and systemd-unit rendering, Tailscale status parsing, public-URL
//          validation, and pairing URL construction.
// Layer: Server remote-setup planner tests

import { describe, expect, it } from "vitest";

import {
  buildPairingUrl,
  buildSetupEnvironment,
  detectPrimaryLanIpv4,
  environmentFilePath,
  generateRemoteAuthToken,
  isPermissionFailure,
  isUnknownFlagFailure,
  isWildcardHost,
  localProbeOrigin,
  parseTailscaleServeStatus,
  parseTailscaleStatus,
  publicFacingOrigin,
  renderEnvironmentAssignment,
  renderEnvironmentFile,
  renderManualStartInstructions,
  renderSystemdUserService,
  shellQuotePath,
  systemdQuotePath,
  systemdUserUnitDirectory,
  tailscaleDiagnostic,
  validatePublicOrigin,
  type RemoteSetupConfig,
} from "./remoteSetupPlan";

const baseConfig = (overrides: Partial<RemoteSetupConfig> = {}): RemoteSetupConfig => ({
  mode: "tailscale",
  baseDir: "/home/u/.synara",
  port: 3773,
  host: "127.0.0.1",
  publicUrl: "https://vps.example.ts.net",
  authToken: "tok_123",
  allowInsecureRemote: false,
  ...overrides,
});

describe("renderEnvironmentAssignment", () => {
  it("leaves shell-safe values unquoted", () => {
    expect(renderEnvironmentAssignment("SYNARA_HOST", "127.0.0.1")).toBe("SYNARA_HOST=127.0.0.1");
    expect(renderEnvironmentAssignment("SYNARA_PUBLIC_URL", "https://a.b.ts.net")).toBe(
      "SYNARA_PUBLIC_URL=https://a.b.ts.net",
    );
  });

  it("single-quotes values with spaces", () => {
    expect(renderEnvironmentAssignment("X", "a b")).toBe("X='a b'");
  });

  it("escapes embedded single quotes POSIX-style", () => {
    expect(renderEnvironmentAssignment("X", "it's")).toBe("X='it'\\''s'");
  });
});

describe("buildSetupEnvironment / renderEnvironmentFile", () => {
  it("emits all remote-mode entries", () => {
    const env = buildSetupEnvironment(baseConfig());
    expect(env).toContainEqual(["SYNARA_HOME", "/home/u/.synara"]);
    expect(env).toContainEqual(["SYNARA_HOST", "127.0.0.1"]);
    expect(env).toContainEqual(["SYNARA_PORT", "3773"]);
    expect(env).toContainEqual(["SYNARA_AUTH_TOKEN", "tok_123"]);
    expect(env).toContainEqual(["SYNARA_PUBLIC_URL", "https://vps.example.ts.net"]);
    expect(env).toContainEqual(["SYNARA_NO_BROWSER", "1"]);
    expect(env.some(([k]) => k === "SYNARA_ALLOW_INSECURE_REMOTE")).toBe(false);
  });

  it("omits public URL and adds allow-insecure for LAN mode", () => {
    const env = buildSetupEnvironment(
      baseConfig({
        mode: "insecure-lan",
        host: "0.0.0.0",
        publicUrl: undefined,
        allowInsecureRemote: true,
      }),
    );
    expect(env.some(([k]) => k === "SYNARA_PUBLIC_URL")).toBe(false);
    expect(env).toContainEqual(["SYNARA_ALLOW_INSECURE_REMOTE", "1"]);
  });

  it("never writes an empty auth token entry for loopback", () => {
    const env = buildSetupEnvironment(
      baseConfig({ mode: "loopback", publicUrl: undefined, authToken: "" }),
    );
    expect(env.some(([k]) => k === "SYNARA_AUTH_TOKEN")).toBe(false);
    const rendered = renderEnvironmentFile(baseConfig({ authToken: "tok with space" }));
    expect(rendered).toContain("SYNARA_AUTH_TOKEN='tok with space'");
    expect(rendered.startsWith("# Synara remote setup")).toBe(true);
  });
});

describe("renderSystemdUserService", () => {
  it("keeps the token out of ExecStart and points at the env file", () => {
    const unit = renderSystemdUserService({
      serviceName: "synara",
      envFilePath: "/home/u/.synara/synara.env",
      executablePath: "/opt/node/bin/node",
      entrypointPath: "/opt/synara/dist/index.mjs",
    });
    expect(unit).toContain('EnvironmentFile="/home/u/.synara/synara.env"');
    expect(unit).toContain('ExecStart="/opt/node/bin/node" "/opt/synara/dist/index.mjs"');
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("[Install]");
    expect(unit).not.toContain("tok");
  });

  it("self-heals without letting a crashed child take down the unit", () => {
    const unit = renderSystemdUserService({
      serviceName: "synara",
      envFilePath: "/e/synara.env",
      executablePath: "/n",
      entrypointPath: "/s/dist/index.mjs",
      workingDirectory: "/d",
      logFilePath: "/d/logs/server.log",
    });
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("OOMPolicy=continue");
    expect(unit).toContain("StartLimitIntervalSec=300");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit).toContain('WorkingDirectory="/d"');
    expect(unit).toContain('StandardOutput=append:"/d/logs/server.log"');
  });
});

describe("parseTailscaleStatus", () => {
  it("extracts DNS name, IPv4, and backend state", () => {
    const raw = JSON.stringify({
      BackendState: "Running",
      TailscaleIPs: ["100.64.1.5", "fd7a:115c:a1e0::1"],
      CertDomains: ["vps.tail-abc.ts.net"],
      Self: { DNSName: "vps.tail-abc.ts.net.", Online: true },
    });
    expect(parseTailscaleStatus(raw)).toEqual({
      dnsName: "vps.tail-abc.ts.net",
      ipv4: "100.64.1.5",
      backendState: "Running",
      online: true,
      httpsCerts: true,
    });
  });

  it("reports httpsCerts=false when the tailnet can't issue certs", () => {
    const raw = JSON.stringify({
      BackendState: "Running",
      TailscaleIPs: ["100.64.1.5"],
      Self: { DNSName: "vps.tail-abc.ts.net.", Online: true },
    });
    const parsed = parseTailscaleStatus(raw);
    expect(parsed?.dnsName).toBe("vps.tail-abc.ts.net");
    expect(parsed?.httpsCerts).toBe(false);
  });

  it("reports online=false for an offline node", () => {
    const raw = JSON.stringify({
      BackendState: "Running",
      TailscaleIPs: ["100.64.1.5"],
      CertDomains: ["vps.tail-abc.ts.net"],
      Self: { DNSName: "vps.tail-abc.ts.net.", Online: false },
    });
    expect(parseTailscaleStatus(raw)?.online).toBe(false);
  });

  it("rejects non-CGNAT IPv4s", () => {
    const raw = JSON.stringify({
      BackendState: "Running",
      TailscaleIPs: ["192.168.1.5", "100.100.9.9"],
      Self: { DNSName: "x.ts.net." },
    });
    expect(parseTailscaleStatus(raw)?.ipv4).toBe("100.100.9.9");
  });

  it("handles a logged-out node", () => {
    const raw = JSON.stringify({ BackendState: "NeedsLogin" });
    const parsed = parseTailscaleStatus(raw);
    expect(parsed?.backendState).toBe("NeedsLogin");
    expect(parsed?.dnsName).toBeUndefined();
    expect(parsed?.ipv4).toBeUndefined();
    expect(parsed?.httpsCerts).toBe(false);
  });

  it("returns null on malformed output", () => {
    expect(parseTailscaleStatus("not json")).toBeNull();
    expect(parseTailscaleStatus("[]")).toBeNull();
  });
});

describe("path quoting", () => {
  it("leaves shell-safe paths bare and quotes unsafe ones", () => {
    expect(shellQuotePath("/home/u/.synara")).toBe("/home/u/.synara");
    expect(shellQuotePath("/home/first last/.synara")).toBe("'/home/first last/.synara'");
    expect(shellQuotePath("/x/it's")).toBe("'/x/it'\\''s'");
  });

  it("always double-quotes for systemd and escapes quotes/backslashes", () => {
    expect(systemdQuotePath("/home/u/.synara")).toBe('"/home/u/.synara"');
    expect(systemdQuotePath('/a"b\\c')).toBe('"/a\\"b\\\\c"');
  });

  it("quotes spaced paths inside the unit file and manual instructions", () => {
    const unit = renderSystemdUserService({
      serviceName: "synara",
      envFilePath: "/home/first last/.synara/synara.env",
      executablePath: "/opt/node bin/node",
      entrypointPath: "/opt/synara app/dist/index.mjs",
      workingDirectory: "/home/first last/.synara",
      logFilePath: "/home/first last/.synara/logs/server.log",
    });
    expect(unit).toContain('EnvironmentFile="/home/first last/.synara/synara.env"');
    expect(unit).toContain('ExecStart="/opt/node bin/node" "/opt/synara app/dist/index.mjs"');
    expect(unit).toContain('WorkingDirectory="/home/first last/.synara"');
    expect(unit).toContain('StandardOutput=append:"/home/first last/.synara/logs/server.log"');

    const manual = renderManualStartInstructions({
      envFilePath: "/home/first last/.synara/synara.env",
      executablePath: "/opt/node bin/node",
      entrypointPath: "/opt/synara app/dist/index.mjs",
    });
    expect(manual[0]).toBe("set -a; . '/home/first last/.synara/synara.env'; set +a");
    expect(manual[1]).toBe(
      "exec '/opt/node bin/node' '/opt/synara app/dist/index.mjs' --no-browser",
    );
  });
});

describe("parseTailscaleServeStatus", () => {
  it("detects serving via JSON Web block", () => {
    expect(
      parseTailscaleServeStatus(JSON.stringify({ Web: { "host:443": { Handlers: {} } } })).serving,
    ).toBe(true);
    expect(parseTailscaleServeStatus(JSON.stringify({ Web: {} })).serving).toBe(false);
  });

  it("extracts root proxy targets for idempotency and conflict checks", () => {
    const status = parseTailscaleServeStatus(
      JSON.stringify({
        Web: {
          "vps.tail.ts.net:443": {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:3773" },
              "/other": { Proxy: "http://127.0.0.1:9" },
            },
          },
        },
      }),
    );
    expect(status.serving).toBe(true);
    expect(status.rootProxies).toEqual(["http://127.0.0.1:3773"]);
    expect(status.rootMounts).toEqual([{ port: 443, proxy: "http://127.0.0.1:3773" }]);
  });

  it("tracks the tailnet listen port for non-443 mappings", () => {
    const status = parseTailscaleServeStatus(
      JSON.stringify({
        Web: {
          "vps.tail.ts.net:8443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } },
          },
        },
      }),
    );
    expect(status.rootMounts).toEqual([{ port: 8443, proxy: "http://127.0.0.1:3773" }]);
  });

  it("reports serving but empty proxies when handlers lack a root mount", () => {
    const status = parseTailscaleServeStatus(
      JSON.stringify({
        Web: { "vps.tail.ts.net:443": { Handlers: { "/api": { Proxy: "http://127.0.0.1:9" } } } },
      }),
    );
    expect(status.serving).toBe(true);
    expect(status.rootProxies).toEqual([]);
  });

  it("tolerates malformed Web shapes", () => {
    expect(parseTailscaleServeStatus(JSON.stringify({ Web: [] })).serving).toBe(false);
    expect(
      parseTailscaleServeStatus(JSON.stringify({ Web: { h: { Handlers: null } } })).serving,
    ).toBe(true);
    expect(
      parseTailscaleServeStatus(JSON.stringify({ Web: { h: { Handlers: { "/": {} } } } }))
        .rootProxies,
    ).toEqual([]);
  });

  it("detects serving via text output", () => {
    const status = parseTailscaleServeStatus(
      "https://vps.tail.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:3773",
    );
    expect(status.serving).toBe(true);
    expect(status.rootProxies).toEqual([]);
    expect(parseTailscaleServeStatus("").serving).toBe(false);
  });
});

describe("tailscaleDiagnostic", () => {
  it("classifies known failures and never echoes raw output", () => {
    expect(tailscaleDiagnostic("Serve config: handler does not exist")).toBe("no-existing-handler");
    expect(tailscaleDiagnostic("Tailscale is stopped. (not logged in)")).toBe("not-logged-in");
    expect(tailscaleDiagnostic("error: permission denied")).toBe("permission-denied");
    expect(tailscaleDiagnostic("flag provided but not defined: -https")).toBe("unknown-flag");
    expect(tailscaleDiagnostic("some other error")).toBe("unknown");
    expect(tailscaleDiagnostic("   ")).toBeUndefined();
  });
});

describe("failure classification", () => {
  it("detects permission failures", () => {
    expect(
      isPermissionFailure({ ok: false, exitCode: 1, output: "Permission denied (os error 13)" }),
    ).toBe(true);
    expect(isPermissionFailure({ ok: true, exitCode: 0, output: "" })).toBe(false);
    expect(isPermissionFailure({ ok: false, exitCode: 1, output: "invalid port" })).toBe(false);
  });

  it("detects unknown-flag failures only for the named flag", () => {
    const failure = { ok: false, exitCode: 1, output: "flag provided but not defined: -yes" };
    expect(isUnknownFlagFailure(failure, "--yes")).toBe(true);
    expect(isUnknownFlagFailure(failure, "--bg")).toBe(false);
  });
});

describe("buildPairingUrl", () => {
  it("builds /pair#token=<credential> on the origin", () => {
    expect(buildPairingUrl("https://vps.ts.net", "cred1")).toBe(
      "https://vps.ts.net/pair#token=cred1",
    );
  });

  it("strips existing path, query, and fragment", () => {
    expect(buildPairingUrl("http://100.1.2.3:3773/x?token=abc#frag", "cred1")).toBe(
      "http://100.1.2.3:3773/pair#token=cred1",
    );
  });
});

describe("origin helpers", () => {
  it("rewrites wildcard bind hosts to loopback for probes", () => {
    expect(localProbeOrigin({ host: "0.0.0.0", port: 3773 })).toBe("http://127.0.0.1:3773");
    expect(localProbeOrigin({ host: "127.0.0.1", port: 3773 })).toBe("http://127.0.0.1:3773");
    expect(localProbeOrigin({ host: "::1", port: 9 })).toBe("http://127.0.0.1:9");
    expect(localProbeOrigin({ host: "fd7a::1", port: 9 })).toBe("http://[fd7a::1]:9");
  });

  it("prefers the public URL for the browser-facing origin", () => {
    expect(publicFacingOrigin(baseConfig({ publicUrl: "https://vps.ts.net" }))).toBe(
      "https://vps.ts.net",
    );
    expect(
      publicFacingOrigin(baseConfig({ publicUrl: undefined, host: "0.0.0.0", port: 3773 })),
    ).toBe("http://127.0.0.1:3773");
  });
});

describe("validatePublicOrigin", () => {
  it("accepts an https root origin", () => {
    expect(validatePublicOrigin("https://synara.example.com")).toEqual({
      ok: true,
      origin: "https://synara.example.com",
    });
    expect(validatePublicOrigin("https://vps.tail-abc.ts.net/").ok).toBe(true);
  });

  it("rejects http, credentials, and non-root URLs", () => {
    expect(validatePublicOrigin("http://example.com").ok).toBe(false);
    expect(validatePublicOrigin("https://u:p@example.com").ok).toBe(false);
    expect(validatePublicOrigin("https://example.com/app").ok).toBe(false);
    expect(validatePublicOrigin("https://example.com?q=1").ok).toBe(false);
    expect(validatePublicOrigin("not a url").ok).toBe(false);
  });
});

describe("host helpers", () => {
  it("detects wildcard bind hosts", () => {
    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("::")).toBe(true);
    expect(isWildcardHost("127.0.0.1")).toBe(false);
  });

  it("detects the primary non-internal IPv4", () => {
    const interfaces = {
      lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }] as never[],
      en0: [
        { family: "IPv6", address: "fe80::1", internal: false },
        { family: "IPv4", address: "192.168.1.9", internal: false },
      ] as never[],
    };
    expect(detectPrimaryLanIpv4(interfaces)).toBe("192.168.1.9");
    expect(detectPrimaryLanIpv4({ lo0: interfaces.lo0 })).toBeUndefined();
  });
});

describe("paths and manual instructions", () => {
  it("places the env file and unit dir deterministically", () => {
    expect(environmentFilePath("/home/u/.synara")).toBe("/home/u/.synara/synara.env");
    expect(systemdUserUnitDirectory("/home/u")).toBe("/home/u/.config/systemd/user");
    expect(systemdUserUnitDirectory("/home/u", "/xdg")).toBe("/xdg/systemd/user");
  });

  it("renders a two-line manual start that sources the env file", () => {
    const lines = renderManualStartInstructions({
      envFilePath: "/d/synara.env",
      executablePath: "/opt/node/node",
      entrypointPath: "/opt/synara/dist/index.mjs",
    });
    expect(lines[0]).toBe("set -a; . /d/synara.env; set +a");
    expect(lines[1]).toBe("exec /opt/node/node /opt/synara/dist/index.mjs --no-browser");
  });

  it("points source checkouts at the dev runner when no packaged entrypoint exists", () => {
    const lines = renderManualStartInstructions({
      envFilePath: "/d/synara.env",
      executablePath: "/opt/node/node",
    });
    expect(lines[1]).toBe("bun run --cwd apps/server start  # from the repository root");
  });
});

describe("generateRemoteAuthToken", () => {
  it("produces URL-safe tokens", () => {
    const token = generateRemoteAuthToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(generateRemoteAuthToken()).not.toBe(token);
  });
});
