// Full-app compaction media capture: renders the real ChatView (sidebar +
// header + timeline + composer) against a mocked WebSocket snapshot whose
// thread carries context-window usage, a compaction runtime status, and a
// completed context-compaction work-log entry, then captures full-window
// screenshots into e2e/compaction/visual-output/full-app/.
import "../../index.css";

import {
  EventId,
  type MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  type ProjectId,
  type ServerConfig,
  THREAD_COMPACTION_RUNTIME_STATUS_ACTIVITY_KIND,
  type ThreadId,
  type TurnId,
  type WsWelcomePayload,
  WS_METHODS,
} from "@synara/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { ws } from "msw";
import { setupWorker } from "msw/browser";
import { page, userEvent } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useLatestProjectStore } from "../../latestProjectStore";
import { getRouter } from "../../router";
import { useStore } from "../../store";
import {
  createShellSnapshotFromReadModel,
  flattenEffectRpcRequestPayload,
  readEffectRpcClientMessage,
  sendEffectRpcChunk,
  sendEffectRpcExit,
} from "../../test/effectRpcWebSocketMock";
import { createBrowserTestServerConfig, createFullscreenTestHost } from "../../test/browserHarness";
import { resetRetainedThreadDetailSubscriptionsForTests } from "../../threadDetailSubscriptionRetention";
import { resetWsNativeApiForTest } from "../../wsNativeApi";
import "../ChatView";

const THREAD_ID = "thread-compaction-media" as ThreadId;
const PROJECT_ID = "project-compaction" as ProjectId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const OUTPUT_DIR = "../../../../../e2e/compaction/visual-output/full-app";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
}

