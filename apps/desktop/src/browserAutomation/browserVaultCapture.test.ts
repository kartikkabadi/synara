import { EventEmitter } from "node:events";
import type { BrowserVaultSnapshot } from "@synara/contracts";
import type { CaptureContextShim } from "./browserVaultCapture";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import type { BrowserVault } from "./browserVault";

const mocks = vi.hoisted(() => ({ install: vi.fn(), dispose: vi.fn() }));
vi.mock("betterwright/capture", () => ({ installVaultCapture: mocks.install }));
import { BrowserVaultCapture } from "./browserVaultCapture";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dispose.mockResolvedValue(undefined);
  mocks.install.mockReturnValue({ dispose: mocks.dispose });
});

function fixture() {
  let changed = () => {};
  let state: BrowserVaultSnapshot = {
    protection: { configured: true, locked: false, osProtected: false },
    settings: { offerSave: false, autosave: false, agentUse: true },
    logins: [],
    pending: [],
    error: null,
  };
  const vault = {
    snapshot: async () => state,
    onChanged: (listener: () => void) => {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
    reportCaptureFailure: vi.fn(),
    reportCaptureReady: vi.fn(),
    shouldOfferSave: vi.fn(async () => true),
    trackSecret: vi.fn(),
    askSave: vi.fn(
      async (): Promise<{ choice: "save" | "dismiss"; explicit: boolean }> => ({
        choice: "dismiss",
        explicit: false,
      }),
    ),
    saveCaptured: vi.fn(async () => {}),
  };
  const capture = new BrowserVaultCapture(vault as unknown as BrowserVault);
  return {
    capture,
    vault,
    update: (patch: Partial<BrowserVaultSnapshot>) => {
      state = { ...state, ...patch };
      changed();
    },
  };
}

describe("native credential capture lifecycle", () => {
  it("does not install sensors without consent and removes them when the vault locks", async () => {
    const f = fixture();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.install).not.toHaveBeenCalled();
    f.update({ settings: { offerSave: true, autosave: false, agentUse: true } });
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledTimes(1));
    expect(mocks.install.mock.calls[0]![1]).toMatchObject({ promptTtlMs: 120_000 });
    f.update({ protection: { configured: true, locked: true, osProtected: false } });
    await vi.waitFor(() => expect(mocks.dispose).toHaveBeenCalledTimes(1));
    await f.capture.dispose();
  });

  it("keeps the capture surface structurally complete (pages/on/off/newCDPSession/isClosed)", async () => {
    const f = fixture();
    f.update({ settings: { offerSave: true, autosave: false, agentUse: true } });
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalled());
    const context = mocks.install.mock.calls[0]![0] as CaptureContextShim;
    // on("page") fires for late-registered tabs; off("page") stops the fan-out.
    const seen: string[] = [];
    const listener = (page: { id: string }) => void seen.push(page.id);
    context.on("page", listener);
    const unregister = f.capture.register({
      webContents: {
        debugger: Object.assign(new EventEmitter(), {
          isAttached: () => false,
          sendCommand: vi.fn(),
        }),
        isDestroyed: () => false,
      },
    } as unknown as BrowserAutomationVisibleRuntime);
    expect(seen).toHaveLength(1);
    context.off("page", listener);
    f.capture.register({
      webContents: {
        debugger: Object.assign(new EventEmitter(), {
          isAttached: () => false,
          sendCommand: vi.fn(),
        }),
        isDestroyed: () => false,
      },
    } as unknown as BrowserAutomationVisibleRuntime);
    expect(seen).toHaveLength(1);
    // Closed tabs are reported shut and refuse new CDP sessions.
    const [page] = context.pages();
    expect(page!.isClosed()).toBe(false);
    unregister();
    expect(page!.isClosed()).toBe(true);
    await expect(context.newCDPSession(page!)).rejects.toThrow("unavailable");
    await f.capture.dispose();
  });
});

interface CaptureDeps {
  requestSave(input: {
    page: unknown;
    origin: string;
    username: string;
    mode: string;
  }): Promise<"save" | "dismiss">;
  vaultCallAtOrigin(
    session: unknown,
    origin: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<unknown>;
}

describe("capture save provenance", () => {
  async function installSaveFlow(askSaveResult: { choice: "save" | "dismiss"; explicit: boolean }) {
    const f = fixture();
    f.vault.askSave.mockResolvedValue(askSaveResult);
    f.update({ settings: { offerSave: true, autosave: true, agentUse: true } });
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalled());
    const [context, deps] = mocks.install.mock.calls[0] as [CaptureContextShim, CaptureDeps];
    const runtime = {
      threadId: "thread-1",
      webContents: { isDestroyed: () => false },
    } as unknown as BrowserAutomationVisibleRuntime;
    f.capture.register(runtime);
    f.capture.noteAgentActivity(runtime);
    return { f, context, deps };
  }

  it("keeps an agent-originated capture pending-owned and deduped under autosave", async () => {
    const { f, context, deps } = await installSaveFlow({ choice: "save", explicit: false });
    const page = context.pages()[0]!;
    await expect(
      deps.requestSave({ page, origin: "https://site.test", username: "u", mode: "save" }),
    ).resolves.toBe("save");
    await deps.vaultCallAtOrigin(page, "https://site.test", "save", {
      username: "u",
      password: "synthetic-agent-secret",
      label: "l",
    });
    expect(f.vault.saveCaptured).toHaveBeenCalledWith(
      "https://site.test",
      {
        username: "u",
        password: "synthetic-agent-secret",
        label: "l",
        deferToPending: true,
      },
      "agent",
    );
    await f.capture.dispose();
  });

  it("commits an explicitly approved capture as user-owned even after agent activity", async () => {
    const { f, context, deps } = await installSaveFlow({ choice: "save", explicit: true });
    const page = context.pages()[0]!;
    await deps.requestSave({ page, origin: "https://site.test", username: "u", mode: "save" });
    await deps.vaultCallAtOrigin(page, "https://site.test", "save", {
      username: "u",
      password: "synthetic-agent-secret",
      label: "l",
    });
    expect(f.vault.saveCaptured).toHaveBeenCalledWith(
      "https://site.test",
      {
        username: "u",
        password: "synthetic-agent-secret",
        label: "l",
        deferToPending: false,
      },
      "user",
    );
    await f.capture.dispose();
  });
  it("does not reuse approval for a different captured username", async () => {
    const { f, context, deps } = await installSaveFlow({ choice: "save", explicit: true });
    const page = context.pages()[0]!;
    await deps.requestSave({
      page,
      origin: "https://site.test",
      username: "approved",
      mode: "save",
    });
    await deps.vaultCallAtOrigin(page, "https://site.test", "save", {
      username: "different",
      password: "synthetic-agent-secret",
      label: "l",
    });
    expect(f.vault.saveCaptured).toHaveBeenCalledWith(
      "https://site.test",
      {
        username: "different",
        password: "synthetic-agent-secret",
        label: "l",
        deferToPending: true,
      },
      "agent",
    );
    await f.capture.dispose();
  });
});
