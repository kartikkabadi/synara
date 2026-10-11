import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  ProviderKind,
  type OrchestrationThread,
} from "../../../packages/contracts/src/orchestration";
import type { NativeApi } from "../../../packages/contracts/src/ipc";
import { parseCases, requiredRunPath } from "../config";
import { createTestThread } from "../seed-project";

const cases = parseCases(process.env.SYNARA_E2E_CASES, ProviderKind.literals);
const workspaceRoot = requiredRunPath(
  process.env.SYNARA_E2E_WORKSPACE_ROOT,
  "SYNARA_E2E_WORKSPACE_ROOT",
);

async function readThread(page: Page, threadId: string): Promise<OrchestrationThread> {
  return page.evaluate(async (id) => {
    const modulePath = "/src/nativeApi.ts";
    const { ensureNativeApi } = (await import(/* @vite-ignore */ modulePath)) as {
      ensureNativeApi: () => NativeApi;
    };
    const snapshot = await ensureNativeApi().orchestration.getThreadDetailSnapshot({
      threadId: id as never,
    });
    if (!snapshot) throw new Error("Test thread was not found.");
    return snapshot.thread;
  }, threadId);
}

function assertHealthy(thread: OrchestrationThread): void {
  if (
    thread.session?.lastError ||
    thread.latestTurn?.state === "error" ||
    thread.latestTurn?.state === "interrupted"
  ) {
    throw new Error(
      "The test thread failed or was interrupted; inspect the retained isolated run.",
    );
  }
  if (thread.hasPendingApprovals || thread.hasPendingUserInput || thread.claudeCacheReview) {
    throw new Error(
      "Provider requires operator input; the harness does not approve tools or bypass cache review.",
    );
  }
}

function composer(page: Page) {
  return page.locator('[data-chat-composer-form="true"] [contenteditable="true"]');
}

async function sendAndObserveReply(page: Page, threadId: string): Promise<void> {
  const before = await readThread(page, threadId);
  const beforeIds = new Set(before.messages.map((message) => message.id));
  const marker = `compaction-proof-${randomUUID()}`;
  await expect(composer(page)).toHaveCount(1);
  await composer(page).fill(`Reply with exactly ${marker}. Do not use tools.`);
  await composer(page).press("Enter");
  let assistantId: string | undefined;
  await expect
    .poll(
      async () => {
        const thread = await readThread(page, threadId);
        assertHealthy(thread);
        const freshUser = thread.messages.find(
          (message) =>
            !beforeIds.has(message.id) && message.role === "user" && message.text.includes(marker),
        );
        const reply = thread.messages.find(
          (message) =>
            !beforeIds.has(message.id) &&
            message.role === "assistant" &&
            !message.streaming &&
            message.text.includes(marker) &&
            message.turnId === freshUser?.turnId,
        );
        assistantId = reply?.id;
        return Boolean(
          freshUser?.turnId &&
          reply &&
          thread.latestTurn?.turnId === freshUser.turnId &&
          thread.latestTurn.state === "completed" &&
          !thread.session?.activeTurnId,
        );
      },
      {
        timeout: 180_000,
        message: "A fresh assistant reply and its completed turn must follow this exact prompt.",
      },
    )
    .toBe(true);
  await expect(
    page.locator(`[data-message-id="${assistantId}"][data-message-role="assistant"]`),
  ).toContainText(marker);
}

async function openMeter(page: Page): Promise<void> {
  const meter = page.getByRole("button", { name: /^Context window / });
  await expect(meter).toHaveCount(1);
  await meter.hover();
  await expect(page.getByText("Context window", { exact: true })).toBeVisible();
}

for (const spec of cases) {
  test(`${spec.provider} / ${spec.model}: ${spec.compaction}`, async ({ page }, testInfo) => {
    await page.goto("/");
    const threadId = await createTestThread(page, spec, workspaceRoot);
    await page.goto(`/${threadId}`);
    await sendAndObserveReply(page, threadId);
    const before = await readThread(page, threadId);
    expect(before.modelSelection.provider).toBe(spec.provider);
    expect(before.modelSelection.model).toBe(spec.model);
    const beforeActivityIds = new Set(before.activities.map((activity) => activity.id));
    await openMeter(page);

    if (spec.compaction === "unavailable") {
      await expect(
        page.getByText("Compaction unavailable for this provider.", { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Compact now", exact: true })).toHaveCount(0);
      await composer(page).fill("/compact");
      await expect(page.getByRole("option", { name: /compact/i })).toHaveCount(0);
      await composer(page).fill("");
      return;
    }

    // Claude's button uses its native durable /compact turn; other providers use their RPC.
    const compact = page.getByRole("button", { name: "Compact now", exact: true });
    await expect(compact).toBeEnabled({ timeout: 30_000 });
    await compact.click();
    let completionId: string | undefined;
    await expect
      .poll(
        async () => {
          const thread = await readThread(page, threadId);
          assertHealthy(thread);
          const fresh = thread.activities.filter((activity) => !beforeActivityIds.has(activity.id));
          if (
            fresh.some(
              (activity) =>
                activity.kind === "thread.compaction-failed" ||
                activity.kind === "thread.compaction-suspended" ||
                (activity.kind === "context-compaction" && activity.tone === "error"),
            )
          ) {
            throw new Error("Fresh compaction failure recorded.");
          }
          const completed = fresh.find((activity) => {
            if (activity.kind === "thread.compaction-completed") return true;
            const payload = activity.payload as Record<string, unknown> | null;
            return (
              activity.kind === "context-compaction" &&
              (payload?.state === "compacted" || payload?.status === "completed")
            );
          });
          completionId = completed?.id;
          return Boolean(
            completed && !thread.session?.activeTurnId && thread.latestTurn?.state !== "running",
          );
        },
        {
          timeout: 180_000,
          message:
            "A fresh durable completed compaction event is required; meter visibility is not proof.",
        },
      )
      .toBe(true);
    await testInfo.attach("compaction-evidence", {
      body: JSON.stringify({ provider: spec.provider, model: spec.model, threadId, completionId }),
      contentType: "application/json",
    });
    await page.keyboard.press("Escape");
    await sendAndObserveReply(page, threadId);
  });
}
