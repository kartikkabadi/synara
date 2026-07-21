// FILE: PiAdapter.test.ts
// Purpose: Verifies Pi adapter model discovery respects auth and SDK-supported thinking levels.
// Layer: Provider adapter tests
// Depends on: PiAdapter discovery helpers and Pi model metadata shapes.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthStorage,
  DEFAULT_COMPACTION_SETTINGS,
  ModelRegistry,
  shouldCompact,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { PiAdapter } from "../Services/PiAdapter.ts";
import {
  getPiDiscoverableModels,
  getPiSupportedThinkingOptions,
  buildPiAgentGatewayCustomTools,
  makePiBashProcessSupervisor,
  makePiRuntimeEventBase,
  makePiUserInputOptions,
  makePiAdapterLive,
  PLAIN_PI_EXTENSION_THEME,
} from "./PiAdapter";

const piSdkTestHooks = vi.hoisted(() => ({
  current: undefined as
    | undefined
    | {
        readonly agentDir: string;
        readonly sessionManager: unknown;
        readonly runtime: unknown;
      },
}));

vi.mock(import("@earendil-works/pi-coding-agent"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAgentDir: () => piSdkTestHooks.current?.agentDir ?? actual.getAgentDir(),
    getShellConfig: () =>
      piSdkTestHooks.current
        ? ({ shell: "/bin/sh", args: ["-c"] } as ReturnType<typeof actual.getShellConfig>)
        : actual.getShellConfig(),
    SessionManager: new Proxy(actual.SessionManager, {
      get(target, prop, receiver) {
        if (prop === "create" && piSdkTestHooks.current) {
          return () => piSdkTestHooks.current?.sessionManager;
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
    createAgentSessionRuntime: (async (factory, options) =>
      piSdkTestHooks.current
        ? piSdkTestHooks.current.runtime
        : actual.createAgentSessionRuntime(
            factory,
            options,
          )) as typeof actual.createAgentSessionRuntime,
  };
});

function makeFakePiSessionRuntime() {
  const compactCalls: Array<string> = [];
  let handler: ((event: unknown) => void) | undefined;
  const sessionManager = {
    getSessionFile: () => "/tmp/pi-session.jsonl",
    getCwd: () => process.cwd(),
    getLeafId: () => undefined,
  };
  const session = {
    sessionId: "pi-session-1",
    sessionFile: undefined,
    sessionManager,
    model: undefined,
    subscribe: (next: (event: unknown) => void) => {
      handler = next;
      return () => {
        handler = undefined;
      };
    },
    bindExtensions: async () => {},
    resourceLoader: { getExtensions: () => ({ extensions: [] }) },
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      contextUsage: undefined,
    }),
    compact: async () => {
      compactCalls.push("compact");
    },
    agent: { state: { errorMessage: undefined } },
  };
  const runtime = {
    session,
    dispose: async () => {},
    services: {
      modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] },
    },
  };
  return {
    runtime,
    sessionManager,
    compactCalls,
    emit: (event: unknown) => handler?.(event),
  };
}

