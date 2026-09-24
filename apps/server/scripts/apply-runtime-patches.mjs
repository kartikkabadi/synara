#!/usr/bin/env node
// Applies the repo's runtime dependency patches inside an installed tarball.
// The staged package pins every patched dep to the exact version the patch was
// written for, so an anchor mismatch means upstream re-published an immutable
// version — fail loudly instead of silently shipping unpatched code.
//
// Minimal unified-diff applier: parses `diff --git`/`@@` hunks and applies them
// with context matching (exact at the hinted line first, then a small offset
// search). All-or-nothing per file. Patch filenames follow bun's convention
// (`<pkg>@<version>.patch`, scope separator `%2F`); the target package is
// derived from the filename, and hunk paths are relative to that package's
// root inside node_modules. Files absent from the published package (e.g.
// unshipped src/) are skipped; a missing package fails loudly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patchesDir = path.join(root, "patches");

function fail(message) {
  console.error(`apply-runtime-patches: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(patchesDir)) {
  console.warn("apply-runtime-patches: no patches directory — nothing to do.");
  process.exit(0);
}

/** Split a unified diff into per-file sections. */
function parsePatchFile(text) {
  const files = [];
  const lines = text.split("\n");
  let current = null;
  for (const line of lines) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) {
      current = { file: m[2], hunks: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      current.hunks.push({ oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] });
      continue;
    }
    if (current.hunks.length === 0) continue;
    const hunk = current.hunks[current.hunks.length - 1];
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    const tag = line[0];
    if (tag === " " || tag === "+" || tag === "-") {
      hunk.lines.push({ tag, text: line.slice(1) });
    }
  }
  return files;
}

/** Apply one file's hunks; returns patched lines or null when anchors miss. */
function applyHunks(sourceLines, hunks) {
  const out = [...sourceLines];
  let shift = 0;
  for (const hunk of hunks) {
    const removed = hunk.lines.filter((l) => l.tag !== "+").map((l) => l.text);
    const added = hunk.lines.filter((l) => l.tag !== "-").map((l) => l.text);
    const hint = hunk.oldStart - 1 + shift;
    let at = -1;
    // Exact position first, then ±40 lines of drift (context lines may not
    // survive tarball minification differences across republishes).
    for (let offset = 0; offset <= 40 && at === -1; offset += 1) {
      for (const pos of offset === 0 ? [hint] : [hint - offset, hint + offset]) {
        if (pos < 0 || pos + removed.length > out.length) continue;
        let matches = true;
        for (let i = 0; i < removed.length; i += 1) {
          if (out[pos + i] !== removed[i]) {
            matches = false;
            break;
          }
        }
        if (matches) at = pos;
      }
    }
    if (at === -1) return null;
    out.splice(at, removed.length, ...added);
    shift += added.length - removed.length;
  }
  return out;
}

let applied = 0;
let skipped = 0;
const failures = [];

for (const name of fs
  .readdirSync(patchesDir)
  .filter((f) => f.endsWith(".patch"))
  .toSorted()) {
  const patchPath = path.join(patchesDir, name);
  // bun patch convention: `@scope%2Fname@ver.patch` / `name@ver.patch` — the
  // hunk paths are relative to that package's root.
  const base = name.slice(0, -".patch".length).replace(/%2F/g, "/");
  const at = base.lastIndexOf("@");
  const pkgName = at > 0 ? base.slice(0, at) : base;
  const pkgDir = path.join(root, "node_modules", pkgName);
  if (!fs.existsSync(pkgDir)) {
    failures.push(`${name}: node_modules/${pkgName} not installed — nothing to patch`);
    break;
  }
  const sections = parsePatchFile(fs.readFileSync(patchPath, "utf8"));
  let fileFailed = false;
  for (const section of sections) {
    const target = path.join(pkgDir, section.file);
    if (!fs.existsSync(target)) {
      // Patch may cover files the published package doesn't ship — fine.
      continue;
    }
    const source = fs.readFileSync(target, "utf8").split("\n");
    // Idempotent: already applied when every hunk's added block appears
    // contiguously near its expected position in the file.
    const blockPresent = (hunk) => {
      const added = hunk.lines.filter((l) => l.tag !== "-").map((l) => l.text);
      if (added.length === 0) return true;
      const hint = hunk.newStart - 1;
      for (let offset = -40; offset <= 40; offset += 1) {
        const pos = hint + offset;
        if (pos < 0 || pos + added.length > source.length) continue;
        if (added.every((line, i) => source[pos + i] === line)) return true;
      }
      return false;
    };
    if (section.hunks.every(blockPresent)) {
      skipped += 1;
      continue;
    }
    const patched = applyHunks(source, section.hunks);
    if (patched === null) {
      failures.push(`${name}: ${section.file} — patch context did not match`);
      fileFailed = true;
      break;
    }
    fs.writeFileSync(target, `${patched.join("\n")}`);
    applied += 1;
  }
  if (fileFailed) break;
}

if (failures.length > 0) {
  fail(`could not apply runtime patches:\n  ${failures.join("\n  ")}`);
}
console.log(
  `apply-runtime-patches: applied ${applied} file patch(es), ${skipped} already up to date.`,
);
