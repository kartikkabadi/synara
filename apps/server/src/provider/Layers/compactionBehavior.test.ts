// Adapter contract regressions using synthetic runtime events. Historical CLI
// observations motivated these fixtures; this suite does not execute providers.

import assert from "node:assert/strict";
import type { ProviderEvent, ProviderKind } from "@synara/contracts";
import { EventId, ThreadId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Stream } from "effect";

import { CodexAppServerManager } from "../../codexAppServerManager.ts";
import { ServerConfig } from "../../config.ts";
import type { OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { OpenCodeRuntime } from "../opencodeRuntime.ts";
import { AntigravityAdapter } from "../Services/AntigravityAdapter.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { DroidAdapter } from "../Services/DroidAdapter.ts";
import { GrokAdapter } from "../Services/GrokAdapter.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import { PiAdapter } from "../Services/PiAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeAntigravityAdapterLive } from "./AntigravityAdapter.ts";
import { makeCodexAdapterLive } from "./CodexAdapter.ts";
import { makeCursorAdapterLive } from "./CursorAdapter.ts";
import { makeDroidAdapterLive } from "./DroidAdapter.ts";
import { isGrokContextCompactionToolCall, makeGrokAdapterLive } from "./GrokAdapter.ts";
import { makeOpenCodeAdapterLive } from "./OpenCodeAdapter.ts";
import { makePiAdapterLive } from "./PiAdapter.ts";

// This table records the adapter surfaces under test. It is not live CLI or
// protocol certification; exact native thresholds come from adapter hooks.
interface CompactionCharacterization {
  readonly supportsThreadCompaction: boolean;
  readonly manual: {
    readonly mode: "native" | "prompt" | "unsupported";
    readonly mechanism: string | undefined;
  };
  readonly automatic: {
    readonly mode: "native" | "off-by-default" | "unsupported";
    readonly triggerVisibility: "events" | "between-turn-heuristic" | "none";
  };
  readonly telemetry: {
    readonly contextUsage: boolean;
  };
}

const COMPACTION_CHARACTERIZATION: Record<
  Extract<ProviderKind, "codex" | "grok" | "opencode" | "pi" | "droid" | "antigravity" | "cursor">,
  CompactionCharacterization
> = {
  codex: {
    supportsThreadCompaction: true,
    manual: { mode: "native", mechanism: "thread/compact/start" },
    automatic: { mode: "native", triggerVisibility: "events" },
    telemetry: { contextUsage: true },
  },
  grok: {
    supportsThreadCompaction: true,
    manual: { mode: "prompt", mechanism: "/compact" },
    automatic: { mode: "off-by-default", triggerVisibility: "between-turn-heuristic" },
    telemetry: { contextUsage: false },
  },
  opencode: {
    supportsThreadCompaction: true,
    manual: { mode: "native", mechanism: "session.summarize" },
    automatic: { mode: "native", triggerVisibility: "events" },
    telemetry: { contextUsage: true },
  },
  pi: {
    supportsThreadCompaction: true,
    manual: { mode: "native", mechanism: "session.compact" },
    automatic: { mode: "native", triggerVisibility: "events" },
    telemetry: { contextUsage: true },
  },
  droid: {
    supportsThreadCompaction: false,
    manual: { mode: "unsupported", mechanism: undefined },
    automatic: { mode: "unsupported", triggerVisibility: "none" },
    telemetry: { contextUsage: false },
  },
  antigravity: {
    supportsThreadCompaction: false,
    manual: { mode: "unsupported", mechanism: undefined },
    automatic: { mode: "unsupported", triggerVisibility: "none" },
    telemetry: { contextUsage: false },
  },
  cursor: {
    supportsThreadCompaction: false,
    manual: { mode: "unsupported", mechanism: undefined },
    automatic: { mode: "unsupported", triggerVisibility: "none" },
    telemetry: { contextUsage: false },
  },
};

describe("compaction characterization table consistency", () => {
  it("marks a provider compactable exactly when a manual mechanism exists", () => {
    for (const [provider, entry] of Object.entries(COMPACTION_CHARACTERIZATION)) {
      expect(
        entry.supportsThreadCompaction,
        `${provider}: supportsThreadCompaction must track manual compaction support`,
      ).toBe(entry.manual.mode !== "unsupported");
      expect(
        entry.manual.mechanism !== undefined,
        `${provider}: manual mechanism must be recorded iff manual compaction is supported`,
      ).toBe(entry.manual.mode !== "unsupported");
      expect(
        entry.automatic.triggerVisibility !== "none",
        `${provider}: trigger visibility must be recorded iff automatic compaction exists`,
      ).toBe(entry.automatic.mode !== "unsupported");
    }
  });
});

describe("codex composer capabilities", () => {
  it("advertises native thread compaction from the app-server manager", () => {
    const capabilities = new CodexAppServerManager().getComposerCapabilities();
    expect(capabilities.provider).toBe("codex");
    expect(capabilities.supportsThreadCompaction).toBe(
      COMPACTION_CHARACTERIZATION.codex.supportsThreadCompaction,
    );
  });
});

