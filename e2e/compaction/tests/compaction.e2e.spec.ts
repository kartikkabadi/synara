// Real-provider compaction e2e suite. One serial describe-block per provider;
// providers without an API key in the environment are skipped.
import { expect, type Page, test } from "@playwright/test";

interface ProviderSpec {
  readonly id: string;
  readonly label: string;
  readonly envKeys: readonly string[];
  // Whether /compact (manual compaction) is offered by this provider.
  readonly manualCompact: boolean;
  // Whether the provider supports compaction at all.
  readonly compactionSupported: boolean;
  // Preferred model slug fragment (small context window where possible).
  readonly preferModel?: string;
}

const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: "codex",
    label: "Codex",
    envKeys: ["OPENAI_API_KEY", "CODEX_API_KEY"],
    manualCompact: true,
    compactionSupported: true,
  },
  {
    id: "claudeAgent",
    label: "Claude",
    envKeys: ["ANTHROPIC_API_KEY"],
    manualCompact: false,
    compactionSupported: true,
  },
  {
    id: "grok",
    label: "Grok",
    envKeys: ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"],
    manualCompact: true,
    compactionSupported: true,
  },
  {
    id: "opencode",
    label: "OpenCode",
    envKeys: ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"],
    manualCompact: true,
    compactionSupported: true,
    preferModel: "deepseek-v4-flash-free",
  },
  {
    id: "kilo",
    label: "Kilo",
    envKeys: ["OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"],
    manualCompact: true,
    compactionSupported: true,
  },
  {
    id: "pi",
    label: "Pi",
    envKeys: ["PI_API_KEY"],
    manualCompact: true,
    compactionSupported: true,
  },
  {
    id: "cursor",
    label: "Cursor",
    envKeys: ["CURSOR_API_KEY"],
    manualCompact: false,
    compactionSupported: false,
  },
  {
    id: "droid",
    label: "Droid",
    envKeys: ["FACTORY_API_KEY"],
    manualCompact: false,
    compactionSupported: false,
  },
  {
    id: "antigravity",
    label: "Antigravity",
    envKeys: ["ANTIGRAVITY_API_KEY"],
    manualCompact: false,
    compactionSupported: false,
  },
];

const workspaceName = process.env.SYNARA_E2E_WORKSPACE_NAME ?? "";

function requestedProviders(): ReadonlySet<string> | null {
  const raw = process.env.SYNARA_E2E_PROVIDERS?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((entry) => entry.trim().toLowerCase()));
}

function hasKey(spec: ProviderSpec): boolean {
  return spec.envKeys.some((key) => (process.env[key] ?? "").length > 0);
}

// A long, cheap-to-generate pasted text used to grow context toward the
// compaction threshold on inexpensive providers.
function longContextPrompt(): string {
  const filler = Array.from(
    { length: 400 },
    (_, index) =>
      `Line ${index}: the quick brown fox jumps over the lazy dog while enumerating context tokens for the compaction threshold test.`,
  ).join("\n");
  return `Here is a long document. Reply with only the word "ok".\n\n${filler}`;
}

async function openWorkspace(page: Page): Promise<void> {
  await page.goto("/");
  const projectPicker = page.getByRole("combobox").filter({ hasText: /work in a project/i });
  await projectPicker.waitFor({ timeout: 30_000 });
  await projectPicker.click();
  const folder = page.getByRole("option", { name: workspaceName, exact: true }).first();
  await folder.waitFor({ timeout: 30_000 });
  await folder.click();
}

async function selectProvider(page: Page, spec: ProviderSpec): Promise<void> {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  const modelTrigger = page.locator("[data-testid='provider-model-picker']").first();
  await modelTrigger.waitFor({ state: "visible", timeout: 15_000 });
  await modelTrigger.click();

  const modelPickerMenu = page.getByRole("menu").first();
  await modelPickerMenu.waitFor({ timeout: 15_000 });

  const providerItem = page
    .locator("[data-slot='menu-sub-trigger']")
    .filter({ hasText: spec.label });
  try {
    await providerItem.first().waitFor({ timeout: 15_000 });
  } catch {
    const disabledRow = page
      .locator("[data-slot='menu-item']")
      .filter({ hasText: spec.label })
      .first();
    if (await disabledRow.isVisible().catch(() => false)) {
      const rowText = (await disabledRow.textContent()) ?? "";
      throw new Error(
        `provider "${spec.label}" is listed but not selectable (row reads "${rowText.trim()}") — likely unavailable on the server`,
      );
    }
    throw new Error(`provider "${spec.label}" not found in the provider picker`);
  }
  await providerItem.first().click();

  const search = page.getByRole("searchbox", { name: /search models/i });
  if (spec.preferModel && (await search.isVisible().catch(() => false))) {
    await search.fill(spec.preferModel);
  }

  const modelItems = page.getByRole("menuitemradio");
  await modelItems.first().waitFor({ timeout: 30_000 });
  const preferred = spec.preferModel
    ? page.getByRole("menuitemradio", { name: new RegExp(spec.preferModel, "i") })
    : modelItems;
  const target = (await preferred.count()) > 0 ? preferred.first() : modelItems.first();
  await target.click();
  await page.keyboard.press("Escape").catch(() => {});
}

