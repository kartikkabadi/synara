import * as path from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      setupFiles: [path.resolve(import.meta.dirname, "../../vitest.setup.ts")],
    },
  }),
);