function makePiAdapterTestLayer() {
  return makePiAdapterLive().pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pi-adapter-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("Pi native Synara gateway tools", () => {
  it("uses canonical MCP schemas and keeps same-cwd thread tokens distinct", async () => {
    const requests: Array<{ readonly token: string | null; readonly body: any }> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({
        token: new Headers(init?.headers).get("Authorization"),
        body,
      });
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "synara_list_threads",
                    description: "List Synara threads.",
                    inputSchema: {
                      type: "object",
                      properties: { limit: { type: "number" } },
                    },
                  },
                ],
              }
            : {
                content: [{ type: "text", text: body.params.arguments.owner }],
              },
      });
    };
    const defineTool = (tool: any) => tool;
    const first = await buildPiAgentGatewayCustomTools({
      connection: { url: "http://127.0.0.1:3773/mcp", bearerToken: "token-a" },
      defineTool,
      fetch,
    });
    const second = await buildPiAgentGatewayCustomTools({
      connection: { url: "http://127.0.0.1:3773/mcp", bearerToken: "token-b" },
      defineTool,
      fetch,
    });

    expect(first[0]?.parameters).toEqual({
      type: "object",
      properties: { limit: { type: "number" } },
    });
    await expect(
      first[0]?.execute("call-a", { owner: "thread-a" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "thread-a" }] });
    await expect(
      second[0]?.execute("call-b", { owner: "thread-b" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "thread-b" }] });
    expect(requests.map((request) => request.token)).toEqual([
      "Bearer token-a",
      "Bearer token-b",
      "Bearer token-a",
      "Bearer token-b",
    ]);
    expect(requests[2]?.body.params.arguments).toEqual({ owner: "thread-a" });
    expect(requests[3]?.body.params.arguments).toEqual({ owner: "thread-b" });
  });

  it("forwards Pi tool cancellation to the in-flight MCP request", async () => {
    let callSignal: AbortSignal | null = null;
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "synara_create_threads",
                description: "Create Synara threads.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
      }

      callSignal = init?.signal ?? null;
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAborted = () =>
          reject(
            callSignal?.reason ?? new DOMException("The operation was aborted.", "AbortError"),
          );
        if (callSignal?.aborted) {
          rejectAborted();
          return;
        }
        callSignal?.addEventListener("abort", rejectAborted, { once: true });
      });
    };
    const tools = await buildPiAgentGatewayCustomTools({
      connection: { url: "http://127.0.0.1:3773/mcp", bearerToken: "token-a" },
      defineTool: (tool) => tool,
      fetch,
    });
    const controller = new AbortController();
    const execution = tools[0]?.execute("call-a", {}, controller.signal, undefined, {} as never);

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(callSignal).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("Pi Bash process supervision", () => {
  it("keeps an aborted command pending until process-tree exit is proven", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 64_201,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    let proveExit!: () => void;
    const exitProof = new Promise<void>((resolve) => {
      proveExit = resolve;
    });
    let observeTeardown!: () => void;
    const teardownStarted = new Promise<void>((resolve) => {
      observeTeardown = resolve;
    });
    const supervisor = makePiBashProcessSupervisor({
      getShellConfig: () => ({ shell: "/bin/sh", args: ["-c"] }),
      spawnProcess: () => child,
      teardownProcessTree: async (input) => {
        observeTeardown();
        await exitProof;
        (child as ChildProcess & { exitCode: number | null }).exitCode = 0;
        child.emit("exit", 0, null);
        await input.rootExited;
        return { escalated: false, signalErrors: [] };
      },
    });
    const abortController = new AbortController();
    const command = supervisor.operations.exec("sleep 10", "/tmp", {
      signal: abortController.signal,
      onData: () => undefined,
    });
    let settled = false;
    void command.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    abortController.abort();
    await teardownStarted;
    await Promise.resolve();
    expect(settled).toBe(false);

    proveExit();
    await expect(command).rejects.toThrow("aborted");
    expect(settled).toBe(true);
  });
});

function makePiModel(input: {
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}): Pick<Model<Api>, "reasoning" | "thinkingLevelMap"> {
  return {
    reasoning: input.reasoning,
    ...(input.thinkingLevelMap !== undefined ? { thinkingLevelMap: input.thinkingLevelMap } : {}),
  };
}

