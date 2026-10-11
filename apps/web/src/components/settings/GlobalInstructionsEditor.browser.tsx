import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { GlobalInstructionsEditor } from "./GlobalInstructionsEditor";

const api = vi.hoisted(() => ({
  getGlobalInstructions: vi.fn(),
  updateGlobalInstructions: vi.fn(),
}));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => ({ server: api }),
}));
beforeEach(() => {
  api.getGlobalInstructions.mockReset().mockResolvedValue({ contents: "Original guidance" });
  api.updateGlobalInstructions
    .mockReset()
    .mockImplementation(async ({ contents }: { contents: string }) => ({
      contents: contents.trim(),
    }));
});
async function openEditor() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <GlobalInstructionsEditor />
    </QueryClientProvider>,
  );
  return { screen, client };
}

it("loads, edits, saves normalized content and reloads the saved result", async () => {
  const { screen, client } = await openEditor();
  const input = screen.getByRole("textbox", { name: "Global SYNARA.md instructions content" });
  await expect.element(input).toHaveValue("Original guidance");
  await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await input.fill("  Updated guidance  ");
  await expect.element(screen.getByText("Unsaved changes", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(input).toHaveValue("Updated guidance");
  expect(api.updateGlobalInstructions).toHaveBeenCalledWith({ contents: "  Updated guidance  " });
  await expect.element(screen.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await screen.unmount();
  client.clear();
  api.getGlobalInstructions.mockResolvedValue({ contents: "Updated guidance" });
  const reopened = await openEditor();
  await expect.element(reopened.screen.getByRole("textbox")).toHaveValue("Updated guidance");
  await reopened.screen.unmount();
  reopened.client.clear();
});

it("retains unsaved text and permits an explicit retry after a save failure", async () => {
  api.updateGlobalInstructions.mockRejectedValueOnce(new Error("Save failed; try again."));
  const { screen, client } = await openEditor();
  await expect.element(screen.getByRole("textbox")).toHaveValue("Original guidance");
  await screen.getByRole("textbox").fill("Keep this draft");
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(screen.getByText("Save failed; try again.", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("textbox")).toHaveValue("Keep this draft");
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(screen.getByText("Saved", { exact: true })).toBeVisible();
  expect(api.updateGlobalInstructions).toHaveBeenCalledTimes(2);
  await screen.unmount();
  client.clear();
});

it("shows read errors without writing or enabling the feature", async () => {
  api.getGlobalInstructions.mockRejectedValue(new Error("Owner authorization is required."));
  const { screen, client } = await openEditor();
  await expect
    .element(screen.getByText("Owner authorization is required.", { exact: true }))
    .toBeVisible();
  expect(api.updateGlobalInstructions).not.toHaveBeenCalled();
  await screen.unmount();
  client.clear();
});
