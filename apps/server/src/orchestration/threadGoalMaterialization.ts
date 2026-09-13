// FILE: threadGoalMaterialization.ts
// Purpose: Codex-style large-goal handling. A goal longer than the inline
//   threshold would blow up every provider turn (the persisted goal is injected
//   into each prompt), so the full text is materialized to a per-thread file and
//   the stored goal becomes a short "read this file" reference that stays
//   resolvable on every subsequent turn.
// Layer: Orchestration command normalization
// Depends on: contracts thresholds, private path permission helpers.

import fs from "node:fs/promises";
import path from "node:path";

import { THREAD_GOAL_INLINE_MAX_CHARS } from "@synara/contracts";

import { ensurePrivateDirectorySync, repairPrivateFile } from "../privatePathPermissions";

export function isOversizedThreadGoal(goal: string | undefined): goal is string {
  return typeof goal === "string" && goal.length > THREAD_GOAL_INLINE_MAX_CHARS;
}

// Thread ids are server-minted identifier strings; sanitize anyway because the
// id flows straight into a filesystem path.
function threadGoalFilePath(stateDir: string, threadId: string): string {
  const safeThreadId = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(stateDir, "thread-goals", safeThreadId, "goal.md");
}

/** The persisted goal text once the full objective lives on disk. */
export function threadGoalFileReference(filePath: string): string {
  return `Read this file: ${filePath}`;
}

/**
 * Writes the oversized goal to `<stateDir>/thread-goals/<threadId>/goal.md`
 * (overwritten on each update so the reference always points at the latest
 * objective) and returns the path to embed in the stored goal.
 */
export async function materializeThreadGoalFile(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly goal: string;
}): Promise<string> {
  const filePath = threadGoalFilePath(input.stateDir, input.threadId);
  ensurePrivateDirectorySync(path.dirname(filePath));
  await fs.writeFile(filePath, input.goal, "utf8");
  await repairPrivateFile(filePath);
  return filePath;
}
