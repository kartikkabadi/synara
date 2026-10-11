import { createHash } from "node:crypto";
import {
  fchmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, parse } from "node:path";
import { Schema } from "effect";

import { RemoteAgentEventEnvelope } from "@synara/contracts/remoteAgent";
import type { JournalEntry } from "./types";

export const MAX_FRAME_BYTES = 1024 * 1024;
export const defaultJournalDir = (): string =>
  process.env.SYNARA_AGENT_JOURNAL_DIR ?? join(homedir(), ".synara-agent");
export const endpointHash = (id: string): string => createHash("sha256").update(id).digest("hex");

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export function ensurePrivateDirectory(path: string): void {
  // Validate existing ancestors too: a private leaf beneath a replaced link is
  // not a private namespace. System temp directories are realpathed by caller.
  let ancestor = resolve(path);
  const root = parse(ancestor).root;
  while (ancestor !== root) {
    try {
      if (lstatSync(ancestor).isSymbolicLink())
        throw new Error(`Symlink in remote-agent directory: ${ancestor}`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    ancestor = dirname(ancestor);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
      throw new Error(`Unsafe remote-agent directory: ${path}`);
    }
    fchmodSync(fd, 0o700);
  } finally {
    closeSync(fd);
  }
}

export function openPrivateFile(path: string, flags: number, allowLegacyReadable = false): number {
  const fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  const stat = fstatSync(fd);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid?.() ||
    stat.nlink !== 1 ||
    (stat.mode & (allowLegacyReadable ? 0o022 : 0o077)) !== 0
  ) {
    closeSync(fd);
    throw new Error(`Unsafe remote-agent file: ${path}`);
  }
  if (allowLegacyReadable) {
    try {
      fchmodSync(fd, 0o600);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  return fd;
}

// Journal iteration is bounded even when a provider has been disconnected for days.
export class AgentJournal {
  constructor(private readonly directory: string) {
    ensurePrivateDirectory(directory);
  }

  private path(threadId: string): string {
    // Keep safely named journals from the original stdio agent readable.
    if (!threadId.startsWith("sha256-") && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(threadId)) {
      const legacy = join(this.directory, `${threadId}.journal`);
      try {
        const fd = openPrivateFile(legacy, constants.O_RDONLY, true);
        closeSync(fd);
        return legacy;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    return join(this.directory, `sha256-${endpointHash(threadId)}.journal`);
  }

  append(threadId: string, entry: JournalEntry): void {
    const fd = openPrivateFile(
      this.path(threadId),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
    );
    try {
      const data = Buffer.from(`${JSON.stringify({ threadId, ...entry })}\n`);
      let offset = 0;
      while (offset < data.length) offset += writeSync(fd, data, offset);
    } finally {
      closeSync(fd);
    }
  }

  *read(threadId: string): Generator<JournalEntry> {
    for (const entry of this.readFile(this.path(threadId), threadId)) {
      if (entry.threadId !== threadId) throw new Error("Journal thread identity mismatch");
      yield entry;
    }
  }

  *threadIds(): Generator<string> {
    for (const file of readdirSync(this.directory)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.journal$/.test(file)) continue;
      const legacyId = file.slice(0, -".journal".length);
      const entries = this.readFile(join(this.directory, file), legacyId);
      const first = entries.next();
      entries.return(undefined);
      if (!first.done) yield first.value.threadId;
    }
  }

  private *readFile(
    path: string,
    fallbackThreadId: string,
  ): Generator<JournalEntry & { threadId: string }> {
    let fd: number;
    try {
      // Upgrade safe legacy permissions on the verified descriptor, never a path.
      fd = openPrivateFile(path, constants.O_RDONLY, true);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    let pending = Buffer.alloc(0);
    let lastSeq = 0;
    const chunk = Buffer.alloc(64 * 1024);
    try {
      for (;;) {
        const count = readSync(fd, chunk);
        if (count === 0) break;
        pending = Buffer.concat([pending, chunk.subarray(0, count)]);
        let newline = pending.indexOf(10);
        while (newline !== -1) {
          if (newline > MAX_FRAME_BYTES) throw new Error("Journal frame exceeds size limit");
          const raw: unknown = JSON.parse(pending.subarray(0, newline).toString("utf8"));
          const entry = Schema.decodeUnknownSync(RemoteAgentEventEnvelope)({
            threadId: fallbackThreadId,
            ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(raw),
          });
          if (entry.seq <= lastSeq) throw new Error("Journal sequence is not increasing");
          lastSeq = entry.seq;
          yield entry;
          pending = pending.subarray(newline + 1);
          newline = pending.indexOf(10);
        }
        if (pending.length > MAX_FRAME_BYTES) throw new Error("Journal frame exceeds size limit");
      }
      if (pending.length > 0) throw new Error("Journal has an incomplete final frame");
    } finally {
      closeSync(fd);
    }
  }
}
