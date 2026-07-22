// FILE: CheckpointStore.test.ts
// Purpose: Verifies filesystem checkpoint store behavior around expensive Git capture work.
// Layer: Checkpointing tests.
// Exports: Vitest coverage for CheckpointStoreLive.
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Encoding, Fiber, FileSystem, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { ServerConfig } from "../../config.ts";
import { CheckpointRef, ThreadId } from "@synara/contracts";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("CheckpointStoreLive", () => {
  let runtime: ManagedRuntime.ManagedRuntime<CheckpointStore, unknown> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("deduplicates concurrent captures for the same checkpoint ref", async () => {
    let releaseAdd: (() => void) | undefined;
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "add -A -- .") {
        return Effect.promise(() => addGate).pipe(Effect.as({ code: 0, stdout: "", stderr: "" }));
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = {
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/message"),
        };

        const first = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          waitFor(() => execute.mock.calls.some(([call]) => call.args.join(" ") === "add -A -- .")),
        );
        const second = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

        expect(
          execute.mock.calls.filter(([call]) => call.args.join(" ") === "add -A -- ."),
        ).toHaveLength(1);

        releaseAdd?.();
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }),
    );
  });

  it("clears in-flight capture state when the owner is interrupted", async () => {
    let addCalls = 0;
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "add -A -- .") {
        addCalls += 1;
        if (addCalls === 1) {
          return Effect.never;
        }
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = {
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/message"),
        };

        const first = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => waitFor(() => addCalls === 1));
        const waiter = yield* store.captureCheckpoint(input).pipe(
          Effect.map(() => "completed" as const),
          Effect.catch((error) => Effect.succeed(error._tag)),
          Effect.forkChild,
        );
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

        yield* Fiber.interrupt(first);
        // The owner's interruption must surface to waiters as a typed store
        // error, not replay as the waiter's own fiber being interrupted.
        const waiterResult = yield* Fiber.join(waiter);
        expect(waiterResult).toBe("CheckpointInvariantError");

        const thirdResult = yield* store
          .captureCheckpoint(input)
          .pipe(Effect.timeoutOption("100 millis"));
        expect(Option.isSome(thirdResult)).toBe(true);
        expect(addCalls).toBe(2);
      }),
    );
  });

  it("skips the capture when skipIfExists is set and the ref already exists", async () => {
    const existingRef = "refs/synara-checkpoints/thread/existing";
    const missingRef = "refs/synara-checkpoints/thread/missing";
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === `rev-parse --verify --quiet ${existingRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "existing-commit\n", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${missingRef}^{commit}`) {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "add -A -- .") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const captureArgs = (args: string) =>
          execute.mock.calls.filter(([call]) => call.args.join(" ") === args);

        yield* store.captureCheckpoint({
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe(existingRef),
          skipIfExists: true,
        });
        expect(captureArgs("add -A -- .")).toHaveLength(0);

        yield* store.captureCheckpoint({
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe(missingRef),
          skipIfExists: true,
        });
        expect(captureArgs("add -A -- .")).toHaveLength(1);
        expect(captureArgs(`update-ref ${missingRef} commit-oid`)).toHaveLength(1);
      }),
    );
  });

  it("restores the worktree patch when resetting the index fails during file undo", async () => {
    const fromRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/start");
    const toRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/end");
    const commands: string[] = [];
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      commands.push(args);
      if (args === `rev-parse --verify --quiet ${fromRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "from-oid\n", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${toRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "to-oid\n", stderr: "" });
      }
      if (args.startsWith("diff --patch --binary --full-index")) {
        return Effect.succeed({ code: 0, stdout: "turn patch", stderr: "" });
      }
      if (args === "diff --name-only --no-renames -z from-oid to-oid") {
        return Effect.succeed({ code: 0, stdout: "src/file.ts\0", stderr: "" });
      }
      if (input.args[0] === "apply" && input.args[1] === "--reverse") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "reset --quiet from-oid -- src/file.ts") {
        return Effect.fail(
          new GitCommandError({
            operation: input.operation,
            command: args,
            cwd: input.cwd,
            detail: "reset failed",
          }),
        );
      }
      if (input.args[0] === "apply" && input.args[1] === "--whitespace=nowarn") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .reverseCheckpointDiff({
            cwd: "/repo",
            fromCheckpointRef: fromRef,
            toCheckpointRef: toRef,
          })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
      }),
    );

    expect(result).toBe("GitCommandError");
    expect(commands.filter((command) => command.startsWith("apply "))).toHaveLength(2);
    expect(commands.at(-1)).toMatch(/^apply --whitespace=nowarn -- /);
  });
});

describe("CheckpointStoreLive rescue checkpoints (real Git)", () => {
  const threadId = ThreadId.makeUnsafe("rescue-thread");

  const RescueTestLayer = Layer.mergeAll(
    NodeServices.layer,
    CheckpointStoreLive.pipe(
      Layer.provideMerge(
        GitCoreLive.pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "synara-checkpoint-rescue-test-" }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
    ),
  );

  let runtime: ManagedRuntime.ManagedRuntime<
    CheckpointStore | GitCore | Layer.Success<typeof NodeServices.layer>,
    unknown
  > | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  const git = (cwd: string, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const core = yield* GitCore;
      const result = yield* core.execute({
        operation: "CheckpointStore.test.git",
        cwd,
        args,
        timeoutMs: 10_000,
      });
      return result.stdout.trim();
    });

  /** Create a temp repo with an initial commit plus a dirty worktree. */
  const setupDirtyRepo = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectory({ prefix: "rescue-repo-" });
    yield* git(cwd, ["init"]);
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* fs.writeFileString(path.join(cwd, "tracked.txt"), "committed\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    yield* fs.writeFileString(path.join(cwd, "tracked.txt"), "modified\n");
    yield* fs.writeFileString(path.join(cwd, "untracked.txt"), "untracked\n");
    return cwd;
  });

  it("captures a rescue checkpoint of a dirty worktree at the rescue ref", async () => {
    runtime = ManagedRuntime.make(RescueTestLayer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const cwd = yield* setupDirtyRepo;

        const checkpointRef = yield* store.captureRescueCheckpoint({
          cwd,
          threadId,
          timestampMs: 1_700_000_000_000,
        });

        expect(checkpointRef).toBe(
          `refs/synara-rescue/${Encoding.encodeBase64Url(threadId)}/1700000000000`,
        );
        expect(yield* store.hasCheckpointRef({ cwd, checkpointRef })).toBe(true);

        const capturedFiles = yield* git(cwd, [
          "ls-tree",
          "--name-only",
          "-r",
          checkpointRef,
        ]);
        expect(capturedFiles.split("\n").sort()).toEqual(["tracked.txt", "untracked.txt"]);
      }),
    );
  });

  it("restores the captured state over a further-modified workspace", async () => {
    runtime = ManagedRuntime.make(RescueTestLayer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* CheckpointStore;
        const cwd = yield* setupDirtyRepo;

        const checkpointRef = yield* store.captureRescueCheckpoint({ cwd, threadId });

        yield* fs.writeFileString(path.join(cwd, "tracked.txt"), "mangled by revert\n");
        yield* fs.remove(path.join(cwd, "untracked.txt"));
        yield* fs.writeFileString(path.join(cwd, "leftover.txt"), "revert debris\n");

        const restored = yield* store.restoreRescueCheckpoint({ cwd, checkpointRef });

        expect(restored).toBe(true);
        expect(yield* fs.readFileString(path.join(cwd, "tracked.txt"))).toBe("modified\n");
        expect(yield* fs.readFileString(path.join(cwd, "untracked.txt"))).toBe("untracked\n");
        expect(yield* fs.exists(path.join(cwd, "leftover.txt"))).toBe(false);
      }),
    );
  });

  it("deletes the rescue ref and restore of a missing ref returns false", async () => {
    runtime = ManagedRuntime.make(RescueTestLayer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const cwd = yield* setupDirtyRepo;

        const checkpointRef = yield* store.captureRescueCheckpoint({ cwd, threadId });
        expect(yield* store.hasCheckpointRef({ cwd, checkpointRef })).toBe(true);

        yield* store.deleteRescueRef({ cwd, checkpointRef });

        expect(yield* store.hasCheckpointRef({ cwd, checkpointRef })).toBe(false);
        expect(yield* store.restoreRescueCheckpoint({ cwd, checkpointRef })).toBe(false);

        // Best-effort delete: deleting an already-missing ref succeeds.
        yield* store.deleteRescueRef({ cwd, checkpointRef });
      }),
    );
  });
});
