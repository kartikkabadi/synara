import { resolveExecutable } from "@synara/shared/executable";
import { spawnProcessSync } from "@synara/shared/processRuntime";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withHeapLimit } from "./buildNodeOptions";

const node = resolveExecutable("node");
if (!node) throw new Error("Node.js is required to build the web app.");
const vite = join(dirname(fileURLToPath(import.meta.resolve("vite/package.json"))), "bin/vite.js");
const result = spawnProcessSync(node, [vite, "build", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: withHeapLimit(process.env.NODE_OPTIONS ?? "", 6144) },
});
if (result.error) console.error(result.error);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
