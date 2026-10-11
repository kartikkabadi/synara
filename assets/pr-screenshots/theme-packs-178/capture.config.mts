import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../../apps/web/vitest.browser.config";

const webRoot = fileURLToPath(new URL("../../../apps/web/", import.meta.url));
const captureDirectory = fileURLToPath(new URL(".", import.meta.url));

export default mergeConfig(
  base,
  defineConfig({
    root: webRoot,
    test: { testNamePattern: "preserves window controls" },
    plugins: [
      {
        name: "capture-actual-theme-controls",
        enforce: "pre",
        transform(code, id) {
          if (!id.split("?")[0]?.endsWith("/src/components/ThemePackEditor.browser.tsx")) return;
          if (
            !code.includes("page.viewport(1120, 1000)") ||
            !code.includes("await presetButton.click();")
          ) {
            throw new Error(
              "Theme capture fixture changed; update the reviewed capture procedure.",
            );
          }
          const before = `    if (label === "Parthenon") await page.screenshot({ path: ${JSON.stringify(resolve(captureDirectory, "before.png"))} });`;
          const after = `    await vi.waitFor(() => expect(document.getAnimations().every(animation => animation.playState !== "running")).toBe(true));
    await document.fonts.ready;
    await page.screenshot({ path: ${JSON.stringify(captureDirectory)} + (label === "Parthenon" ? "/parthenon.png" : "/attic-valley.png") });`;
          return {
            code: code
              .replace("page.viewport(1120, 1000)", "page.viewport(1120, 1200)")
              .replace(
                "await presetButton.click();",
                `${before}\n    await presetButton.click();\n${after}`,
              ),
            map: null,
          };
        },
      },
    ],
  }),
);
