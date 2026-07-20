// FILE: useProviderModelCatalog.browser.tsx
// Purpose: Regression tests for provider model discovery wiring in
//          useProviderModelCatalog, especially Droid memo dependencies.
// Layer: Web hooks (browser tests)

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import {
  DEFAULT_SERVER_SETTINGS_VIEW,
  type NativeApi,
  type ProviderListModelsResult,
} from "@synara/contracts";
import { useProviderModelCatalog } from "./useProviderModelCatalog";

const EMPTY_MODELS_RESULT: ProviderListModelsResult = {
  models: [],
  source: "test",
  cached: false,
};

const DROID_DISCOVERED_MODEL: ProviderListModelsResult = {
  models: [
    {
      slug: "droid/gpt-5.6-luna" as never,
      name: "GPT-5.6 Luna",
    },
  ],
  source: "droid-acp",
  cached: false,
};

const DEVIN_DISCOVERED_MODEL: ProviderListModelsResult = {
  models: [
    {
      slug: "devin/swe-1.7" as never,
      name: "SWE 1.7",
    },
  ],
  source: "devin.acp",
  cached: false,
};

function createNativeApiMock(
  listModels: (input: { provider: string }) => Promise<ProviderListModelsResult>,
): NativeApi {
  return {
    dialogs: { pickFolder: vi.fn(async () => null), confirm: vi.fn(async () => false) },
    terminal: {
      open: vi.fn(),
      write: vi.fn(),
      ackOutput: vi.fn(),
      resize: vi.fn(),
      clear: vi.fn(),
      restart: vi.fn(),
      close: vi.fn(),
      onEvent: vi.fn(() => () => {}),
    },
    projects: {
      discoverScripts: vi.fn(async () => ({ scripts: [] })),
      listDirectories: vi.fn(async () => ({ directories: [] })),
      searchEntries: vi.fn(async () => ({ entries: [] })),
      searchLocalEntries: vi.fn(async () => ({ entries: [] })),
      readFile: vi.fn(async () => ({ content: "" })),
      createLocalFilePreviewGrant: vi.fn(async () => ({ granted: false })),
    },
    server: {
      getConfig: vi.fn(async () => ({ buildId: "test", version: "test" })),
      getSettings: vi.fn(async () => DEFAULT_SERVER_SETTINGS_VIEW),
      updateSettings: vi.fn(async () => DEFAULT_SERVER_SETTINGS_VIEW),
      getAuthSession: vi.fn(async () => ({ authenticated: false })),
      listWorktrees: vi.fn(async () => ({ worktrees: [] })),
      listLocalServers: vi.fn(async () => ({ servers: [] })),
      stopLocalServer: vi.fn(),
      getProviderUsageSnapshot: vi.fn(async () => null),
    },
    provider: {
      getStatus: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      listModels,
      listAgents: vi.fn(async () => ({ agents: [], source: "test", cached: false })),
      listCommands: vi.fn(async () => ({ commands: [], source: "test", cached: false })),
      listSkills: vi.fn(async () => ({ skills: [], source: "test", cached: false })),
      getComposerCapabilities: vi.fn(async () => ({
        supportsThreadCompaction: false,
        supportsThreadImport: false,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
      })),
    },
    browser: {
      open: vi.fn(),
      close: vi.fn(),
      hide: vi.fn(),
      getState: vi.fn(),
      setPanelBounds: vi.fn(),
      attachWebview: vi.fn(),
      detachWebview: vi.fn(),
      copyLink: vi.fn(),
      copyScreenshotToClipboard: vi.fn(),
      captureScreenshot: vi.fn(),
      executeCdp: vi.fn(),
      navigate: vi.fn(),
      reload: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      newTab: vi.fn(),
      closeTab: vi.fn(),
      selectTab: vi.fn(),
      openDevTools: vi.fn(),
      onState: vi.fn(() => () => {}),
      onBrowserUseOpenPanelRequest: vi.fn(() => () => {}),
      onBrowserCopyLink: vi.fn(() => () => {}),
    },
  } as unknown as NativeApi;
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  localStorage.setItem("synara:server-settings-migrated:v1", "1");
});