describe("getPiDiscoverableModels", () => {
  it("includes custom-provider models authenticated through auth.json semantics", () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-models-"));
    const modelsPath = path.join(agentDir, "models.json");

    try {
      writeFileSync(
        modelsPath,
        JSON.stringify({
          providers: {
            local: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [{ id: "glm-5.2" }],
            },
          },
        }),
      );
      const authStorage = AuthStorage.inMemory({
        local: { type: "api_key", key: "test-key" },
      });
      const registry = ModelRegistry.create(authStorage, modelsPath);

      const models = getPiDiscoverableModels(registry);

      expect(models.some((model) => model.provider === "local" && model.id === "glm-5.2")).toBe(
        true,
      );
      expect(models.some((model) => model.provider === "anthropic")).toBe(false);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("getPiSupportedThinkingOptions", () => {
  it("hides thinking controls for non-reasoning models", () => {
    expect(getPiSupportedThinkingOptions(makePiModel({ reasoning: false }))).toEqual([]);
  });

  it("advertises xhigh only when the concrete Pi model supports it", () => {
    const withoutXHigh = getPiSupportedThinkingOptions(makePiModel({ reasoning: true }));
    const withXHigh = getPiSupportedThinkingOptions(
      makePiModel({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }),
    );

    expect(withoutXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(withXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("respects provider-level disabled thinking levels", () => {
    const options = getPiSupportedThinkingOptions(
      makePiModel({
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
        },
      }),
    );

    expect(options.map((option) => option.value)).toEqual(["minimal", "low", "medium", "high"]);
  });
});

describe("Pi extension UI helpers", () => {
  it("stamps events from the lifecycle generation captured by the session context", () => {
    const eventBase = makePiRuntimeEventBase({
      lifecycleGeneration: "generation-pi-7",
      session: { threadId: "thread-pi" as never },
      activeTurnId: "turn-pi" as never,
    });

    expect(eventBase).toMatchObject({
      provider: "pi",
      threadId: "thread-pi",
      turnId: "turn-pi",
      lifecycleGeneration: "generation-pi-7",
    });
  });

  it("keeps original select values while showing normalized unique labels", () => {
    const mappings = makePiUserInputOptions(["  OpenRouter  ", "", "OpenRouter"]);

    expect(mappings.map((mapping) => mapping.value)).toEqual(["  OpenRouter  ", "", "OpenRouter"]);
    expect(mappings.map((mapping) => mapping.option.label)).toEqual([
      "OpenRouter",
      "Option 2",
      "OpenRouter (2)",
    ]);
  });

  it("provides a no-color theme object for UI-gated extensions", () => {
    expect(PLAIN_PI_EXTENSION_THEME.fg("accent", "ready")).toBe("ready");
    expect(PLAIN_PI_EXTENSION_THEME.bold("done")).toBe("done");
    expect(PLAIN_PI_EXTENSION_THEME.getThinkingBorderColor("medium")("thinking")).toBe("thinking");
  });
});

describe("Pi compaction behavior", () => {
  it("compacts Pi threads through the runtime session compact()", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-compact-"));
    const fake = makeFakePiSessionRuntime();
    piSdkTestHooks.current = {
      agentDir,
      sessionManager: fake.sessionManager,
      runtime: fake.runtime,
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* PiAdapter;
          yield* adapter.startSession({
            provider: "pi",
            threadId: ThreadId.makeUnsafe("thread-pi-compact"),
            runtimeMode: "full-access",
          });
          const compactThread = adapter.compactThread;
          if (!compactThread) {
            throw new Error("Pi adapter is expected to support compactThread");
          }
          yield* compactThread(ThreadId.makeUnsafe("thread-pi-compact"));
        }).pipe(Effect.provide(makePiAdapterTestLayer())),
      );

      expect(fake.compactCalls).toEqual(["compact"]);
    } finally {
      piSdkTestHooks.current = undefined;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("maps compaction_start/compaction_end SDK events to context_compaction items", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-compact-events-"));
    const fake = makeFakePiSessionRuntime();
    piSdkTestHooks.current = {
      agentDir,
      sessionManager: fake.sessionManager,
      runtime: fake.runtime,
    };

    try {
      const events = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* PiAdapter;
          const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
            Effect.forkChild,
          );

          yield* adapter.startSession({
            provider: "pi",
            threadId: ThreadId.makeUnsafe("thread-pi-compaction-events"),
            runtimeMode: "full-access",
          });

          fake.emit({ type: "compaction_start" });
          fake.emit({ type: "compaction_end", aborted: false, willRetry: false });

          return Array.from(yield* Fiber.join(eventsFiber));
        }).pipe(Effect.provide(makePiAdapterTestLayer())),
      );

      expect(events.map((event) => event.type)).toEqual([
        "session.started",
        "thread.started",
        "item.updated",
        "item.completed",
      ]);
      expect(events[2]).toMatchObject({
        type: "item.updated",
        payload: {
          itemType: "context_compaction",
          status: "inProgress",
          title: "Compacting context",
        },
      });
      expect(events[3]).toMatchObject({
        type: "item.completed",
        payload: {
          itemType: "context_compaction",
          status: "completed",
          title: "Context compacted",
          data: { type: "compaction_end", aborted: false, willRetry: false },
        },
      });
    } finally {
      piSdkTestHooks.current = undefined;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("marks aborted compaction_end events as failed context_compaction items", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-compact-abort-"));
    const fake = makeFakePiSessionRuntime();
    piSdkTestHooks.current = {
      agentDir,
      sessionManager: fake.sessionManager,
      runtime: fake.runtime,
    };

    try {
      const events = await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* PiAdapter;
          const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
            Effect.forkChild,
          );

          yield* adapter.startSession({
            provider: "pi",
            threadId: ThreadId.makeUnsafe("thread-pi-compaction-abort"),
            runtimeMode: "full-access",
          });

          fake.emit({ type: "compaction_end", aborted: true });

          return Array.from(yield* Fiber.join(eventsFiber));
        }).pipe(Effect.provide(makePiAdapterTestLayer())),
      );

      expect(events[2]).toMatchObject({
        type: "item.completed",
        payload: {
          itemType: "context_compaction",
          status: "failed",
        },
      });
    } finally {
      piSdkTestHooks.current = undefined;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("auto-compaction triggers once context tokens exceed the window minus the reserve", () => {
    expect(DEFAULT_COMPACTION_SETTINGS).toMatchObject({
      enabled: true,
      reserveTokens: 16_384,
    });

    const contextWindow = 200_000;
    expect(shouldCompact(contextWindow - 16_384, contextWindow, DEFAULT_COMPACTION_SETTINGS)).toBe(
      false,
    );
    expect(
      shouldCompact(contextWindow - 16_384 + 1, contextWindow, DEFAULT_COMPACTION_SETTINGS),
    ).toBe(true);
    expect(
      shouldCompact(contextWindow, contextWindow, {
        ...DEFAULT_COMPACTION_SETTINGS,
        enabled: false,
      }),
    ).toBe(false);
  });
});