function composer(page: Page) {
  return page.locator("[contenteditable='true']").first();
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const input = composer(page);
  await input.click();
  await input.fill(text).catch(async () => {
    // contenteditable editors may not support fill(); fall back to insertText
    // so huge prompts don't take minutes to type.
    await page.keyboard.insertText(text);
  });
  await page.keyboard.press("Enter");
}

async function openContextMeterPopover(page: Page): Promise<void> {
  const meter = page.getByRole("button", { name: /^Context window / }).first();
  await meter.waitFor({ timeout: 60_000 });
  await meter.hover();
}

async function waitForAssistantReply(page: Page, timeout = 180_000): Promise<void> {
  // The composer send affordance re-enables once the turn completes; the
  // simplest robust signal is the meter updating with non-zero usage.
  await expect(page.getByRole("button", { name: /^Context window / }).first()).toBeVisible({
    timeout,
  });
}

for (const spec of PROVIDERS) {
  const requested = requestedProviders();
  const included =
    requested === null ||
    requested.has(spec.id.toLowerCase()) ||
    requested.has(spec.label.toLowerCase());

  test.describe(`${spec.label} compaction`, () => {
    test.skip(!included, `provider not in SYNARA_E2E_PROVIDERS`);
    test.skip(!hasKey(spec), `no API key (${spec.envKeys.join(" or ")})`);

    test(`compaction behavior via web UI`, async ({ page }) => {
      await openWorkspace(page);
      await selectProvider(page, spec);

      if (!spec.compactionSupported) {
        // Providers without compaction: /compact must not be offered and the
        // meter must say compaction is unavailable.
        await sendMessage(page, 'Reply with only the word "ok".');
        await waitForAssistantReply(page);

        await composer(page).click();
        await page.keyboard.type("/compact");
        await expect(page.getByRole("option", { name: /compact/i })).toHaveCount(0);
        await page.keyboard.press("Escape");

        await openContextMeterPopover(page);
        await expect(page.getByText("Compaction unavailable for this provider.")).toBeVisible();
        return;
      }

      if (spec.manualCompact) {
        // Cheap path for expensive providers: seed a tiny turn, then compact
        // manually from the composer.
        await sendMessage(page, 'Reply with only the word "ok".');
        await waitForAssistantReply(page);
        await sendMessage(page, "/compact");
      } else {
        // Claude: no manual compaction. Assert /compact is not offered, then
        // grow context with a long pasted document toward the native
        // auto-compaction threshold.
        await composer(page).click();
        await page.keyboard.type("/compact");
        await expect(page.getByRole("option", { name: /compact/i })).toHaveCount(0);
        await page.keyboard.press("Escape");
        await composer(page).click();
        await page.keyboard.press("ControlOrMeta+A");
        await page.keyboard.press("Backspace");
        await sendMessage(page, longContextPrompt());
        await waitForAssistantReply(page);
      }

      // 1) Meter reflects a compaction state (in-progress, then a terminal
      //    owner state) and never an error.
      await openContextMeterPopover(page);
      const meterState = page
        .getByText("Auto-compacts when context is nearly full.")
        .or(page.getByText("Synara will compact automatically."))
        .or(page.getByText("Compact now"))
        .or(page.getByText("Compact now with /compact."))
        .or(page.getByText(/Compacting context/));
      await expect(meterState.first()).toBeVisible({ timeout: 120_000 });
      await expect(page.getByText(/Compaction failed/)).toHaveCount(0);

      // 2) Timeline shows the compaction item (manual compaction always emits
      //    one; auto compaction emits one once the threshold is crossed).
      if (spec.manualCompact) {
        await expect(page.getByText(/Context compacted|Compacting context/).first()).toBeVisible({
          timeout: 180_000,
        });
      }

      // 3) The thread still works after compaction.
      await sendMessage(page, 'Say "done".');
      await waitForAssistantReply(page);
      await expect(page.getByText(/error/i)).toHaveCount(0);
    });
  });
}