afterEach(() => {
  localStorage.clear();
  delete (window as unknown as { nativeApi?: NativeApi }).nativeApi;
});

describe("useProviderModelCatalog Droid regression", () => {
  it("updates the Droid catalog immediately when runtime discovery resolves", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const listModels = vi.fn(async (input: { provider: string }) =>
      input.provider === "droid" ? DROID_DISCOVERED_MODEL : EMPTY_MODELS_RESULT,
    );
    (window as unknown as { nativeApi?: NativeApi }).nativeApi = createNativeApiMock(listModels);

    const { result } = await renderHook(
      () =>
        useProviderModelCatalog({
          selectedProvider: "droid",
          discoveryEnabled: false,
          cwd: "/",
        }),
      {
        wrapper: createWrapper(queryClient),
      },
    );

    await vi.waitFor(() => {
      const droidOptions = result.current.modelOptionsByProvider.droid.map((m) => m.slug);
      expect(droidOptions).toContain("droid/gpt-5.6-luna");
    });
  });

  it("reports Droid as pending while selected-provider discovery is in flight", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    let resolveDroid: (value: ProviderListModelsResult) => void = () => {};
    const droidPromise = new Promise<ProviderListModelsResult>((resolve) => {
      resolveDroid = resolve;
    });

    const listModels = vi.fn(async (input: { provider: string }) => {
      if (input.provider === "droid") return droidPromise;
      return EMPTY_MODELS_RESULT;
    });

    (window as unknown as { nativeApi?: NativeApi }).nativeApi = createNativeApiMock(listModels);

    const { result } = await renderHook(
      () =>
        useProviderModelCatalog({
          selectedProvider: "droid",
          discoveryEnabled: false,
          cwd: "/",
        }),
      {
        wrapper: createWrapper(queryClient),
      },
    );

    await vi.waitFor(() => {
      expect(result.current.loadingModelProviders.droid).toBe(true);
    });

    resolveDroid(DROID_DISCOVERED_MODEL);

    await vi.waitFor(() => {
      expect(result.current.loadingModelProviders.droid).toBe(false);
    });

    expect(
      result.current.modelOptionsByProvider.droid.some(
        (model) => model.slug === "droid/gpt-5.6-luna",
      ),
    ).toBe(true);
  });

  it("does not let Devin discovery overwrite the Droid static catalog", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const listModels = vi.fn(async (input: { provider: string }) => {
      if (input.provider === "devin") return DEVIN_DISCOVERED_MODEL;
      return EMPTY_MODELS_RESULT;
    });
    (window as unknown as { nativeApi?: NativeApi }).nativeApi = createNativeApiMock(listModels);

    const { result, rerender } = await renderHook(
      (props?: { selectedProvider: "devin" | "droid" }) =>
        useProviderModelCatalog({
          selectedProvider: props?.selectedProvider ?? "droid",
          discoveryEnabled: false,
          cwd: "/",
        }),
      {
        initialProps: { selectedProvider: "droid" },
        wrapper: createWrapper(queryClient),
      },
    );

    await vi.waitFor(() => {
      expect(result.current.loadingModelProviders.droid).toBe(false);
    });
    const droidStaticSlugs = result.current.modelOptionsByProvider.droid.map((m) => m.slug);

    await rerender({ selectedProvider: "devin" });

    await vi.waitFor(() => {
      expect(
        result.current.modelOptionsByProvider.devin.some((model) => model.slug === "devin/swe-1.7"),
      ).toBe(true);
    });

    expect(result.current.modelOptionsByProvider.droid.map((m) => m.slug)).toEqual(
      droidStaticSlugs,
    );
    expect(
      result.current.modelOptionsByProvider.droid.some((model) => model.slug === "devin/swe-1.7"),
    ).toBe(false);
  });
});
