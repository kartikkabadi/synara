import "../index.css";

import type { DesktopBetaChannelState, DesktopBridge } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { BetaWelcomeDialog } from "./BetaWelcomeDialog";

vi.mock("../env", () => ({ isElectron: true }));
vi.mock("../appSettings", () => ({
  useAppSettings: () => ({ updateSettingsAndWait: async () => true }),
}));

const originalBridge = window.desktopBridge;
const storageKey = "synara:beta-welcome:v1";
const state: DesktopBetaChannelState = {
  supported: true,
  flavor: "beta",
  installed: true,
  version: "1.0.0-beta.1",
  canInstall: true,
  running: true,
  lastImportAt: null,
  lastImportError: null,
  downloadUrl: "https://example.com/beta",
  install: null,
  stableInstalled: true,
  canMoveBetaToTrash: true,
  stableDownloadUrl: "https://example.com/stable",
};
beforeEach(() => {
  localStorage.removeItem(storageKey);
  useOnboardingDialogStore.setState({
    startupGateSettled: false,
    isOpen: false,
    betaWelcomePending: false,
  });
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
});
afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  localStorage.removeItem(storageKey);
});

it("shows Beta welcome before the first-run gate and releases it only on acknowledgement", async () => {
  window.desktopBridge = { beta: { getState: async () => state } } as unknown as DesktopBridge;
  const screen = await render(<BetaWelcomeDialog />);
  try {
    await expect
      .element(page.getByRole("dialog", { name: "Welcome to Synara Beta" }))
      .toBeVisible();
    expect(useOnboardingDialogStore.getState().betaWelcomePending).toBe(true);
    expect(localStorage.getItem(storageKey)).toBeNull();
    await page.getByRole("button", { name: "Get started" }).click();
    expect(useOnboardingDialogStore.getState().betaWelcomePending).toBe(false);
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({ acknowledged: true });
    expect(useAnnouncementSheetSlotStore.getState().handedOff).toBe(false);
  } finally {
    await screen.unmount();
  }
});

it("does not claim the slot or acknowledge Beta welcome on Stable", async () => {
  window.desktopBridge = {
    beta: { getState: async () => ({ ...state, flavor: "production" }) },
  } as unknown as DesktopBridge;
  const screen = await render(<BetaWelcomeDialog />);
  try {
    await vi.waitFor(() =>
      expect(useOnboardingDialogStore.getState().betaWelcomePending).toBe(false),
    );
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(useAnnouncementSheetSlotStore.getState().owner).toBeNull();
    expect(localStorage.getItem(storageKey)).toBeNull();
  } finally {
    await screen.unmount();
  }
});

it("opens Stable for the existing import flow without acknowledging or removing Beta", async () => {
  const leave = vi.fn(async () => ({ ok: true }));
  window.desktopBridge = {
    beta: { getState: async () => state, leave },
  } as unknown as DesktopBridge;
  const screen = await render(<BetaWelcomeDialog />);
  try {
    await page.getByRole("button", { name: "Open Synara to import" }).click();
    expect(leave).toHaveBeenCalledWith({ moveToTrash: false });
    await expect.element(page.getByRole("button", { name: "Opening Synara…" })).toBeDisabled();
    await page.getByRole("button", { name: "Get started" }).click();
    expect(localStorage.getItem(storageKey)).toBeNull();
    expect(useOnboardingDialogStore.getState().betaWelcomePending).toBe(true);
  } finally {
    await screen.unmount();
  }
});

it("keeps the welcome available when opening Stable fails", async () => {
  window.desktopBridge = {
    beta: {
      getState: async () => state,
      leave: async () => ({ ok: false, message: "Synara could not start." }),
    },
  } as unknown as DesktopBridge;
  const screen = await render(<BetaWelcomeDialog />);
  try {
    await page.getByRole("button", { name: "Open Synara to import" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Synara could not start.");
    await expect.element(page.getByRole("button", { name: "Open Synara to import" })).toBeEnabled();
    expect(localStorage.getItem(storageKey)).toBeNull();
  } finally {
    await screen.unmount();
  }
});

it.each([
  { ...state, stableInstalled: false },
  { ...state, lastImportAt: "2026-10-10T12:00:00.000Z" },
])(
  "does not offer another import when it is unavailable or already complete",
  async (nextState) => {
    window.desktopBridge = {
      beta: { getState: async () => nextState },
    } as unknown as DesktopBridge;
    const screen = await render(<BetaWelcomeDialog />);
    try {
      await expect.element(page.getByRole("dialog")).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Open Synara to import" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  },
);
