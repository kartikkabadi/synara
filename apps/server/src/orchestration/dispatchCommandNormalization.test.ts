// FILE: dispatchCommandNormalization.test.ts
// Purpose: Verifies client command normalization for managed workspaces and uploads.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CommandId,
  MessageId,
  type ClientOrchestrationCommand,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { Effect } from "effect";
import type { FileSystem, Path } from "effect";
import { describe, expect, it } from "vitest";

import {
  makeDispatchCommandNormalizer,
  type DispatchCommandNormalizerResult,
} from "./dispatchCommandNormalization";

function projectCreateCommand(
  overrides: Partial<Extract<ClientOrchestrationCommand, { type: "project.create" }>> = {},
): Extract<ClientOrchestrationCommand, { type: "project.create" }> {
  return {
    type: "project.create",
    commandId: CommandId.makeUnsafe("cmd-project-create"),
    projectId: ProjectId.makeUnsafe("project-chat"),
    kind: "chat",
    title: "Chat",
    workspaceRoot: "/Users/tester/Documents/Synara/2026-06-11/chat",
    createWorkspaceRootIfMissing: true,
    createdAt: "2026-06-11T21:30:43.000Z",
    ...overrides,
  };
}

// Runs the normalized command's deferred `prepareWorkspaceRoot` effect (if any), mirroring
// what the wsRpc dispatchCommand handler does after a successful `orchestrationEngine.dispatch`.
async function runPrepareWorkspaceRoot<E>(result: DispatchCommandNormalizerResult<E>) {
  if (result.prepareWorkspaceRoot) {
    await Effect.runPromise(result.prepareWorkspaceRoot);
  }
}

