import {
  constants,
  fstatSync,
  closeSync,
  openSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentJournal, ensurePrivateDirectory, openPrivateFile } from "./storage";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "synara-journal-boundary-")));
  roots.push(root);
  return root;
}
describe.skipIf(process.platform === "win32")("private journal descriptors", () => {
  it("upgrades a safe legacy journal on its verified descriptor and replays its identity", () => {
    const root = fixture();
    const file = join(root, "thread-legacy.journal");
    writeFileSync(file, JSON.stringify({ seq: 1, kind: "exit", exitCode: 0 }) + "\n");
    chmodSync(file, 0o644);
    expect([...new AgentJournal(root).read("thread-legacy")]).toMatchObject([
      { seq: 1, kind: "exit", exitCode: 0 },
    ]);
    const fd = openPrivateFile(file, constants.O_RDONLY);
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
    } finally {
      closeSync(fd);
    }
  });
  it("refuses journal links and unsafe writable files without changing their permissions", () => {
    const root = fixture();
    const target = join(root, "target");
    writeFileSync(target, "private");
    chmodSync(target, 0o644);
    const soft = join(root, "symlink");
    symlinkSync(target, soft);
    expect(() => openPrivateFile(soft, constants.O_RDONLY, true)).toThrow();
    const hard = join(root, "hardlink");
    linkSync(target, hard);
    expect(() => openPrivateFile(hard, constants.O_RDONLY, true)).toThrow();
    const writable = join(root, "writable");
    writeFileSync(writable, "data");
    chmodSync(writable, 0o666);
    expect(() => openPrivateFile(writable, constants.O_RDONLY, true)).toThrow();
    const fd = openSync(target, constants.O_RDONLY);
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o644);
    } finally {
      closeSync(fd);
    }
  });
  it("refuses a linked private directory", () => {
    const root = fixture();
    const linked = join(root, "linked");
    symlinkSync(root, linked);
    expect(() => ensurePrivateDirectory(linked)).toThrow("Symlink");
  });
});
