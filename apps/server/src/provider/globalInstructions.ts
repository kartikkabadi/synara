import { FileSystem, Effect, Path } from "effect";

import { ServerConfig } from "../config";

export const GLOBAL_INSTRUCTIONS_FILE_NAME = "SYNARA.md";
export const GLOBAL_INSTRUCTIONS_MAX_CHARS = 6_000;

interface CachedInstructions {
  readonly mtimeMs: number;
  readonly size: number;
  readonly text: string;
}

export function formatGlobalInstructionsPrompt(text: string): string {
  return [
    "<synara_global_instructions>",
    "The following is user-authored durable guidance for this Synara session.",
    "Follow it when consistent with the user's request, provider capabilities, and higher-priority safety or system rules.",
    text,
    "</synara_global_instructions>",
  ].join("\n");
}

export function normalizeGlobalInstructions(text: string): string {
  return text.trim().slice(0, GLOBAL_INSTRUCTIONS_MAX_CHARS);
}

export const loadGlobalInstructions = Effect.fn("loadGlobalInstructions")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const filePath = path.join(config.homeDir, GLOBAL_INSTRUCTIONS_FILE_NAME);
  const cached = cache.get(filePath);
  const stat = yield* fileSystem.stat(filePath).pipe(Effect.option);

  if (stat._tag === "None") {
    cache.delete(filePath);
    return null;
  }

  const mtimeMs = stat.value.mtime?.getTime() ?? 0;
  const size = Number(stat.value.size);
  if (cached?.mtimeMs === mtimeMs && cached.size === size) {
    return cached.text || null;
  }

  const text = yield* fileSystem.readFileString(filePath).pipe(
    Effect.map(normalizeGlobalInstructions),
    Effect.catch(() => Effect.succeed("")),
  );
  cache.set(filePath, { mtimeMs, size, text });
  return text || null;
});

const cache = new Map<string, CachedInstructions>();