describe("makeDispatchCommandNormalizer", () => {
  it("returns a deferred prepare effect instead of scaffolding during normalization", async () => {
    const preparedRoots: string[] = [];
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareChatWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          preparedRoots.push(workspaceRoot);
        }),
    });

    const result = await Effect.runPromise(normalizer({ command: projectCreateCommand() }));

    // Normalization alone must not have scaffolded anything yet.
    expect(preparedRoots).toEqual([]);
    expect(result.prepareWorkspaceRoot).not.toBeNull();

    await runPrepareWorkspaceRoot(result);

    // Only after the caller explicitly runs the deferred effect does scaffolding happen.
    expect(preparedRoots).toEqual(["/Users/tester/Documents/Synara/2026-06-11/chat"]);
  });

  it("retries the deferred prepare effect on transient failures before succeeding", async () => {
    let callCount = 0;
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareChatWorkspaceRoot: () =>
        Effect.suspend(() => {
          callCount += 1;
          if (callCount < 3) {
            return Effect.fail(new Error("transient FS error"));
          }
          return Effect.void;
        }),
    });

    const result = await Effect.runPromise(normalizer({ command: projectCreateCommand() }));
    expect(result.prepareWorkspaceRoot).not.toBeNull();

    await runPrepareWorkspaceRoot(result);

    expect(callCount).toBe(3);
  });

  it("prepares managed date/slug chat workspace roots", async () => {
    const preparedRoots: string[] = [];
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareChatWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          preparedRoots.push(workspaceRoot);
        }),
    });

    const result = await Effect.runPromise(normalizer({ command: projectCreateCommand() }));
    await runPrepareWorkspaceRoot(result);

    expect(preparedRoots).toEqual(["/Users/tester/Documents/Synara/2026-06-11/chat"]);
  });

  it("does not prepare ordinary projects or the chat workspace root itself", async () => {
    const preparedRoots: string[] = [];
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareChatWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          preparedRoots.push(workspaceRoot);
        }),
    });

    const first = await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          kind: "project",
          workspaceRoot: "/Users/tester/Documents/Synara/2026-06-11/app",
        }),
      }),
    );
    await runPrepareWorkspaceRoot(first);
    const second = await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          workspaceRoot: "/Users/tester/Documents/Synara",
        }),
      }),
    );
    await runPrepareWorkspaceRoot(second);

    expect(preparedRoots).toEqual([]);
  });

  it("prepares the Studio workspace root itself", async () => {
    const preparedRoots: string[] = [];
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareChatWorkspaceRoot: () => Effect.void,
      prepareStudioWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          preparedRoots.push(workspaceRoot);
        }),
    });

    const result = await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          kind: "studio",
          title: "Studio",
          workspaceRoot: "/Users/tester/Documents/Synara/Studio",
        }),
      }),
    );
    await runPrepareWorkspaceRoot(result);

    expect(preparedRoots).toEqual(["/Users/tester/Documents/Synara/Studio"]);
  });

  it("prepares nested Studio workspace roots but not ordinary projects under Studio", async () => {
    const preparedRoots: string[] = [];
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      prepareStudioWorkspaceRoot: (workspaceRoot) =>
        Effect.sync(() => {
          preparedRoots.push(workspaceRoot);
        }),
    });

    const first = await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          kind: "studio",
          workspaceRoot: "/Users/tester/Documents/Synara/Studio/Outbox",
        }),
      }),
    );
    await runPrepareWorkspaceRoot(first);
    const second = await Effect.runPromise(
      normalizer({
        command: projectCreateCommand({
          kind: "project",
          workspaceRoot: "/Users/tester/Documents/Synara/Studio/SomeProject",
        }),
      }),
    );
    await runPrepareWorkspaceRoot(second);

    expect(preparedRoots).toEqual(["/Users/tester/Documents/Synara/Studio/Outbox"]);
  });

  it("defers binary attachment authority to the transactional managed ledger", async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-dispatch-normalize-"));
    const validId = "thread-rollback-attachments-11111111-1111-4111-8111-111111111111";
    const validPath = path.join(attachmentsDir, `${validId}.png`);
    fs.writeFileSync(validPath, Buffer.from([1]));
    const fileSystem = {
      stat: (filePath: string) =>
        Effect.try({
          try: () => {
            const info = fs.statSync(filePath);
            return { type: "File", size: BigInt(info.size) };
          },
          catch: (cause) => new Error("stat failed", { cause }),
        }),
    } as unknown as FileSystem.FileSystem;
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir,
      fileSystem,
      path: path as unknown as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    });

    try {
      const result = await Effect.runPromise(
        normalizer({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("cmd-turn-attachments"),
            threadId: ThreadId.makeUnsafe("thread-rollback-attachments"),
            message: {
              messageId: MessageId.makeUnsafe("msg-attachments"),
              role: "user",
              text: "send files",
              attachments: [
                {
                  type: "image",
                  id: validId,
                  name: "ok.png",
                  mimeType: "image/png",
                  sizeBytes: 1,
                },
                {
                  type: "image",
                  id: "thread-rollback-attachments-22222222-2222-4222-8222-222222222222",
                  name: "bad.png",
                  mimeType: "image/png",
                  sizeBytes: 1,
                },
              ],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2026-01-01T00:00:00.000Z",
          } satisfies Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>,
        }),
      );

      expect(result.command.type).toBe("thread.turn.start");
      if (result.command.type === "thread.turn.start") {
        expect(result.command.message.attachments).toHaveLength(2);
      }
      expect(fs.readFileSync(validPath)).toEqual(Buffer.from([1]));
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  describe("server-authoritative loop lifecycle time", () => {
    const normalizer = makeDispatchCommandNormalizer<Error>({
      attachmentsDir: "/tmp/attachments",
      fileSystem: {} as FileSystem.FileSystem,
      path: {} as Path.Path,
      canonicalizeProjectWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    });

    it.each([
      ["far in the past", "2000-01-01T00:00:00.000Z"],
      ["far in the future", "2099-01-01T00:00:00.000Z"],
    ])(
      "re-stamps thread.loop.set createdAt with server now when the client clock is %s",
      async (_name, clientCreatedAt) => {
        const before = Date.now();
        const result = await Effect.runPromise(
          normalizer({
            command: {
              type: "thread.loop.set",
              commandId: CommandId.makeUnsafe("cmd-loop-set-skew"),
              threadId: ThreadId.makeUnsafe("thread-loop-skew"),
              prompt: "keep going",
              maxIterations: null,
              durationSeconds: 30 * 60,
              createdAt: clientCreatedAt,
            } satisfies Extract<ClientOrchestrationCommand, { type: "thread.loop.set" }>,
          }),
        );
        const after = Date.now();
        expect(result.command.type).toBe("thread.loop.set");
        if (result.command.type !== "thread.loop.set") {
          return;
        }
        const stamped = Date.parse(result.command.createdAt);
        expect(stamped).toBeGreaterThanOrEqual(before);
        expect(stamped).toBeLessThanOrEqual(after);
      },
    );

    it("re-stamps thread.loop.toggle and thread.loop.off with server now", async () => {
      const before = Date.now();
      for (const command of [
        {
          type: "thread.loop.toggle" as const,
          commandId: CommandId.makeUnsafe("cmd-loop-toggle-skew"),
          threadId: ThreadId.makeUnsafe("thread-loop-skew"),
          createdAt: "2000-01-01T00:00:00.000Z",
        },
        {
          type: "thread.loop.off" as const,
          commandId: CommandId.makeUnsafe("cmd-loop-off-skew"),
          threadId: ThreadId.makeUnsafe("thread-loop-skew"),
          createdAt: "2099-01-01T00:00:00.000Z",
        },
      ]) {
        const result = await Effect.runPromise(normalizer({ command }));
        if (
          result.command.type !== "thread.loop.toggle" &&
          result.command.type !== "thread.loop.off"
        ) {
          throw new Error(`unexpected command type: ${result.command.type}`);
        }
        const stamped = Date.parse(result.command.createdAt);
        expect(stamped).toBeGreaterThanOrEqual(before);
        expect(stamped).toBeLessThanOrEqual(Date.now());
      }
    });
  });
});
