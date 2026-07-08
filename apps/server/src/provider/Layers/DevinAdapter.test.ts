import { describe, it, assert } from "@effect/vitest";
import { Effect, Fiber, Option, Stream } from "effect";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import {
  ApprovalRequestId,
  ThreadId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeUserInputRequestedEvent,
  type ProviderRuntimeUserInputResolvedEvent,
} from "@t3tools/contracts";

import type {
  AcpSessionRuntimeShape,
  AcpSessionRuntimeStartResult,
} from "../acp/AcpSessionRuntime.ts";
import type { AcpParsedSessionEvent, AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import { buildDevinAcpSpawnInput, resolveDevinAcpAuthMethodId } from "../acp/DevinAcpSupport.ts";
import { DEVIN_FALLBACK_MODELS } from "../acp/DevinModelCatalog.ts";
import { DevinAdapter } from "../Services/DevinAdapter";
import { ProviderAdapterRequestError } from "../Errors.ts";
import { makeDevinAdapterLive } from "./DevinAdapter";

const threadId = ThreadId.makeUnsafe("thread-devin");

function makeMockRuntime(input?: {
  readonly sessionId?: string;
  readonly configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  readonly prompt?: (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly onSetModel?: (model: string) => Effect.Effect<void>;
  readonly modeState?: AcpSessionModeState;
  readonly onSetMode?: (modeId: string) => Effect.Effect<void>;
  readonly cancel?: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly onHandleElicitation?: (
    handler: (
      request: EffectAcpSchema.ElicitationRequest,
    ) => Effect.Effect<EffectAcpSchema.ElicitationResponse, EffectAcpErrors.AcpError>,
  ) => void;
  readonly onHandleRequestPermission?: (
    handler: (
      params: EffectAcpSchema.RequestPermissionRequest,
    ) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError>,
  ) => void;
  readonly availableCommands?: ReadonlyArray<{ name: string; description?: string }>;
  readonly onStart?: () => void;
  readonly events?: Stream.Stream<AcpParsedSessionEvent>;
}) {
  return {
    handleRequestPermission: (
      handler: (
        params: EffectAcpSchema.RequestPermissionRequest,
      ) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError>,
    ) => {
      input?.onHandleRequestPermission?.(handler);
      return Effect.void;
    },
    handleElicitation: (
      handler: (
        request: EffectAcpSchema.ElicitationRequest,
      ) => Effect.Effect<EffectAcpSchema.ElicitationResponse, EffectAcpErrors.AcpError>,
    ) => {
      input?.onHandleElicitation?.(handler);
      return Effect.void;
    },
    handleReadTextFile: () => Effect.void,
    handleWriteTextFile: () => Effect.void,
    handleCreateTerminal: () => Effect.void,
    handleTerminalOutput: () => Effect.void,
    handleTerminalWaitForExit: () => Effect.void,
    handleTerminalKill: () => Effect.void,
    handleTerminalRelease: () => Effect.void,
    handleSessionUpdate: () => Effect.void,
    handleElicitationComplete: () => Effect.void,
    handleUnknownExtRequest: () => Effect.void,
    handleUnknownExtNotification: () => Effect.void,
    handleExtRequest: () => Effect.void,
    handleExtNotification: () => Effect.void,
    start: () =>
      Effect.sync(() => {
        input?.onStart?.();
        return {
          sessionId: input?.sessionId ?? "devin-session-1",
          initializeResult: { protocolVersion: 1, authMethods: [] },
          sessionSetupResult: { sessionId: input?.sessionId ?? "devin-session-1" },
          modelConfigId: undefined,
        } as unknown as AcpSessionRuntimeStartResult;
      }),
    getEvents: () => input?.events ?? Stream.empty,
    getModeState: Effect.succeed(input?.modeState),
    getConfigOptions: Effect.succeed(input?.configOptions ?? []),
    prompt:
      input?.prompt ??
      (() => Effect.succeed({ stopReason: "end_turn" } as EffectAcpSchema.PromptResponse)),
    cancel: input?.cancel ?? Effect.void,
    setMode: (modeId: string) =>
      input
        ?.onSetMode?.(modeId)
        .pipe(Effect.andThen(Effect.succeed({} as EffectAcpSchema.SetSessionModeResponse))) ??
      Effect.succeed({} as EffectAcpSchema.SetSessionModeResponse),
    setConfigOption: () =>
      Effect.succeed({ configOptions: [] } as EffectAcpSchema.SetSessionConfigOptionResponse),
    setModel: (model: string) => input?.onSetModel?.(model) ?? Effect.void,
    getAvailableCommands: Effect.succeed(input?.availableCommands ?? []),
    request: () => Effect.succeed({}),
    notify: () => Effect.void,
  } as unknown as AcpSessionRuntimeShape;
}

describe("buildDevinAcpSpawnInput", () => {
  it("builds the default Devin ACP command", () => {
    const result = buildDevinAcpSpawnInput(undefined, "/tmp/project");
    assert.strictEqual(result.command, "devin");
    assert.deepStrictEqual(result.args, ["acp"]);
    assert.strictEqual(result.cwd, "/tmp/project");
    assert.isObject(result.env);
  });

  it("uses the configured Devin binary path", () => {
    const result = buildDevinAcpSpawnInput({ binaryPath: "/Users/me/bin/devin" }, "/tmp/project");
    assert.strictEqual(result.command, "/Users/me/bin/devin");
    assert.deepStrictEqual(result.args, ["acp"]);
    assert.strictEqual(result.cwd, "/tmp/project");
    assert.isObject(result.env);
  });
});

describe("resolveDevinAcpAuthMethodId", () => {
  it.effect("selects the Windsurf API key auth method when WINDSURF_API_KEY is present", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => process.env.WINDSURF_API_KEY),
      () =>
        Effect.gen(function* () {
          process.env.WINDSURF_API_KEY = "test-key";
          const method = yield* resolveDevinAcpAuthMethodId({
            protocolVersion: 1,
            authMethods: [{ id: "windsurf-api-key", name: "Windsurf API Key" }],
          });
          assert.strictEqual(method, "windsurf-api-key");
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env.WINDSURF_API_KEY;
          } else {
            process.env.WINDSURF_API_KEY = previous;
          }
        }),
    ),
  );

  it.effect("returns windsurf-api-key when advertised regardless of WINDSURF_API_KEY", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => process.env.WINDSURF_API_KEY),
      () =>
        Effect.gen(function* () {
          delete process.env.WINDSURF_API_KEY;
          const method = yield* resolveDevinAcpAuthMethodId({
            protocolVersion: 1,
            authMethods: [{ id: "windsurf-api-key", name: "Windsurf API Key" }],
          });
          assert.strictEqual(method, "windsurf-api-key");
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) {
            delete process.env.WINDSURF_API_KEY;
          } else {
            process.env.WINDSURF_API_KEY = previous;
          }
        }),
    ),
  );

  it.effect("fails clearly when no supported auth method is advertised", () =>
    Effect.gen(function* () {
      const error = yield* resolveDevinAcpAuthMethodId({
        protocolVersion: 1,
        authMethods: [{ id: "oauth", name: "OAuth" }],
      }).pipe(Effect.flip);

      assert.strictEqual(error.message, "Devin ACP authentication is unavailable.");
    }),
  );
});

