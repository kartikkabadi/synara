import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  jobs: [] as unknown[],
  nextAfterSequence: 0,
  context: null as unknown,
  job: null as unknown,
  refetch: vi.fn(),
  resolveUncertainJob: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly unknown[] }) => ({
    data:
      options.queryKey[1] === "revertJob"
        ? { job: harness.job, context: harness.context }
        : { kernelEnabled: true, jobs: harness.jobs, nextAfterSequence: harness.nextAfterSequence },
    refetch: harness.refetch,
    isError: false,
    isPending: false,
  }),
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ controlPlane: { resolveUncertainJob: harness.resolveUncertainJob } }),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: harness.toast } }));

import { UncertainRevertJobsSection } from "./UncertainRevertJobsSection";

describe("uncertain revert observations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.job = {
      jobId: "job-1",
      queue: "checkpoint-revert",
      partitionKey: "thread:thread-1/saga:saga-1",
      state: "pending",
      attempt: 0,
    };
    harness.jobs = [harness.job];
    harness.nextAfterSequence = 1;
    harness.context = {
      mode: "shadow",
      status: "uncertain",
      sagaId: "saga-1",
      threadId: "thread-1",
      turnCount: 1,
      targetCheckpointRef: "refs/target",
      rescueCheckpointRef: "refs/rescue",
      uncertainStepId: "provider-rollback",
      detail: "Response lost",
    };
    harness.resolveUncertainJob.mockResolvedValue({ job: { state: "succeeded" } });
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("requires inspection, a reason and confirmation before closing a pending observation", async () => {
    await render(<UncertainRevertJobsSection />);
    await page.getByRole("button", { name: "Inspect", exact: true }).click();
    expect(harness.resolveUncertainJob).not.toHaveBeenCalled();
    const confirm = page.getByRole("button", { name: "Confirm decision" });
    expect((confirm.element() as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain("refs/rescue");
    expect(document.body.textContent).toContain("Automatic retry is unavailable");
    await page
      .getByRole("textbox", { name: "Reason for this decision" })
      .fill("Provider history inspected");
    await confirm.click();
    await vi.waitFor(() =>
      expect(harness.resolveUncertainJob).toHaveBeenCalledExactlyOnceWith({
        jobId: "job-1",
        resolution: "markDead",
        reason: "Provider history inspected",
      }),
    );
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Observation decision recorded",
        description: "The conversation and workspace were not changed.",
      }),
    );
  });

  it("allows pagination past a page containing only certain observations", async () => {
    harness.jobs = [];
    harness.nextAfterSequence = 50;
    await render(<UncertainRevertJobsSection />);
    const next = page.getByRole("button", { name: "Next", exact: true });
    expect((next.element() as HTMLButtonElement).disabled).toBe(false);
    await next.click();
    expect((next.element() as HTMLButtonElement).disabled).toBe(true);
    expect(
      (page.getByRole("button", { name: "Previous" }).element() as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
