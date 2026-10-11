import type { ComponentProps, PropsWithChildren } from "react";
import { EnvironmentId, ThreadId, type ExecutionEnvironmentDescriptor } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({ environments: [] as ExecutionEnvironmentDescriptor[] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: { environments: harness.environments },
    isPending: false,
    isError: false,
  }),
}));
vi.mock("~/lib/serverReactQuery", () => ({
  serverEnvironmentsQueryOptions: () => ({ queryKey: ["environments"] }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: PropsWithChildren) => <a href="/settings">{children}</a>,
}));

import { ComposerExecutionEnvironmentPicker } from "./ComposerExecutionEnvironmentPicker";
import { useThreadExecutionEnvironmentStore } from "~/threadExecutionEnvironmentStore";

const threadId = ThreadId.makeUnsafe("remote-draft");
const environmentId = EnvironmentId.makeUnsafe("build-box");
const selection = {
  environmentId,
  environmentLabel: "Build box",
  remoteWorkspaceRoot: "/srv/project",
};
const props: ComponentProps<typeof ComposerExecutionEnvironmentPicker> = {
  threadId,
  providerKind: "codex",
  locked: false,
  hasSession: false,
};
const environment: ExecutionEnvironmentDescriptor = {
  environmentId,
  label: "Build box",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "unknown",
  capabilities: {
    providerKinds: ["codex"],
    repositoryIdentity: false,
    shell: false,
    browser: false,
    computerUse: false,
    devServerForwarding: false,
    checkpoint: false,
    sync: false,
    reconnect: "none",
  },
  runtime: { runtimeType: "ssh-process", supervisor: "none" },
  transport: { host: "example.test", port: 22, hostKeyVerification: "known-hosts" },
};

beforeEach(() => {
  harness.environments = [environment];
  useThreadExecutionEnvironmentStore.setState({ selectionByThreadId: {}, lastUsedSelection: null });
});

describe("ComposerExecutionEnvironmentPicker", () => {
  it("keeps a deleted remote selection visible until the user explicitly chooses local", async () => {
    harness.environments = [];
    useThreadExecutionEnvironmentStore
      .getState()
      .setThreadEnvironmentSelection(threadId, selection);
    const screen = await render(<ComposerExecutionEnvironmentPicker {...props} />);
    try {
      await page.getByRole("button", { name: "Execution environment: Build box" }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("environment is unavailable");
      await page.getByRole("button", { name: "Local", exact: true }).click();
      expect(
        useThreadExecutionEnvironmentStore.getState().selectionByThreadId[threadId],
      ).toBeUndefined();
      await expect
        .element(page.getByRole("button", { name: "Execution environment: This machine" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("shows the incompatible remote choice after a provider switch", async () => {
    useThreadExecutionEnvironmentStore
      .getState()
      .setThreadEnvironmentSelection(threadId, selection);
    const screen = await render(
      <ComposerExecutionEnvironmentPicker {...props} providerKind="claudeAgent" />,
    );
    try {
      await page.getByRole("button", { name: "Execution environment: Build box" }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("Codex only");
      expect(useThreadExecutionEnvironmentStore.getState().selectionByThreadId[threadId]).toEqual(
        selection,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("uses the persisted remote session after refresh and locks its environment", async () => {
    const screen = await render(
      <ComposerExecutionEnvironmentPicker
        {...props}
        hasSession
        locked
        executionProfile={{
          environmentId,
          providerKind: "codex",
          remoteWorkspaceRoot: "/srv/persisted",
        }}
      />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Execution environment: Build box" }))
        .toBeDisabled();
      expect(
        useThreadExecutionEnvironmentStore.getState().selectionByThreadId[threadId],
      ).toBeUndefined();
    } finally {
      await screen.unmount();
    }
  });

  it("does not copy one host's workspace path to a different host", async () => {
    const secondEnvironmentId = EnvironmentId.makeUnsafe("second-box");
    harness.environments = [
      environment,
      { ...environment, environmentId: secondEnvironmentId, label: "Second box" },
    ];
    useThreadExecutionEnvironmentStore
      .getState()
      .setThreadEnvironmentSelection(threadId, selection);
    const screen = await render(<ComposerExecutionEnvironmentPicker {...props} />);
    try {
      await page.getByRole("button", { name: "Execution environment: Build box" }).click();
      await page.getByRole("button", { name: "Second box", exact: true }).click();
      expect(useThreadExecutionEnvironmentStore.getState().selectionByThreadId[threadId]).toEqual({
        environmentId: secondEnvironmentId,
        environmentLabel: "Second box",
        remoteWorkspaceRoot: "",
      });
    } finally {
      await screen.unmount();
    }
  });
});