describe("DevinAdapterLive", () => {
  it.effect("starts a Devin ACP provider session with a native resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const session = yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.strictEqual(adapter.provider, "devin");
      assert.strictEqual(adapter.capabilities.sessionModelSwitch, "in-session");
      assert.strictEqual(session.provider, "devin");
      assert.strictEqual(session.status, "ready");
      assert.strictEqual(session.cwd, "/tmp/project");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "devin-session-1",
      });
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("sends text prompts through ACP session/prompt", () => {
    let resolveObservedPrompt!: (value: Omit<EffectAcpSchema.PromptRequest, "sessionId">) => void;
    const observedPromptPromise = new Promise<Omit<EffectAcpSchema.PromptRequest, "sessionId">>(
      (resolve) => {
        resolveObservedPrompt = resolve;
      },
    );
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const result = yield* adapter.sendTurn({
        threadId,
        input: "refactor this module",
      });
      const prompt = yield* Effect.promise(() => observedPromptPromise);

      assert.strictEqual(result.threadId, threadId);
      assert.deepStrictEqual(prompt, {
        prompt: [{ type: "text", text: "refactor this module" }],
      });
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                prompt: (payload) =>
                  Effect.sync(() => {
                    resolveObservedPrompt(payload);
                    return { stopReason: "end_turn" } as EffectAcpSchema.PromptResponse;
                  }),
              }),
            ),
        }),
      ),
    );
  });

  it.effect("normalizes Devin model aliases before applying model selection in-session", () => {
    let resolveObservedModel!: (model: string) => void;
    const observedModelPromise = new Promise<string>((resolve) => {
      resolveObservedModel = resolve;
    });
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "refactor this module",
        modelSelection: {
          provider: "devin",
          model: "opus",
        },
      });
      const model = yield* Effect.promise(() => observedModelPromise);

      assert.strictEqual(model, "claude-opus-4-8");
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                onSetModel: (model) =>
                  Effect.sync(() => {
                    resolveObservedModel(model);
                  }),
              }),
            ),
        }),
      ),
    );
  });

  it.effect("applies Devin plan mode through ACP session/set_mode", () => {
    let resolveObservedMode!: (modeId: string) => void;
    const observedModePromise = new Promise<string>((resolve) => {
      resolveObservedMode = resolve;
    });
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "make a plan",
        interactionMode: "plan",
      });
      const modeId = yield* Effect.promise(() => observedModePromise);

      assert.strictEqual(modeId, "planning");
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                modeState: {
                  currentModeId: "code",
                  availableModes: [
                    { id: "code", name: "Code" },
                    { id: "planning", name: "Plan" },
                  ],
                },
                onSetMode: (modeId) =>
                  Effect.sync(() => {
                    resolveObservedMode(modeId);
                  }),
              }),
            ),
        }),
      ),
    );
  });

  it.effect("rejects a second turn while a Devin ACP prompt is active", () =>
    (() => {
      let resolvePrompt!: (result: EffectAcpSchema.PromptResponse) => void;
      const promptPromise = new Promise<EffectAcpSchema.PromptResponse>((resolve) => {
        resolvePrompt = resolve;
      });
      return Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        yield* adapter.startSession({
          threadId,
          provider: "devin",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "keep working",
        });
        const error = yield* adapter
          .sendTurn({
            threadId,
            input: "start another turn",
          })
          .pipe(Effect.flip);

        assert.strictEqual(error._tag, "ProviderAdapterValidationError");
        assert.match(error.message, /already has an active turn/);
        yield* adapter.interruptTurn(threadId);
      }).pipe(
        Effect.provide(
          makeDevinAdapterLive({
            makeRuntime: () =>
              Effect.succeed(
                makeMockRuntime({
                  prompt: () => Effect.promise(() => promptPromise),
                  cancel: Effect.sync(() => {
                    resolvePrompt({
                      stopReason: "cancelled",
                    } as EffectAcpSchema.PromptResponse);
                  }),
                }),
              ),
          }),
        ),
      );
    })(),
  );

  it.effect("rejects rollback until Devin ACP exposes native revert semantics", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const error = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);

      assert.strictEqual(error._tag, "ProviderAdapterRequestError");
      assert.match(error.message, /rollback is unsupported/);
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("marks the session errored when ACP prompt fails", () => {
    let resolvePromptFailed!: () => void;
    const promptFailedPromise = new Promise<void>((resolve) => {
      resolvePromptFailed = resolve;
    });
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "refactor this module",
      });
      yield* Effect.promise(() => promptFailedPromise);

      const sessions = yield* adapter.listSessions();
      assert.strictEqual(sessions[0]?.status, "error");
      assert.match(sessions[0]?.lastError ?? "", /Devin prompt failed/);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                prompt: () =>
                  Effect.sync(() => {
                    resolvePromptFailed();
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new ProviderAdapterRequestError({
                          provider: "devin",
                          method: "session/prompt",
                          detail: "Devin prompt failed",
                        }) as unknown as EffectAcpErrors.AcpError,
                      ),
                    ),
                  ),
              }),
            ),
        }),
      ),
    );
  });

  it.effect("settles session to ready and emits turn.completed when prompt succeeds", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      // Subscribe before sendTurn so the completion event is not missed.
      const completedFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed",
        ),
      ).pipe(Effect.forkChild);

      const sendResult = yield* adapter.sendTurn({
        threadId,
        input: "say hello and stop",
      });
      const completed = Option.getOrThrow(yield* Fiber.join(completedFiber));

      assert.strictEqual(completed.turnId, sendResult.turnId);
      assert.strictEqual(completed.payload.state, "completed");
      assert.strictEqual(completed.payload.stopReason, "end_turn");

      const sessions = yield* adapter.listSessions();
      assert.strictEqual(sessions[0]?.status, "ready");
      assert.strictEqual(sessions[0]?.activeTurnId, undefined);

      // A second turn must be accepted after the first settled (no stuck active turn).
      const second = yield* adapter.sendTurn({
        threadId,
        input: "follow up",
      });
      assert.notStrictEqual(second.turnId, sendResult.turnId);

      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("interruptTurn returns the session to ready so the UI leaves Working", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const sendResult = yield* adapter.sendTurn({
        threadId,
        input: "keep working until interrupted",
      });

      const running = yield* adapter.listSessions();
      assert.strictEqual(running[0]?.status, "running");
      assert.strictEqual(running[0]?.activeTurnId, sendResult.turnId);

      yield* adapter.interruptTurn(threadId);

      const sessions = yield* adapter.listSessions();
      assert.strictEqual(sessions[0]?.status, "ready");
      assert.strictEqual(sessions[0]?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                // Interruptible hang: JS Promise-based hangs can block fiber interrupt.
                prompt: () =>
                  Effect.never as Effect.Effect<
                    EffectAcpSchema.PromptResponse,
                    EffectAcpErrors.AcpError
                  >,
                cancel: Effect.void,
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("lists models from the live ACP session config options", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const result = yield* adapter.listModels!({ provider: "devin" });

      assert.strictEqual(result.source, "devin.acp");
      // Models are eagerly cached during startSession, so listModels hits the cache.
      assert.strictEqual(result.cached, true);
      assert.strictEqual(result.models.length, 2);
      assert.deepStrictEqual(
        result.models.find((m) => m.slug === "swe-1-6"),
        {
          slug: "swe-1-6",
          name: "SWE 1.6",
          upstreamProviderId: "devin",
          upstreamProviderName: "Devin",
        },
      );
      assert.deepStrictEqual(
        result.models.find((m) => m.slug === "claude-opus-4-8"),
        {
          slug: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          upstreamProviderId: "anthropic",
          upstreamProviderName: "Anthropic",
          supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
          defaultReasoningEffort: "medium",
        },
      );
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                configOptions: [
                  {
                    id: "model",
                    category: "model",
                    type: "select",
                    currentValue: "swe-1-6",
                    options: [
                      { value: "swe-1-6", name: "SWE 1.6" },
                      {
                        value: "claude-opus-4-8-medium",
                        name: "Claude Opus 4.8 Medium",
                      },
                    ],
                  } as unknown as EffectAcpSchema.SessionConfigOption,
                ],
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("lists grouped models from the live ACP session config options", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const result = yield* adapter.listModels!({ provider: "devin" });

      assert.strictEqual(result.source, "devin.acp");
      assert.strictEqual(result.cached, true);
      assert.strictEqual(result.models.length, 2);
      assert.deepStrictEqual(
        result.models.find((m) => m.slug === "vendor-model-a"),
        {
          slug: "vendor-model-a",
          name: "Vendor Model A",
          upstreamProviderId: "moonshot",
          upstreamProviderName: "Moonshot AI",
        },
      );
      assert.deepStrictEqual(
        result.models.find((m) => m.slug === "vendor-model-b"),
        {
          slug: "vendor-model-b",
          name: "Vendor Model B",
          upstreamProviderId: "z-ai",
          upstreamProviderName: "Z.AI",
        },
      );
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                configOptions: [
                  {
                    id: "model",
                    category: "model",
                    type: "select",
                    currentValue: "vendor-model-a",
                    options: [
                      {
                        group: "moonshot",
                        name: "Moonshot AI",
                        options: [{ value: "vendor-model-a", name: "Vendor Model A" }],
                      },
                      {
                        group: "z-ai",
                        name: "Z.AI",
                        options: [{ value: "vendor-model-b", name: "Vendor Model B" }],
                      },
                    ],
                  } as unknown as EffectAcpSchema.SessionConfigOption,
                ],
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("falls back to the static catalog when no session is live and discovery fails", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;

      const result = yield* adapter.listModels!({ provider: "devin" });

      assert.strictEqual(result.source, "devin.fallback");
      assert.strictEqual(result.cached, true);
      assert.deepStrictEqual(result.models, DEVIN_FALLBACK_MODELS);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "devin",
                method: "model/list",
                detail: "Discovery failed",
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("falls back when the live session exposes no model option", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const result = yield* adapter.listModels!({ provider: "devin" });

      assert.strictEqual(result.source, "devin.fallback");
      assert.strictEqual(result.cached, true);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                configOptions: [],
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("cold-start discovery returns models from mock runtime", () => {
    let runtimeCreationCount = 0;
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const result = yield* adapter.listModels!({ provider: "devin" });

      assert.strictEqual(result.source, "devin.acp");
      assert.strictEqual(result.cached, false);
      assert.strictEqual(result.models.length, 3);
      assert.strictEqual(runtimeCreationCount, 1);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.gen(function* () {
              runtimeCreationCount++;
              return yield* Effect.succeed(
                makeMockRuntime({
                  configOptions: [
                    {
                      id: "model",
                      category: "model",
                      type: "select",
                      options: [
                        { value: "model-1", name: "Model 1" },
                        { value: "model-2", name: "Model 2" },
                        { value: "model-3", name: "Model 3" },
                      ],
                    } as unknown as EffectAcpSchema.SessionConfigOption,
                  ],
                }),
              );
            }),
        }),
      ),
    );
  });

  it.effect("binaryPath is passed to mock runtime", () => {
    let receivedBinaryPath: string | undefined;
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.listModels!({ provider: "devin", binaryPath: "/custom/devin" });

      assert.strictEqual(receivedBinaryPath, "/custom/devin");
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: (input) => {
            receivedBinaryPath = input.devinSettings.binaryPath;
            return Effect.succeed(
              makeMockRuntime({
                configOptions: [
                  {
                    id: "model",
                    category: "model",
                    type: "select",
                    options: [{ value: "model-1", name: "Model 1" }],
                  } as unknown as EffectAcpSchema.SessionConfigOption,
                ],
              }),
            );
          },
        }),
      ),
    );
  });

  it.effect("falls back to static catalog on mock runtime failure", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const result = yield* adapter.listModels!({ provider: "devin" });

      assert.strictEqual(result.source, "devin.fallback");
      assert.strictEqual(result.cached, true);
      assert.deepStrictEqual(result.models, DEVIN_FALLBACK_MODELS);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: "devin",
                method: "model/list",
                detail: "Mock runtime failure",
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("lists Devin slash commands from the live ACP session", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const result = yield* adapter.listCommands!({
        provider: "devin",
        cwd: "/tmp/project",
        threadId: String(threadId),
      });

      assert.strictEqual(result.source, "devin.acp");
      assert.strictEqual(result.cached, false);
      assert.deepStrictEqual(result.commands, [
        { name: "revert", description: "Revert changes" },
        { name: "steps" },
      ]);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                availableCommands: [
                  { name: "revert", description: "Revert changes" },
                  { name: "steps" },
                ],
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("returns empty commands when no session is live", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;

      const result = yield* adapter.listCommands!({ provider: "devin", cwd: "/tmp/project" });

      assert.deepStrictEqual(result.commands, []);
      assert.strictEqual(result.source, "devin.acp");
      assert.strictEqual(result.cached, false);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("does not return commands from another Devin session when threadId is unknown", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const result = yield* adapter.listCommands!({
        provider: "devin",
        cwd: "/tmp/project",
        threadId: "missing-thread",
      });

      assert.deepStrictEqual(result.commands, []);
      assert.strictEqual(result.source, "devin.acp");
      assert.strictEqual(result.cached, false);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                availableCommands: [{ name: "revert", description: "Revert changes" }],
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("returns provider-global commands from any live session when threadId is omitted", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const result = yield* adapter.listCommands!({ provider: "devin", cwd: "/tmp/project" });

      assert.deepStrictEqual(result.commands, [
        { name: "revert", description: "Revert changes" },
        { name: "steps" },
      ]);
      assert.strictEqual(result.source, "devin.acp");
      assert.strictEqual(result.cached, false);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                availableCommands: [
                  { name: "revert", description: "Revert changes" },
                  { name: "steps" },
                ],
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("does not return commands from a stopped matching session", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const result = yield* adapter.listCommands!({
        provider: "devin",
        cwd: "/tmp/project",
        threadId: String(threadId),
      });

      assert.deepStrictEqual(result.commands, []);
      assert.strictEqual(result.source, "devin.acp");
      assert.strictEqual(result.cached, false);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                availableCommands: [{ name: "revert", description: "Revert changes" }],
              }),
            ),
        }),
      ),
    ),
  );

  it.effect("composer capabilities advertise native slash-command discovery", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const capabilities = yield* adapter.getComposerCapabilities!();

      assert.strictEqual(capabilities.supportsNativeSlashCommandDiscovery, true);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("composer capabilities advertise rollback as unsupported", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const capabilities = yield* adapter.getComposerCapabilities!();

      assert.strictEqual(capabilities.supportsRollback, false);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("adapter capabilities declare rollback as unsupported", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;

      assert.strictEqual(adapter.capabilities.supportsRollback, false);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("compactThread sends /compact as a prompt", () => {
    const promptCalls: Array<ReadonlyArray<unknown>> = [];
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* adapter.compactThread!(threadId);
      assert.strictEqual(promptCalls.length, 1);
      const prompt = promptCalls[0]![0] as ReadonlyArray<{ type: string; text: string }>;
      assert.strictEqual(prompt[0]?.type, "text");
      assert.strictEqual(prompt[0]?.text, "/compact");
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                prompt: (payload) => {
                  promptCalls.push([payload.prompt]);
                  return Effect.succeed({
                    stopReason: "end_turn",
                  } as EffectAcpSchema.PromptResponse);
                },
              }),
            ),
        }),
      ),
    );
  });

  it.effect("rejects compactThread while a Devin ACP prompt is active", () =>
    (() => {
      let resolvePrompt!: (result: EffectAcpSchema.PromptResponse) => void;
      const promptPromise = new Promise<EffectAcpSchema.PromptResponse>((resolve) => {
        resolvePrompt = resolve;
      });
      return Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        yield* adapter.startSession({
          threadId,
          provider: "devin",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId,
          input: "keep working",
        });
        const error = yield* adapter.compactThread!(threadId).pipe(Effect.flip);

        assert.strictEqual(error._tag, "ProviderAdapterValidationError");
        assert.match(error.message, /already has an active turn/);
        yield* adapter.interruptTurn(threadId);
      }).pipe(
        Effect.provide(
          makeDevinAdapterLive({
            makeRuntime: () =>
              Effect.succeed(
                makeMockRuntime({
                  prompt: () => Effect.promise(() => promptPromise),
                  cancel: Effect.sync(() => {
                    resolvePrompt({
                      stopReason: "cancelled",
                    } as EffectAcpSchema.PromptResponse);
                  }),
                }),
              ),
          }),
        ),
      );
    })(),
  );

  it.effect("composer capabilities advertise thread compaction", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const capabilities = yield* adapter.getComposerCapabilities!();

      assert.strictEqual(capabilities.supportsThreadCompaction, true);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("respondToUserInput fails for unknown request id", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const error = yield* adapter
        .respondToUserInput(threadId, ApprovalRequestId.makeUnsafe("nonexistent-request"), {
          choice: "a",
        })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "ProviderAdapterRequestError");
      assert.match(error.message, /Unknown pending user-input request/);

      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("registers elicitation handler during Devin session startup", () => {
    let handlerRegistered = false;

    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.strictEqual(
        handlerRegistered,
        true,
        "elicitation handler should be registered during session start",
      );

      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                onHandleElicitation: () => {
                  handlerRegistered = true;
                },
              }),
            ),
        }),
      ),
    );
  });

  type ElicitationHandler = (
    request: EffectAcpSchema.ElicitationRequest,
  ) => Effect.Effect<EffectAcpSchema.ElicitationResponse, EffectAcpErrors.AcpError>;

  type UserInputRequestedEvent = ProviderRuntimeUserInputRequestedEvent;
  type UserInputResolvedEvent = ProviderRuntimeUserInputResolvedEvent;

  const enumFormRequest: EffectAcpSchema.ElicitationRequest = {
    mode: "form",
    sessionId: "devin-session-1",
    message: "Pick one",
    requestedSchema: {
      type: "object",
      properties: {
        choice: { type: "string", enum: ["a", "b"] },
      },
    },
  };

  const elicitationCapturingLayer = (capture: (handler: ElicitationHandler) => void) =>
    makeDevinAdapterLive({
      makeRuntime: () =>
        Effect.succeed(
          makeMockRuntime({
            onHandleElicitation: capture,
          }),
        ),
    });

  it.effect(
    "publishes user-input.requested for a Devin form elicitation and resolves with accepted answers",
    () => {
      let elicitationHandler: ElicitationHandler | undefined;
      return Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        yield* adapter.startSession({
          threadId,
          provider: "devin",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        assert.isDefined(elicitationHandler);

        const requestedFiber = yield* Stream.runHead(
          Stream.filter(
            adapter.streamEvents,
            (event): event is UserInputRequestedEvent => event.type === "user-input.requested",
          ),
        ).pipe(Effect.forkChild);
        const resolvedFiber = yield* Stream.runHead(
          Stream.filter(
            adapter.streamEvents,
            (event): event is UserInputResolvedEvent => event.type === "user-input.resolved",
          ),
        ).pipe(Effect.forkChild);

        const handlerFiber = yield* elicitationHandler!(enumFormRequest).pipe(Effect.forkChild);

        const requested = Option.getOrThrow(yield* Fiber.join(requestedFiber));
        assert.strictEqual(requested.threadId, threadId);
        assert.strictEqual(requested.payload.questions.length, 1);
        assert.strictEqual(requested.payload.questions[0]!.id, "choice");

        yield* adapter.respondToUserInput(
          threadId,
          ApprovalRequestId.makeUnsafe(String(requested.requestId)),
          { choice: "a" },
        );

        const result = yield* Fiber.join(handlerFiber);
        assert.deepStrictEqual(result, {
          action: { action: "accept", content: { choice: "a" } },
        });

        const resolved = Option.getOrThrow(yield* Fiber.join(resolvedFiber));
        assert.strictEqual(String(resolved.requestId), String(requested.requestId));
        // Answers are redacted in user-input.resolved for privacy; only the
        // requestId and redacted flag are published.
        assert.deepStrictEqual(resolved.payload.answers, {});

        yield* adapter.stopSession(threadId);
      }).pipe(
        Effect.provide(
          elicitationCapturingLayer((handler) => {
            elicitationHandler = handler;
          }),
        ),
      );
    },
  );

  it.effect("declines URL-mode elicitation without publishing user-input.requested", () => {
    let elicitationHandler: ElicitationHandler | undefined;
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.isDefined(elicitationHandler);

      // Collect everything up to the deterministic user-input.resolved marker.
      // The form elicitation below proves the subscription is live before the
      // URL handler runs, so a missing URL event is a real non-emission.
      const eventsFiber = yield* Stream.runCollect(
        Stream.takeUntil(adapter.streamEvents, (event) => event.type === "user-input.resolved"),
      ).pipe(Effect.forkChild);
      const requestedFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event): event is UserInputRequestedEvent => event.type === "user-input.requested",
        ),
      ).pipe(Effect.forkChild);

      const formFiber = yield* elicitationHandler!(enumFormRequest).pipe(Effect.forkChild);
      const requested = Option.getOrThrow(yield* Fiber.join(requestedFiber));

      const urlResult = yield* elicitationHandler!({
        mode: "url",
        elicitationId: "elicitation-1",
        url: "https://example.com/auth",
        message: "Open this URL",
        sessionId: "devin-session-1",
      });
      assert.deepStrictEqual(urlResult, { action: { action: "decline" } });

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.makeUnsafe(String(requested.requestId)),
        { choice: "a" },
      );
      yield* Fiber.join(formFiber);

      const events = [...(yield* Fiber.join(eventsFiber))];
      const requestedEvents = events.filter((event) => event.type === "user-input.requested");
      assert.strictEqual(requestedEvents.length, 1);
      assert.strictEqual(String(requestedEvents[0]!.requestId), String(requested.requestId));

      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        elicitationCapturingLayer((handler) => {
          elicitationHandler = handler;
        }),
      ),
    );
  });

  it.effect("rejects invalid answers without resolving the pending Devin elicitation", () => {
    let elicitationHandler: ElicitationHandler | undefined;
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.isDefined(elicitationHandler);

      const requestedFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event): event is UserInputRequestedEvent => event.type === "user-input.requested",
        ),
      ).pipe(Effect.forkChild);
      const handlerFiber = yield* elicitationHandler!(enumFormRequest).pipe(Effect.forkChild);

      const requested = Option.getOrThrow(yield* Fiber.join(requestedFiber));
      const requestId = ApprovalRequestId.makeUnsafe(String(requested.requestId));

      const error = yield* adapter
        .respondToUserInput(threadId, requestId, { choice: "not-allowed" })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterValidationError");
      assert.match(error.message, /Invalid Devin elicitation answers/);

      // The pending request must survive the invalid attempt and accept a retry.
      yield* adapter.respondToUserInput(threadId, requestId, { choice: "a" });
      const result = yield* Fiber.join(handlerFiber);
      assert.deepStrictEqual(result, {
        action: { action: "accept", content: { choice: "a" } },
      });

      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        elicitationCapturingLayer((handler) => {
          elicitationHandler = handler;
        }),
      ),
    );
  });

  it.effect("stopSession settles pending user input with cancel", () => {
    let elicitationHandler: ElicitationHandler | undefined;
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.isDefined(elicitationHandler);

      const requestedFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event): event is UserInputRequestedEvent => event.type === "user-input.requested",
        ),
      ).pipe(Effect.forkChild);
      const handlerFiber = yield* elicitationHandler!(enumFormRequest).pipe(Effect.forkChild);

      Option.getOrThrow(yield* Fiber.join(requestedFiber));
      yield* adapter.stopSession(threadId);

      const result = yield* Fiber.join(handlerFiber);
      assert.deepStrictEqual(result, { action: { action: "cancel" } });
    }).pipe(
      Effect.provide(
        elicitationCapturingLayer((handler) => {
          elicitationHandler = handler;
        }),
      ),
    );
  });

  // ── Resume cursor edge cases ──────────────────────────────────────

  it.effect("starts a fresh session when resumeCursor has wrong schemaVersion", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const session = yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 99, sessionId: "old-session" },
      });

      // Mock runtime ignores resumeSessionId, so a fresh session id is returned.
      assert.strictEqual(session.status, "ready");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "devin-session-1",
      });
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("starts a fresh session when resumeCursor is missing sessionId", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const session = yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1 },
      });

      assert.strictEqual(session.status, "ready");
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("starts a fresh session when resumeCursor is a non-object primitive", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const session = yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
        resumeCursor: "not-an-object",
      });

      assert.strictEqual(session.status, "ready");
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("starts a fresh session when resumeCursor sessionId is whitespace-only", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const session = yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "   " },
      });

      assert.strictEqual(session.status, "ready");
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("passes a trimmed sessionId to the runtime when resumeCursor is valid", () => {
    let receivedResumeSessionId: string | undefined;
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "  prior-session-id  " },
      });
      assert.strictEqual(receivedResumeSessionId, "prior-session-id");
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: (input) => {
            receivedResumeSessionId = input.resumeSessionId;
            return Effect.succeed(makeMockRuntime());
          },
        }),
      ),
    );
  });

  // ── sendTurn empty prompt validation ──────────────────────────────

  it.effect("rejects an empty prompt with a validation error", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const error = yield* adapter.sendTurn({ threadId, input: "" }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterValidationError");
      assert.match(error.message, /non-empty prompt/);

      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("rejects a whitespace-only prompt with a validation error", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const error = yield* adapter.sendTurn({ threadId, input: "   \n\t  " }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterValidationError");
      assert.match(error.message, /non-empty prompt/);

      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  // ── sendTurn interruption ─────────────────────────────────────────

  it.effect("interruptTurn is a no-op when no turn is active", () => {
    let cancelCalled = false;
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      // interruptTurn on a session with no active turn should succeed cleanly.
      yield* adapter.interruptTurn(threadId);
      assert.strictEqual(cancelCalled, true);

      // Session should still be usable.
      assert.strictEqual(yield* adapter.hasSession(threadId), true);
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                cancel: Effect.sync(() => {
                  cancelCalled = true;
                }),
              }),
            ),
        }),
      ),
    );
  });

  // ── Permission auto-approval in full-access mode ──────────────────

  it.effect(
    "auto-approves permission requests in full-access mode when a full-access option exists",
    () => {
      type PermissionHandler = (
        params: EffectAcpSchema.RequestPermissionRequest,
      ) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError>;
      let permissionHandler: PermissionHandler | undefined;
      return Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        yield* adapter.startSession({
          threadId,
          provider: "devin",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        assert.isDefined(permissionHandler);

        // Drive the registered handler with a permission request that has a
        // "allow_always" option kind which full-access mode auto-selects.
        const params = {
          options: [
            { kind: "allow_once", optionId: "allow-once" },
            { kind: "allow_always", optionId: "always-allow" },
          ],
          kind: "command",
          command: "rm -rf /tmp/scratch",
        } as unknown as EffectAcpSchema.RequestPermissionRequest;

        const result = yield* permissionHandler!(params);
        assert.strictEqual(result.outcome.outcome, "selected");
        if (result.outcome.outcome === "selected") {
          assert.strictEqual(result.outcome.optionId, "always-allow");
        }
        yield* adapter.stopSession(threadId);
      }).pipe(
        Effect.provide(
          makeDevinAdapterLive({
            makeRuntime: () =>
              Effect.succeed(
                makeMockRuntime({
                  onHandleRequestPermission: (handler) => {
                    permissionHandler = handler;
                  },
                }),
              ),
          }),
        ),
      );
    },
  );

  // ── Plan mode safety ──────────────────────────────────────────────

  it.effect("wraps plan-mode prompts with proposed_plan instructions", () => {
    let capturedPrompt: Omit<EffectAcpSchema.PromptRequest, "sessionId"> | undefined;
    let resolvePromptSeen!: () => void;
    const promptSeen = new Promise<void>((resolve) => {
      resolvePromptSeen = resolve;
    });
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan a tiny doc fix",
        interactionMode: "plan",
      });
      yield* Effect.promise(() => promptSeen);
      assert.isDefined(capturedPrompt);
      const textBlock = capturedPrompt!.prompt.find(
        (block): block is Extract<typeof block, { type: "text" }> => block.type === "text",
      );
      assert.isDefined(textBlock);
      assert.include(textBlock!.text, "<proposed_plan>");
      assert.include(textBlock!.text, "Do not implement");
      assert.include(textBlock!.text, "plan a tiny doc fix");
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                modeState: {
                  currentModeId: "bypass",
                  availableModes: [
                    { id: "ask", name: "Ask" },
                    { id: "plan", name: "Plan" },
                    { id: "bypass", name: "Bypass Permissions" },
                  ],
                },
                prompt: (payload) =>
                  Effect.sync(() => {
                    capturedPrompt = payload;
                    resolvePromptSeen();
                    return { stopReason: "end_turn" } as EffectAcpSchema.PromptResponse;
                  }),
              }),
            ),
        }),
      ),
    );
  });

  it.effect("does not auto-approve permissions during plan mode even under full-access", () => {
    type PermissionHandler = (
      params: EffectAcpSchema.RequestPermissionRequest,
    ) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError>;
    let permissionHandler: PermissionHandler | undefined;
    let resolvePrompt!: (result: EffectAcpSchema.PromptResponse) => void;
    const promptPromise = new Promise<EffectAcpSchema.PromptResponse>((resolve) => {
      resolvePrompt = resolve;
    });
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.isDefined(permissionHandler);

      yield* adapter.sendTurn({
        threadId,
        input: "make a plan only",
        interactionMode: "plan",
      });

      const openedFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event): event is Extract<typeof event, { type: "request.opened" }> =>
            event.type === "request.opened",
        ),
      ).pipe(Effect.forkChild);

      const permissionFiber = yield* permissionHandler!({
        options: [
          { kind: "allow_once", optionId: "allow-once" },
          { kind: "allow_always", optionId: "always-allow" },
          { kind: "reject_once", optionId: "deny-now" },
        ],
        toolCall: {
          toolCallId: "tc-plan-1",
          title: "Edit AGENTS.md",
          kind: "edit",
          status: "pending",
          rawInput: { path: "AGENTS.md" },
        },
      } as unknown as EffectAcpSchema.RequestPermissionRequest).pipe(Effect.forkChild);

      const opened = Option.getOrThrow(yield* Fiber.join(openedFiber));
      assert.strictEqual(opened.type, "request.opened");
      assert.ok(opened.requestId);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.makeUnsafe(opened.requestId),
        "decline",
      );
      const result = yield* Fiber.join(permissionFiber);
      assert.strictEqual(result.outcome.outcome, "selected");
      if (result.outcome.outcome === "selected") {
        assert.strictEqual(result.outcome.optionId, "deny-now");
      }

      resolvePrompt({ stopReason: "end_turn" } as EffectAcpSchema.PromptResponse);
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                modeState: {
                  currentModeId: "bypass",
                  availableModes: [
                    { id: "ask", name: "Ask" },
                    { id: "plan", name: "Plan" },
                    { id: "bypass", name: "Bypass Permissions" },
                  ],
                },
                onHandleRequestPermission: (handler) => {
                  permissionHandler = handler;
                },
                prompt: () => Effect.promise(() => promptPromise),
              }),
            ),
        }),
      ),
    );
  });

  it.effect(
    "captures Exit plan mode as a proposed plan and settles the turn without UI approval",
    () => {
      type PermissionHandler = (
        params: EffectAcpSchema.RequestPermissionRequest,
      ) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError>;
      let permissionHandler: PermissionHandler | undefined;
      let resolvePrompt!: (result: EffectAcpSchema.PromptResponse) => void;
      const promptPromise = new Promise<EffectAcpSchema.PromptResponse>((resolve) => {
        resolvePrompt = resolve;
      });
      let resolveDeltaReady!: () => void;
      const deltaReady = new Promise<void>((resolve) => {
        resolveDeltaReady = resolve;
      });
      const planBody = "# Tiny plan\n\n- Fix one doc typo in formatSchemaError";
      const planDelta = {
        _tag: "ContentDelta" as const,
        text: `<proposed_plan>\n${planBody}\n</proposed_plan>`,
        streamKind: "assistant_text" as const,
        itemId: "assistant-plan-1",
        rawPayload: {},
      } satisfies AcpParsedSessionEvent;

      return Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        yield* adapter.startSession({
          threadId,
          provider: "devin",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        assert.isDefined(permissionHandler);

        const proposedFiber = yield* Stream.runHead(
          Stream.filter(
            adapter.streamEvents,
            (event): event is Extract<typeof event, { type: "turn.proposed.completed" }> =>
              event.type === "turn.proposed.completed",
          ),
        ).pipe(Effect.forkChild);
        const completedFiber = yield* Stream.runHead(
          Stream.filter(
            adapter.streamEvents,
            (event): event is Extract<typeof event, { type: "turn.completed" }> =>
              event.type === "turn.completed",
          ),
        ).pipe(Effect.forkChild);
        const contentFiber = yield* Stream.runHead(
          Stream.filter(
            adapter.streamEvents,
            (event): event is Extract<typeof event, { type: "content.delta" }> =>
              event.type === "content.delta",
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.sendTurn({
          threadId,
          input: "make a plan",
          interactionMode: "plan",
        });

        // Deliver tagged plan text first (prefers full markdown over short tool plan).
        resolveDeltaReady();
        Option.getOrThrow(yield* Fiber.join(contentFiber));
        // Tags alone should already emit the proposed plan card.
        const proposed = Option.getOrThrow(yield* Fiber.join(proposedFiber));
        assert.strictEqual(proposed.type, "turn.proposed.completed");
        if (proposed.type === "turn.proposed.completed") {
          assert.include(proposed.payload.planMarkdown, "Tiny plan");
          assert.include(proposed.payload.planMarkdown, "formatSchemaError");
        }

        const result = yield* permissionHandler!({
          options: [
            { kind: "allow_once", optionId: "allow-once" },
            { kind: "allow_always", optionId: "always-allow" },
            { kind: "reject_once", optionId: "deny-now" },
          ],
          toolCall: {
            toolCallId: "tc-exit-plan",
            title: "Exit plan mode",
            kind: "switch_mode",
            status: "pending",
            rawInput: {
              plan: "Add a JSDoc comment to formatSchemaError",
            },
          },
        } as unknown as EffectAcpSchema.RequestPermissionRequest);

        // Cancelled (not accept/reject): ACP cancel protocol + freezes further tools.
        assert.deepStrictEqual(result.outcome, { outcome: "cancelled" });

        const completed = Option.getOrThrow(yield* Fiber.join(completedFiber));
        assert.strictEqual(completed.type, "turn.completed");
        if (completed.type === "turn.completed") {
          assert.strictEqual(completed.payload.state, "completed");
        }

        // Further Exit plan attempts must be hard-cancelled (no re-plan loop).
        const second = yield* permissionHandler!({
          options: [
            { kind: "allow_once", optionId: "allow-once" },
            { kind: "reject_once", optionId: "deny-now" },
          ],
          toolCall: {
            toolCallId: "tc-exit-plan-2",
            title: "Exit plan mode",
            kind: "switch_mode",
            status: "pending",
            rawInput: { plan: "another plan" },
          },
        } as unknown as EffectAcpSchema.RequestPermissionRequest);
        assert.deepStrictEqual(second.outcome, { outcome: "cancelled" });

        resolvePrompt({ stopReason: "end_turn" } as EffectAcpSchema.PromptResponse);
        yield* adapter.stopSession(threadId);
      }).pipe(
        Effect.provide(
          makeDevinAdapterLive({
            makeRuntime: () =>
              Effect.succeed(
                makeMockRuntime({
                  modeState: {
                    currentModeId: "plan",
                    availableModes: [
                      { id: "ask", name: "Ask" },
                      { id: "plan", name: "Plan" },
                      { id: "bypass", name: "Bypass Permissions" },
                    ],
                  },
                  onHandleRequestPermission: (handler) => {
                    permissionHandler = handler;
                  },
                  events: Stream.fromEffect(
                    Effect.promise(() => deltaReady).pipe(Effect.as(planDelta)),
                  ),
                  prompt: () => Effect.promise(() => promptPromise),
                }),
              ),
          }),
        ),
      );
    },
  );

  it.effect("handles sparse Exit plan permission after tool_call update (real Devin shape)", () => {
    type PermissionHandler = (
      params: EffectAcpSchema.RequestPermissionRequest,
    ) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError>;
    let permissionHandler: PermissionHandler | undefined;
    let resolvePrompt!: (result: EffectAcpSchema.PromptResponse) => void;
    const promptPromise = new Promise<EffectAcpSchema.PromptResponse>((resolve) => {
      resolvePrompt = resolve;
    });
    let resolveEventsReady!: () => void;
    const eventsReady = new Promise<void>((resolve) => {
      resolveEventsReady = resolve;
    });
    const planBody = "# Sparse exit plan\n\n- Add a period in KEYBINDINGS.md";
    const planDelta = {
      _tag: "ContentDelta" as const,
      text: `<proposed_plan>\n${planBody}\n</proposed_plan>`,
      streamKind: "assistant_text" as const,
      itemId: "assistant-plan-2",
      rawPayload: {},
    } satisfies AcpParsedSessionEvent;
    const toolUpdate = {
      _tag: "ToolCallUpdated" as const,
      toolCall: {
        toolCallId: "18d3792f7",
        title: "Exit plan mode",
        kind: "switch_mode",
        status: "inProgress" as const,
        data: {
          toolCallId: "18d3792f7",
          kind: "switch_mode",
          rawInput: {
            plan: "Add a missing period at the end of line 35 in KEYBINDINGS.md",
          },
        },
      },
      rawPayload: {},
    } satisfies AcpParsedSessionEvent;

    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.isDefined(permissionHandler);

      const proposedFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event): event is Extract<typeof event, { type: "turn.proposed.completed" }> =>
            event.type === "turn.proposed.completed",
        ),
      ).pipe(Effect.forkChild);
      const completedFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event): event is Extract<typeof event, { type: "turn.completed" }> =>
            event.type === "turn.completed",
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.sendTurn({
        threadId,
        input: "make a plan",
        interactionMode: "plan",
      });

      resolveEventsReady();
      const proposed = Option.getOrThrow(yield* Fiber.join(proposedFiber));
      assert.include(
        proposed.type === "turn.proposed.completed" ? proposed.payload.planMarkdown : "",
        "Sparse exit plan",
      );
      // Let ToolCallUpdated land in toolCallMetaById before the sparse permission.
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(resolve);
          }),
      );

      // Real Devin often sends request_permission with ONLY toolCallId.
      // Title/kind/rawInput were already seen on tool_call updates.
      const result = yield* permissionHandler!({
        sessionId: "swamp-spur",
        options: [
          { kind: "allow_once", optionId: "allow-once" },
          { kind: "allow_always", optionId: "always-allow" },
          { kind: "reject_once", optionId: "deny-now" },
        ],
        toolCall: {
          toolCallId: "18d3792f7",
        },
      } as unknown as EffectAcpSchema.RequestPermissionRequest);

      assert.deepStrictEqual(result.outcome, { outcome: "cancelled" });

      const completed = Option.getOrThrow(yield* Fiber.join(completedFiber));
      assert.strictEqual(completed.type, "turn.completed");
      if (completed.type === "turn.completed") {
        assert.strictEqual(completed.payload.state, "completed");
      }

      resolvePrompt({ stopReason: "end_turn" } as EffectAcpSchema.PromptResponse);
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                modeState: {
                  currentModeId: "plan",
                  availableModes: [
                    { id: "ask", name: "Ask" },
                    { id: "plan", name: "Plan" },
                    { id: "bypass", name: "Bypass Permissions" },
                  ],
                },
                onHandleRequestPermission: (handler) => {
                  permissionHandler = handler;
                },
                events: Stream.unwrap(
                  Effect.promise(() => eventsReady).pipe(
                    Effect.map(() => Stream.make(planDelta, toolUpdate)),
                  ),
                ),
                prompt: () => Effect.promise(() => promptPromise),
              }),
            ),
        }),
      ),
    );
  });

  it.effect("treats sparse permission as Exit plan when tagged plan is already complete", () => {
    type PermissionHandler = (
      params: EffectAcpSchema.RequestPermissionRequest,
    ) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError>;
    let permissionHandler: PermissionHandler | undefined;
    let resolvePrompt!: (result: EffectAcpSchema.PromptResponse) => void;
    const promptPromise = new Promise<EffectAcpSchema.PromptResponse>((resolve) => {
      resolvePrompt = resolve;
    });
    let resolveDeltaReady!: () => void;
    const deltaReady = new Promise<void>((resolve) => {
      resolveDeltaReady = resolve;
    });
    const planDelta = {
      _tag: "ContentDelta" as const,
      text: "<proposed_plan>\n# Race plan\n\n- one step\n</proposed_plan>",
      streamKind: "assistant_text" as const,
      itemId: "assistant-plan-3",
      rawPayload: {},
    } satisfies AcpParsedSessionEvent;

    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.isDefined(permissionHandler);

      const completedFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event): event is Extract<typeof event, { type: "turn.completed" }> =>
            event.type === "turn.completed",
        ),
      ).pipe(Effect.forkChild);
      const proposedFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event): event is Extract<typeof event, { type: "turn.proposed.completed" }> =>
            event.type === "turn.proposed.completed",
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.sendTurn({
        threadId,
        input: "make a plan",
        interactionMode: "plan",
      });
      resolveDeltaReady();
      Option.getOrThrow(yield* Fiber.join(proposedFiber));

      // Permission arrives with only toolCallId BEFORE/without tool meta enrichment.
      // hasCompletedPlan fallback must still settle the turn.
      const result = yield* permissionHandler!({
        sessionId: "swamp-spur",
        options: [
          { kind: "allow_once", optionId: "allow-once" },
          { kind: "allow_always", optionId: "always-allow" },
          { kind: "reject_once", optionId: "deny-now" },
        ],
        toolCall: { toolCallId: "only-id" },
      } as unknown as EffectAcpSchema.RequestPermissionRequest);

      assert.deepStrictEqual(result.outcome, { outcome: "cancelled" });
      const completed = Option.getOrThrow(yield* Fiber.join(completedFiber));
      assert.strictEqual(completed.type, "turn.completed");

      resolvePrompt({ stopReason: "end_turn" } as EffectAcpSchema.PromptResponse);
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                modeState: {
                  currentModeId: "plan",
                  availableModes: [
                    { id: "ask", name: "Ask" },
                    { id: "plan", name: "Plan" },
                    { id: "bypass", name: "Bypass Permissions" },
                  ],
                },
                onHandleRequestPermission: (handler) => {
                  permissionHandler = handler;
                },
                events: Stream.fromEffect(
                  Effect.promise(() => deltaReady).pipe(Effect.as(planDelta)),
                ),
                prompt: () => Effect.promise(() => promptPromise),
              }),
            ),
        }),
      ),
    );
  });

  it.effect("emits turn.proposed.completed from tagged plan assistant text", () => {
    let resolvePrompt!: (result: EffectAcpSchema.PromptResponse) => void;
    const promptPromise = new Promise<EffectAcpSchema.PromptResponse>((resolve) => {
      resolvePrompt = resolve;
    });
    let resolveDeltaReady!: () => void;
    const deltaReady = new Promise<void>((resolve) => {
      resolveDeltaReady = resolve;
    });
    const planBody = "# Tiny plan\n\n- Fix one doc typo";
    const planDelta = {
      _tag: "ContentDelta" as const,
      text: `<proposed_plan>\n${planBody}\n</proposed_plan>`,
      streamKind: "assistant_text" as const,
      itemId: "assistant-1",
      rawPayload: {},
    } satisfies AcpParsedSessionEvent;

    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const proposedFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event): event is Extract<typeof event, { type: "turn.proposed.completed" }> =>
            event.type === "turn.proposed.completed",
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.sendTurn({
        threadId,
        input: "make a plan",
        interactionMode: "plan",
      });

      // Content delta is gated until after plan mode is active (sendTurn above).
      resolveDeltaReady();
      // Yield to the notification fiber so the delta is buffered before prompt settles.
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            setImmediate(resolve);
          }),
      );
      resolvePrompt({ stopReason: "end_turn" } as EffectAcpSchema.PromptResponse);

      const proposed = Option.getOrThrow(yield* Fiber.join(proposedFiber));
      assert.strictEqual(proposed.type, "turn.proposed.completed");
      if (proposed.type === "turn.proposed.completed") {
        assert.include(proposed.payload.planMarkdown, "Tiny plan");
        assert.include(proposed.payload.planMarkdown, "doc typo");
      }
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                modeState: {
                  currentModeId: "bypass",
                  availableModes: [
                    { id: "ask", name: "Ask" },
                    { id: "plan", name: "Plan" },
                    { id: "bypass", name: "Bypass Permissions" },
                  ],
                },
                events: Stream.fromEffect(
                  Effect.promise(() => deltaReady).pipe(Effect.as(planDelta)),
                ),
                prompt: () => Effect.promise(() => promptPromise),
              }),
            ),
        }),
      ),
    );
  });

  // ── stopSession settles pending approvals ─────────────────────────

  it.effect("stopSession settles pending approval requests with cancel", () => {
    type PermissionHandler = (
      params: EffectAcpSchema.RequestPermissionRequest,
    ) => Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError>;
    let permissionHandler: PermissionHandler | undefined;
    return Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "approval-required",
      });
      assert.isDefined(permissionHandler);

      // Wait for the request.opened event to ensure the handler has
      // registered its deferred before we call stopSession.
      const requestedFiber = yield* Stream.runHead(
        Stream.filter(
          adapter.streamEvents,
          (event): event is Extract<typeof event, { type: "request.opened" }> =>
            event.type === "request.opened",
        ),
      ).pipe(Effect.forkChild);

      const permissionFiber = yield* permissionHandler!({
        options: [{ kind: "allow_once", optionId: "allow" }],
        toolCall: {
          toolCallId: "tc-1",
          title: "Run echo",
          kind: "command",
          status: "pending",
          rawInput: { command: "echo hi" },
        },
      } as unknown as EffectAcpSchema.RequestPermissionRequest).pipe(Effect.forkChild);

      // Wait for the request to be registered before stopping.
      Option.getOrThrow(yield* Fiber.join(requestedFiber));

      // stopSession should settle the pending approval as cancel.
      yield* adapter.stopSession(threadId);

      const result = yield* Fiber.join(permissionFiber);
      assert.deepStrictEqual(result, { outcome: { outcome: "cancelled" } });
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                onHandleRequestPermission: (handler) => {
                  permissionHandler = handler;
                },
              }),
            ),
        }),
      ),
    );
  });

  it.effect("returns no commands when threadId is omitted and cwd does not match any session", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project-a",
        runtimeMode: "full-access",
      });

      const result = yield* adapter.listCommands!({
        provider: "devin",
        cwd: "/tmp/nonexistent",
      });

      assert.deepStrictEqual(result.commands, []);
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                availableCommands: [{ name: "revert", description: "Revert changes" }],
              }),
            ),
        }),
      ),
    ),
  );

  // ── listCommands cwd matching when threadId is omitted ────────────

  it.effect(
    "does not return commands from a session whose cwd differs when threadId is omitted",
    () =>
      Effect.gen(function* () {
        const adapter = yield* DevinAdapter;
        yield* adapter.startSession({
          threadId,
          provider: "devin",
          cwd: "/tmp/project-a",
          runtimeMode: "full-access",
        });

        const result = yield* adapter.listCommands!({
          provider: "devin",
          cwd: "/tmp/project-b",
        });

        assert.deepStrictEqual(result.commands, []);
        assert.strictEqual(result.source, "devin.acp");
        yield* adapter.stopSession(threadId);
      }).pipe(
        Effect.provide(
          makeDevinAdapterLive({
            makeRuntime: () =>
              Effect.succeed(
                makeMockRuntime({
                  availableCommands: [{ name: "revert", description: "Revert changes" }],
                }),
              ),
          }),
        ),
      ),
  );

  it.effect("returns commands from a session whose cwd matches when threadId is omitted", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project-a",
        runtimeMode: "full-access",
      });

      const result = yield* adapter.listCommands!({
        provider: "devin",
        cwd: "/tmp/project-a",
      });

      assert.deepStrictEqual(result.commands, [{ name: "revert", description: "Revert changes" }]);
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () =>
            Effect.succeed(
              makeMockRuntime({
                availableCommands: [{ name: "revert", description: "Revert changes" }],
              }),
            ),
        }),
      ),
    ),
  );

  // ── rollbackThread validation ─────────────────────────────────────

  it.effect("rejects rollback with non-integer numTurns", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const error = yield* adapter.rollbackThread(threadId, 1.5).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterValidationError");
      assert.match(error.message, /numTurns must be an integer/);

      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("rejects rollback with numTurns < 1", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      const error = yield* adapter.rollbackThread(threadId, 0).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterValidationError");
      assert.match(error.message, /numTurns must be an integer/);

      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  // ── hasSession / readThread ───────────────────────────────────────

  it.effect("hasSession returns false for unknown thread and true for running session", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      assert.strictEqual(yield* adapter.hasSession(threadId), false);
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.strictEqual(yield* adapter.hasSession(threadId), true);
      yield* adapter.stopSession(threadId);
      assert.strictEqual(yield* adapter.hasSession(threadId), false);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("readThread returns turns and cwd for a running session", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      const thread = yield* adapter.readThread(threadId);
      assert.strictEqual(thread.threadId, threadId);
      assert.deepStrictEqual(thread.turns, []);
      assert.strictEqual(thread.cwd, "/tmp/project");
      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  it.effect("readThread fails for an unknown thread", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const error = yield* adapter.readThread(threadId).pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterSessionNotFoundError");
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  // ── stopAll ───────────────────────────────────────────────────────

  it.effect("stopAll stops every running session", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const threadId2 = ThreadId.makeUnsafe("thread-devin-2");
      yield* adapter.startSession({
        threadId,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        threadId: threadId2,
        provider: "devin",
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* adapter.stopAll();

      assert.strictEqual(yield* adapter.hasSession(threadId), false);
      assert.strictEqual(yield* adapter.hasSession(threadId2), false);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );

  // ── startSession provider mismatch ────────────────────────────────

  it.effect("startSession rejects when input.provider is a different provider", () =>
    Effect.gen(function* () {
      const adapter = yield* DevinAdapter;
      const error = yield* adapter
        .startSession({
          threadId,
          provider: "codex",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterValidationError");
      assert.match(error.message, /Expected provider 'devin'/);
    }).pipe(
      Effect.provide(
        makeDevinAdapterLive({
          makeRuntime: () => Effect.succeed(makeMockRuntime()),
        }),
      ),
    ),
  );
});