let fixture: TestFixture;
const wsLink = ws.link(/ws(s)?:\/\/.*/);

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createMessage(options: {
  id: string;
  role: "user" | "assistant";
  text: string;
  offsetSeconds: number;
  turnId?: TurnId;
}) {
  return {
    id: options.id as MessageId,
    role: options.role,
    text: options.text,
    turnId: options.turnId ?? null,
    streaming: false,
    source: "native" as const,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createCompactionSnapshot(): OrchestrationReadModel {
  const messages = [
    createMessage({
      id: "msg-user-1",
      role: "user",
      text: "Audit the checkout flow and list every place we mutate cart state.",
      offsetSeconds: 0,
    }),
    createMessage({
      id: "msg-assistant-1",
      role: "assistant",
      text: "I found 14 call sites that mutate cart state. The main ones are in `cartStore.ts`, `useCheckout.ts`, and the legacy `CartSidebar` component. Several mutate outside the reducer, which explains the stale-total bug.",
      offsetSeconds: 10,
    }),
    createMessage({
      id: "msg-user-2",
      role: "user",
      text: "Refactor them so all cart mutations go through the reducer.",
      offsetSeconds: 20,
    }),
    createMessage({
      id: "msg-assistant-2",
      role: "assistant",
      text: "Done. All 14 call sites now dispatch reducer actions; I added `cart/replaceItems` and `cart/applyDiscount` actions and updated the tests. The stale-total repro no longer occurs.",
      offsetSeconds: 30,
    }),
    createMessage({
      id: "msg-user-3",
      role: "user",
      text: "Great — now add optimistic updates for the quantity stepper.",
      offsetSeconds: 40,
    }),
    createMessage({
      id: "msg-assistant-3",
      role: "assistant",
      text: "Optimistic quantity updates are in: the stepper dispatches immediately and reconciles when the server responds, rolling back on failure with a toast.",
      offsetSeconds: 50,
      turnId: "turn-latest" as TurnId,
    }),
  ];

  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        kind: "project",
        title: "Storefront",
        workspaceRoot: "/repo/storefront",
        defaultModelSelection: { provider: "codex", model: "gpt-5" },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Checkout cart-state refactor",
        modelSelection: { provider: "codex", model: "gpt-5" },
        interactionMode: "default",
        runtimeMode: "full-access",
        envMode: "local",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        handoff: null,
        messages,
        activities: [
          {
            id: EventId.makeUnsafe("activity-context-window-configured"),
            kind: "context-window.configured",
            summary: "Context window configured",
            tone: "info",
            turnId: null,
            payload: { maxTokens: 200_000 },
            createdAt: isoAt(5),
          },
          {
            id: EventId.makeUnsafe("activity-compaction-item"),
            kind: "context-compaction",
            summary: "Context compacted",
            tone: "info",
            turnId: null,
            payload: { itemType: "context_compaction" },
            createdAt: isoAt(55),
          },
          {
            id: EventId.makeUnsafe("activity-context-window-updated"),
            kind: "context-window.updated",
            summary: "Context window updated",
            tone: "info",
            turnId: null,
            payload: {
              context: {
                usedTokens: 152_400,
                maxTokens: 200_000,
                usedPercent: 76.2,
                measurement: "provider-reported",
                confidence: "exact",
              },
              cumulative: { totalProcessedTokens: 415_000 },
            },
            createdAt: isoAt(60),
          },
          {
            id: EventId.makeUnsafe("activity-compaction-runtime-status"),
            kind: THREAD_COMPACTION_RUNTIME_STATUS_ACTIVITY_KIND,
            summary: "Compaction runtime status updated",
            tone: "info",
            // Turn-stamped with a non-visible turn so the status feeds the meter
            // without adding a raw work-log row to the timeline.
            turnId: "turn-status" as TurnId,
            payload: {
              owner: "synara",
              providerAutoEnabled: false,
              manualAvailability: { available: true },
              trigger: { kind: "percent", percent: 85 },
              phase: { status: "idle" },
            },
            createdAt: isoAt(61),
          },
        ],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function createComposerCapabilities() {
  return {
    provider: "codex",
    supportsSkillMentions: false,
    supportsSkillDiscovery: false,
    supportsNativeSlashCommandDiscovery: false,
    supportsPluginMentions: false,
    supportsPluginDiscovery: false,
    supportsRuntimeModelList: false,
    compaction: {
      manual: {
        mode: "same-session",
        mechanism: "native-rpc",
        supportsInstructions: false,
      },
      automatic: {
        mode: "none",
        statusVisibility: "partial",
        triggerVisibility: "derived",
      },
      telemetry: {
        lifecycle: "native",
        contextUsage: "exact",
      },
    },
    supportsThreadCompaction: true,
  };
}

function resolveWsRpc(body: { _tag: string; [key: string]: unknown }): unknown {
  const tag = body._tag;
  if (tag === ORCHESTRATION_WS_METHODS.getShellSnapshot) {
    return createShellSnapshotFromReadModel(fixture.snapshot);
  }
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
    return { sequence: fixture.snapshot.snapshotSequence + 1 };
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.providerGetComposerCapabilities) {
    return createComposerCapabilities();
  }
  if (tag === WS_METHODS.projectsListDevServers) {
    return { servers: [] };
  }
  if (tag === WS_METHODS.automationList) {
    return { definitions: [], runs: [] };
  }
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      hasOriginRemote: true,
      branches: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return { entries: [], truncated: false };
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      const parsed = readEffectRpcClientMessage(client, rawData);
      if (parsed.kind !== "request") return;

      const requestBody = flattenEffectRpcRequestPayload(
        parsed.request.tag,
        parsed.request.tag === ORCHESTRATION_WS_METHODS.dispatchCommand
          ? { command: parsed.request.payload }
          : parsed.request.payload,
      );
      const method = requestBody._tag;

      if (method === WS_METHODS.subscribeServerLifecycle) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "welcome",
          payload: fixture.welcome,
        });
        return;
      }
      if (method === WS_METHODS.subscribeServerConfig) {
        sendEffectRpcChunk(client, parsed.request.id, {
          type: "snapshot",
          config: fixture.serverConfig,
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeShell) {
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: createShellSnapshotFromReadModel(fixture.snapshot),
        });
        return;
      }
      if (method === ORCHESTRATION_WS_METHODS.subscribeThread && "threadId" in requestBody) {
        const thread = fixture.snapshot.threads.find((entry) => entry.id === requestBody.threadId);
        if (!thread) return;
        sendEffectRpcChunk(client, parsed.request.id, {
          kind: "snapshot",
          snapshot: { snapshotSequence: fixture.snapshot.snapshotSequence, thread },
        });
        return;
      }
      if (
        method === WS_METHODS.subscribeServerProviderStatuses ||
        method === WS_METHODS.subscribeServerSettings ||
        method === WS_METHODS.subscribeTerminalEvents ||
        method === WS_METHODS.subscribeOrchestrationDomainEvents ||
        method === WS_METHODS.subscribeProjectDevServerEvents ||
        method === WS_METHODS.subscribeAutomationEvents
      ) {
        return;
      }
      sendEffectRpcExit(client, parsed.request.id, resolveWsRpc(requestBody));
    });
  }),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    { timeout: 4_000, interval: 16 },
  );
}

