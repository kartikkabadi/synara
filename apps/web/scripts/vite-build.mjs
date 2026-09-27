// Runs `vite build` with a raised V8 heap limit. The production bundle OOMs
// under Node's default old-space size, so append --max-old-space-size unless
// the caller already set one via NODE_OPTIONS.
import { spawnSync } from "node:child_process";
import { withHeapLimit } from "./buildNodeOptions.mjs";

const nodeOptions = withHeapLimit(process.env.NODE_OPTIONS ?? "", 6144);

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
