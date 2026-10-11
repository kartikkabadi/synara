import { Encoding } from "effect";
import {
  CheckpointRef,
  MessageId,
  ProjectId,
  type ProjectKind,
  type ThreadId,
  TurnId,
} from "@synara/contracts";
import { resolveThreadWorkspaceCwd as resolveSharedThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";

export const CHECKPOINT_REFS_PREFIX = "refs/synara/checkpoints";

export const RESCUE_REFS_PREFIX = "refs/synara-rescue";

const MANAGED_CHECKPOINT_REF_PATTERN =
  /^refs\/([A-Za-z0-9._-]+)\/checkpoints\/([A-Za-z0-9_-]+)\/(turn|message-start|turn-start|turn-live)\/([A-Za-z0-9_-]+)$/;

export interface ManagedCheckpointRefParts {
  readonly namespace: string;
  readonly threadToken: string;
  readonly kind: "turn" | "message-start" | "turn-start" | "turn-live";
  readonly valueToken: string;
  readonly familyPrefix: string;
}

export function parseManagedCheckpointRef(value: string): ManagedCheckpointRefParts | null {
  const match = MANAGED_CHECKPOINT_REF_PATTERN.exec(value);
  if (!match) return null;
  const [, namespace, threadToken, kind, valueToken] = match;
  if (!namespace || !threadToken || !kind || !valueToken) return null;
  if (kind === "turn" && !/^\d+$/.test(valueToken)) return null;
  return {
    namespace,
    threadToken,
    kind: kind as ManagedCheckpointRefParts["kind"],
    valueToken,
    familyPrefix: `refs/${namespace}/checkpoints/${threadToken}`,
  };
}

export function isManagedCheckpointRefForThread(value: string, threadId: ThreadId): boolean {
  const parsed = parseManagedCheckpointRef(value);
  return parsed?.threadToken === Encoding.encodeBase64Url(threadId);
}

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function checkpointRefForThreadTurnInManagedFamily(
  managedRef: string,
  threadId: ThreadId,
  turnCount: number,
): CheckpointRef | null {
  const parsed = parseManagedCheckpointRef(managedRef);
  if (parsed?.threadToken !== Encoding.encodeBase64Url(threadId)) return null;
  return CheckpointRef.makeUnsafe(`${parsed.familyPrefix}/turn/${turnCount}`);
}

export function checkpointRefForThreadMessageStart(
  threadId: ThreadId,
  messageId: MessageId,
): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/message-start/${Encoding.encodeBase64Url(messageId)}`,
  );
}

export function checkpointRefForThreadTurnStart(threadId: ThreadId, turnId: TurnId): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn-start/${Encoding.encodeBase64Url(turnId)}`,
  );
}

export function checkpointRefForThreadTurnStartInManagedFamily(
  managedRef: string,
  threadId: ThreadId,
  turnId: TurnId,
): CheckpointRef | null {
  const parsed = parseManagedCheckpointRef(managedRef);
  if (parsed?.threadToken !== Encoding.encodeBase64Url(threadId)) return null;
  return CheckpointRef.makeUnsafe(
    `${parsed.familyPrefix}/turn-start/${Encoding.encodeBase64Url(turnId)}`,
  );
}

const RESCUE_CHECKPOINT_REF_PATTERN = /^refs\/synara-rescue\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/;

export interface RescueCheckpointRefParts {
  readonly threadToken: string;
  readonly sagaToken: string;
}

// Pre-revert safety snapshot for the checkpoint-revert compensated saga: captured
// before a revert mutates the workspace so a failed/uncertain revert can be
// compensated by restoring the pre-revert workspace state. Keyed by the durable
// saga id so retries of the same saga deterministically target the same ref.
export function rescueCheckpointRefForThreadSaga(
  threadId: ThreadId,
  sagaId: string,
): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${RESCUE_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/${Encoding.encodeBase64Url(sagaId)}`,
  );
}

export function parseRescueCheckpointRef(value: string): RescueCheckpointRefParts | null {
  const match = RESCUE_CHECKPOINT_REF_PATTERN.exec(value);
  if (!match) return null;
  const [, threadToken, sagaToken] = match;
  if (!threadToken || !sagaToken) return null;
  return { threadToken, sagaToken };
}

export function isRescueCheckpointRefForThread(value: string, threadId: ThreadId): boolean {
  return parseRescueCheckpointRef(value)?.threadToken === Encoding.encodeBase64Url(threadId);
}

// Throwaway ref used to snapshot the working tree mid-turn so a live diff can be
// computed against the turn-start baseline. It is captured, diffed, and deleted
// on every live recompute; it never becomes a durable checkpoint.
export function checkpointRefForThreadTurnLive(threadId: ThreadId, turnId: TurnId): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn-live/${Encoding.encodeBase64Url(turnId)}`,
  );
}

/**
 * Decide whether a project's `workspaceRoot` should be treated as a thread's
 * real, usable working directory.
 *
 * - `chat` projects are throwaway sandboxes with no durable working
 *   directory of their own: their `workspaceRoot` is not a real cwd until a
 *   worktree has actually been materialized for the thread, so it must be
 *   suppressed (treated as absent) until then.
 * - `studio` projects always have a real, durable cwd (the Studio root), so
 *   their `workspaceRoot` is used as-is, exactly like every other kind.
 * - Every other kind (including the default `project` kind, and an
 *   unresolved/undefined project) treats `workspaceRoot` as the real cwd.
 */
export function resolveProjectCwdForKind(input: {
  readonly kind: ProjectKind | string | null | undefined;
  readonly workspaceRoot: string | null;
  readonly worktreePath: string | null | undefined;
}): string | null {
  if (input.kind === "chat" && !input.worktreePath) {
    return null;
  }
  return input.workspaceRoot;
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly envMode?: "local" | "worktree" | undefined;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly kind?: ProjectKind | undefined;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const project = input.projects.find((entry) => entry.id === input.thread.projectId);
  const projectCwd = resolveProjectCwdForKind({
    kind: project?.kind,
    workspaceRoot: project?.workspaceRoot ?? null,
    worktreePath: input.thread.worktreePath,
  });
  return (
    resolveSharedThreadWorkspaceCwd({
      projectCwd,
      envMode: input.thread.envMode,
      worktreePath: input.thread.worktreePath,
    }) ?? undefined
  );
}