const stubOpenCodeRuntime = {} as OpenCodeRuntimeShape;

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  remove: () => Effect.void,
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

const codexLifecycleManager = new CodexAppServerManager();

const adapterCapabilitiesLayer = it.layer(
  Layer.mergeAll(
    makeGrokAdapterLive(),
    makeDroidAdapterLive(),
    makeCursorAdapterLive(),
    makeAntigravityAdapterLive(),
    makePiAdapterLive(),
    makeOpenCodeAdapterLive(),
    makeCodexAdapterLive({ manager: codexLifecycleManager }),
  ).pipe(
    Layer.provideMerge(Layer.succeed(OpenCodeRuntime, stubOpenCodeRuntime)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

adapterCapabilitiesLayer("provider compaction capability flags", (it) => {
  it.effect("match the compaction contract per adapter", () =>
    Effect.gen(function* () {
      const adapters = {
        codex: yield* CodexAdapter,
        grok: yield* GrokAdapter,
        opencode: yield* OpenCodeAdapter,
        pi: yield* PiAdapter,
        droid: yield* DroidAdapter,
        antigravity: yield* AntigravityAdapter,
        cursor: yield* CursorAdapter,
      };
      for (const [provider, entry] of Object.entries(COMPACTION_CHARACTERIZATION)) {
        const adapter = adapters[provider as keyof typeof adapters];
        assert.ok(
          adapter.getComposerCapabilities,
          `${provider}: adapter must expose composer capabilities`,
        );
        const capabilities = yield* adapter.getComposerCapabilities();
        assert.equal(
          capabilities.supportsThreadCompaction,
          entry.supportsThreadCompaction,
          `${provider}: supportsThreadCompaction flag drifted from its compaction contract`,
        );
      }
    }),
  );

  it.effect("expose compactThread exactly for providers with a manual mechanism", () =>
    Effect.gen(function* () {
      const adapters = {
        codex: yield* CodexAdapter,
        grok: yield* GrokAdapter,
        opencode: yield* OpenCodeAdapter,
        pi: yield* PiAdapter,
        droid: yield* DroidAdapter,
        antigravity: yield* AntigravityAdapter,
        cursor: yield* CursorAdapter,
      };
      for (const [provider, entry] of Object.entries(COMPACTION_CHARACTERIZATION)) {
        const adapter = adapters[provider as keyof typeof adapters];
        assert.equal(
          adapter.compactThread !== undefined,
          entry.manual.mode !== "unsupported",
          `${provider}: compactThread surface drifted from its compaction contract`,
        );
      }
    }),
  );

  it.effect("projects codex thread/compacting into a context_compaction progress item", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(
        adapter.streamEvents.pipe(Stream.filter((event) => event.type === "item.started")),
      ).pipe(Effect.forkChild);

      codexLifecycleManager.emit("event", {
        id: EventId.makeUnsafe("evt-compaction-behavior-compacting"),
        kind: "notification",
        provider: "codex",
        threadId: ThreadId.makeUnsafe("thread-compaction-1"),
        createdAt: new Date().toISOString(),
        method: "thread/compacting",
        message: "Compacting context",
        payload: { threadId: "thread-compaction-1", state: "compacting" },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") return;
      assert.equal(firstEvent.value.type, "item.started");
      if (firstEvent.value.type !== "item.started") return;
      assert.equal(firstEvent.value.payload.itemType, "context_compaction");
      assert.equal(firstEvent.value.payload.status, "inProgress");
    }),
  );

  it.effect("projects codex thread/compacted into a compacted thread state change", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstEventFiber = yield* Stream.runHead(
        adapter.streamEvents.pipe(Stream.filter((event) => event.type === "thread.state.changed")),
      ).pipe(Effect.forkChild);

      codexLifecycleManager.emit("event", {
        id: EventId.makeUnsafe("evt-compaction-behavior-compacted"),
        kind: "notification",
        provider: "codex",
        threadId: ThreadId.makeUnsafe("thread-compaction-1"),
        createdAt: new Date().toISOString(),
        method: "thread/compacted",
        payload: { threadId: "thread-compaction-1" },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") return;
      assert.equal(firstEvent.value.type, "thread.state.changed");
      if (firstEvent.value.type !== "thread.state.changed") return;
      assert.equal(firstEvent.value.payload.state, "compacted");
    }),
  );
});

describe("grok between-turn compaction heuristic", () => {
  it("treats compaction- and summarization-shaped tool calls as context compaction", () => {
    expect(
      isGrokContextCompactionToolCall({
        toolCallId: "tool-1",
        kind: "other",
        status: "inProgress",
        title: "Compacting conversation context",
        data: {},
      }),
    ).toBe(true);
    expect(
      isGrokContextCompactionToolCall({
        toolCallId: "tool-2",
        kind: "other",
        status: "inProgress",
        title: "Summarizing earlier conversation",
        data: {},
      }),
    ).toBe(true);
  });

  it("does not classify ordinary tool calls as context compaction", () => {
    expect(
      isGrokContextCompactionToolCall({
        toolCallId: "tool-3",
        kind: "execute",
        status: "completed",
        title: "Run tests",
        data: {},
      }),
    ).toBe(false);
  });
});
