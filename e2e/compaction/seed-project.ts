import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { NativeApi } from "../../packages/contracts/src/ipc";
import type { CompactionCase } from "./config";

/** Set up through the same command API used by the current app, after server readiness. */
export async function createTestThread(
  page: Page,
  spec: CompactionCase,
  workspaceRoot: string,
): Promise<string> {
  const projectId = randomUUID();
  const threadId = randomUUID();
  await page.evaluate(
    async ({ spec, workspaceRoot, projectId, threadId }) => {
      const modulePath = "/src/nativeApi.ts";
      const { ensureNativeApi } = (await import(/* @vite-ignore */ modulePath)) as {
        ensureNativeApi: () => NativeApi;
      };
      const api = ensureNativeApi();
      const models = await api.provider.listModels({
        provider: spec.provider,
        cwd: workspaceRoot,
        ...(spec.instanceId ? { instanceId: spec.instanceId as never } : {}),
      });
      if (models.error || !models.models.some((model) => model.slug === spec.model)) {
        throw new Error(
          "Configured model is not available in the current provider catalog. No fallback is allowed.",
        );
      }
      const modelSelection = {
        provider: spec.provider,
        model: spec.model,
        instanceId: spec.instanceId ?? spec.provider,
      };
      const createdAt = new Date().toISOString();
      await api.orchestration.dispatchCommand({
        type: "project.create",
        commandId: crypto.randomUUID(),
        projectId,
        title: "Compaction test",
        workspaceRoot,
        defaultModelSelection: modelSelection,
        createdAt,
      } as Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0]);
      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: crypto.randomUUID(),
        threadId,
        projectId,
        title: `Compaction: ${spec.provider}`,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      } as Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0]);
    },
    { spec, workspaceRoot, projectId, threadId },
  );
  return threadId;
}