let frameIndex = 0;

async function capture(name: string, options?: { frame?: boolean }): Promise<void> {
  await waitForLayout();
  await page.screenshot({ path: `${OUTPUT_DIR}/${name}.png` });
  if (options?.frame !== false) {
    frameIndex += 1;
    await page.screenshot({
      path: `${OUTPUT_DIR}/frames/frame-${String(frameIndex).padStart(2, "0")}.png`,
    });
  }
}

describe("Context compaction full-app media", () => {
  beforeAll(async () => {
    fixture = {
      snapshot: createCompactionSnapshot(),
      serverConfig: createBrowserTestServerConfig(NOW_ISO),
      welcome: {
        cwd: "/repo/storefront",
        projectName: "Storefront",
        bootstrapProjectId: PROJECT_ID,
        bootstrapThreadId: THREAD_ID,
      },
    };
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: { url: "/mockServiceWorker.js" },
    });
  });

  afterAll(async () => {
    await resetWsNativeApiForTest();
    await worker.stop();
  });

  beforeEach(async () => {
    await resetWsNativeApiForTest();
    resetRetainedThreadDetailSubscriptionsForTests();
    localStorage.clear();
    useLatestProjectStore.setState({ latestProjectId: null });
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useStore.setState({
      projects: [],
      threadIds: [],
      threadShellById: {},
      threadSessionById: {},
      threadTurnStateById: {},
      messageIdsByThreadId: {},
      messageByThreadId: {},
      activityIdsByThreadId: {},
      activityByThreadId: {},
      proposedPlanIdsByThreadId: {},
      proposedPlanByThreadId: {},
      turnDiffIdsByThreadId: {},
      turnDiffSummaryByThreadId: {},
      sidebarThreadSummaryById: {},
      threadsHydrated: false,
    });
  });

  afterEach(() => {
    resetRetainedThreadDetailSubscriptionsForTests();
    document.body.innerHTML = "";
  });

  it("captures full-app compaction screenshots", async () => {
    await page.viewport(1_440, 900);
    await waitForProductionStyles();

    const host = createFullscreenTestHost();
    const router = getRouter(createMemoryHistory({ initialEntries: [`/${THREAD_ID}`] }));
    const screen = await render(<RouterProvider router={router} />, { container: host });

    try {
      // Full app hydrated: sidebar, chat timeline with the compaction entry,
      // composer with the context-window meter.
      await vi.waitFor(
        () => {
          expect(host.querySelector("[data-chat-composer-form='true']")).toBeTruthy();
          expect(document.body.textContent).toContain("Context compacted");
          expect(document.querySelector('button[aria-label^="Context window"]')).toBeTruthy();
        },
        { timeout: 20_000, interval: 32 },
      );
      await waitForLayout();
      await capture("01-full-app-timeline-compaction");

      // Meter popover with usage, Synara auto-compaction status, and settings.
      const meterTrigger = document.querySelector<HTMLButtonElement>(
        'button[aria-label^="Context window"]',
      )!;
      await userEvent.click(meterTrigger);
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Synara will compact automatically");
        },
        { timeout: 8_000, interval: 32 },
      );
      await capture("02-meter-popover");

      // Expand the Synara-managed auto-compaction settings inside the popover.
      const settingsToggle = Array.from(
        document.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent?.includes("Compaction settings"));
      expect(settingsToggle).toBeTruthy();
      await userEvent.click(settingsToggle!);
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("Threshold (% used)");
        },
        { timeout: 8_000, interval: 32 },
      );
      await capture("03-meter-popover-settings");

      // Close the popover before driving the composer.
      await userEvent.keyboard("{Escape}");
      await waitForLayout();

      // /compact slash suggestion in the composer command menu.
      const editor = document.querySelector<HTMLElement>('[contenteditable="true"]');
      expect(editor).toBeTruthy();
      await userEvent.click(editor!);
      await userEvent.keyboard("/compact");
      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Compact the current thread context to free space",
          );
        },
        { timeout: 8_000, interval: 32 },
      );
      await capture("04-composer-compact-slash");
    } finally {
      await screen.unmount();
      if (host.isConnected) host.remove();
    }
  }, 120_000);
});
