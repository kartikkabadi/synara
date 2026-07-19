import { describe, expect, it } from "vitest";

import { buildAcpSpawnEnv } from "./acpSpawnEnv.ts";

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("buildAcpSpawnEnv", () => {
  it("keeps common OS/shell vars and drops unrelated secrets", () => {
    withEnv(
      {
        PATH: "/usr/bin:/bin",
        HOME: "/home/user",
        AWS_SECRET_ACCESS_KEY: "leak-me",
        SECRET_TOKEN: "also-leak",
      },
      () => {
        const env = buildAcpSpawnEnv({});
        expect(env.PATH).toBe("/usr/bin:/bin");
        expect(env.HOME).toBe("/home/user");
        expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(env.SECRET_TOKEN).toBeUndefined();
      },
    );
  });

  it("passes through extraPrefixes and extraNames", () => {
    withEnv(
      {
        CURSOR_API_KEY: "cursor-secret",
        CURSOR_AGENT_HOME: "/cursor",
        DEVIN_TOKEN: "devin-secret",
        CUSTOM_ONLY: "custom",
        IGNORE_ME: "nope",
      },
      () => {
        const env = buildAcpSpawnEnv({
          extraPrefixes: ["CURSOR_", "DEVIN_"],
          extraNames: new Set(["CUSTOM_ONLY"]),
        });
        expect(env.CURSOR_API_KEY).toBe("cursor-secret");
        expect(env.CURSOR_AGENT_HOME).toBe("/cursor");
        expect(env.DEVIN_TOKEN).toBe("devin-secret");
        expect(env.CUSTOM_ONLY).toBe("custom");
        expect(env.IGNORE_ME).toBeUndefined();
      },
    );
  });

  it("merges extraEnv on top of the allowlist", () => {
    withEnv({ PATH: "/usr/bin", HOME: "/home/user" }, () => {
      const env = buildAcpSpawnEnv({
        extraEnv: {
          NO_BROWSER: "true",
          PATH: "/override/bin",
        },
      });
      expect(env.NO_BROWSER).toBe("true");
      expect(env.PATH).toBe("/override/bin");
      expect(env.HOME).toBe("/home/user");
    });
  });
});
