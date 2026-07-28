import type { ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import { realpathSync } from "node:fs";

import { Effect, ServiceMap } from "effect";
import { describe, expect, it } from "vitest";

import { CodexAppServerManager } from "../../codexAppServerManager";
import { makeLocalProcessSpawner } from "./LocalProcessSpawner";
import {
  ProviderProcessSpawner,
  type ProviderProcessSpawnerShape,
  ProviderSpawnError,
} from "../Services/ProviderProcessSpawner";

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{
  stdout: string;
  code: number | null;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, code });
    });
  });
}

describe("LocalProcessSpawner", () => {
  it("spawns with piped stdio, the provided cwd, and the provided env", async () => {
    const spawner = makeLocalProcessSpawner();
    const cwd = realpathSync(os.tmpdir());
    const child = await Effect.runPromise(
      spawner.spawn(
        process.execPath,
        ["-e", "process.stdout.write(process.cwd() + '|' + process.env.SPAWNER_TEST_VALUE)"],
        {
          cwd,
          env: { ...process.env, SPAWNER_TEST_VALUE: "inherited-and-augmented" },
        },
      ),
    );

    expect(child.stdin).not.toBeNull();
    expect(child.stdout).not.toBeNull();
    expect(child.stderr).not.toBeNull();

    const { stdout, code } = await waitForExit(child);
    expect(code).toBe(0);
    const [reportedCwd, reportedEnv] = stdout.split("|");
    expect(realpathSync(reportedCwd ?? "")).toBe(cwd);
    expect(reportedEnv).toBe("inherited-and-augmented");
  });

  it("classifies synchronous spawn failures as ProviderSpawnError", async () => {
    const spawner = makeLocalProcessSpawner();
    const error = await Effect.runPromise(
      spawner.spawn("", [], { cwd: os.tmpdir(), env: process.env }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(ProviderSpawnError);
    expect(error.message).toContain("Failed to spawn provider process");
  });

  it("reports missing binaries through the child error event, like direct spawn", async () => {
    const spawner = makeLocalProcessSpawner();
    const child = await Effect.runPromise(
      spawner.spawn("synara-definitely-missing-binary", [], {
        cwd: os.tmpdir(),
        env: process.env,
      }),
    );
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      child.on("error", resolve);
    });
    expect(error.code).toBe("ENOENT");
  });
});

describe("CodexAppServerManager process spawner seam", () => {
  it("uses the ProviderProcessSpawner from its services when provided", () => {
    const fakeSpawner: ProviderProcessSpawnerShape = {
      spawn: () => Effect.die("unused"),
    };
    const manager = new CodexAppServerManager(ServiceMap.make(ProviderProcessSpawner, fakeSpawner));
    const spawner = (manager as unknown as { processSpawner: ProviderProcessSpawnerShape })
      .processSpawner;
    expect(spawner).toBe(fakeSpawner);
  });

  it("defaults to a local spawner when the service is absent", async () => {
    const manager = new CodexAppServerManager();
    const spawner = (manager as unknown as { processSpawner: ProviderProcessSpawnerShape })
      .processSpawner;
    const child = await Effect.runPromise(
      spawner.spawn(process.execPath, ["-e", "process.stdout.write('local')"], {
        cwd: process.cwd(),
        env: process.env,
      }),
    );
    const { stdout, code } = await waitForExit(child);
    expect(code).toBe(0);
    expect(stdout).toBe("local");
  });
});
