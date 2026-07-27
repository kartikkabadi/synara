// Runs `vite build` with a raised V8 heap limit. The production bundle OOMs
// under Node's default old-space size, so append --max-old-space-size unless
// the caller already set one via NODE_OPTIONS.
import { spawnSync } from "node:child_process";

const existing = process.env.NODE_OPTIONS ?? "";
const nodeOptions = existing.includes("--max-old-space-size")
  ? existing
  : `${existing} --max-old-space-size=6144`.trim();

const result = spawnSync("vite", ["build"], {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  // Windows needs shell mode to resolve .cmd shims (e.g. vite.cmd).
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(result.error);
}
process.exit(result.status ?? 1);
