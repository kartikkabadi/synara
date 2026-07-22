// FILE: UncertainRevertJobsSection.tsx
// Purpose: Operator surface for uncertain checkpoint-revert kernel jobs —
// lists them and offers the three resolutions (retry / mark succeeded / mark dead).
// Layer: Settings UI components
// Exports: UncertainRevertJobsSection

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { ControlPlaneJob, ControlPlaneJobResolution } from "@synara/contracts";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi } from "~/nativeApi";
import { SettingsListRow, SettingsSection } from "./SettingsPanelPrimitives";

const UNCERTAIN_REVERT_JOBS_QUERY_KEY = ["controlPlane", "uncertainRevertJobs"] as const;

const THREAD_PARTITION_PREFIX = "thread:";

function jobThreadId(job: ControlPlaneJob): string | null {
  return job.partitionKey.startsWith(THREAD_PARTITION_PREFIX)
    ? job.partitionKey.slice(THREAD_PARTITION_PREFIX.length)
    : null;
}

const RESOLUTIONS: ReadonlyArray<{ resolution: ControlPlaneJobResolution; label: string }> = [
  { resolution: "retry", label: "Retry" },
  { resolution: "markSucceeded", label: "Mark succeeded" },
  { resolution: "markDead", label: "Mark dead" },
];

export function UncertainRevertJobsSection() {
  const queryClient = useQueryClient();
  const [resolvingJobId, setResolvingJobId] = useState<string | null>(null);

  const jobsQuery = useQuery({
    queryKey: UNCERTAIN_REVERT_JOBS_QUERY_KEY,
    queryFn: () => ensureNativeApi().controlPlane.listUncertainRevertJobs({}),
  });

  if (!jobsQuery.data?.kernelEnabled) return null;
  const jobs = jobsQuery.data.jobs;

  const resolveJob = (jobId: string, resolution: ControlPlaneJobResolution) => {
    setResolvingJobId(jobId);
    void ensureNativeApi()
      .controlPlane.resolveUncertainJob({ jobId, resolution })
      .then((result) => {
        toastManager.add({
          type: "success",
          title: "Revert job resolved",
          description: `Job is now ${result.job?.state ?? "resolved"}.`,
        });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Failed to resolve revert job",
          description: error instanceof Error ? error.message : "Unable to resolve the job.",
        });
      })
      .finally(() => {
        setResolvingJobId(null);
        void queryClient.invalidateQueries({ queryKey: UNCERTAIN_REVERT_JOBS_QUERY_KEY });
      });
  };

  return (
    <SettingsSection title="Checkpoint revert jobs">
      {jobs.length === 0 ? (
        <SettingsListRow
          title="No uncertain revert jobs"
          description="Revert jobs whose outcome could not be confirmed will appear here for manual resolution."
        />
      ) : (
        jobs.map((job) => (
          <SettingsListRow
            key={job.jobId}
            align="start"
            title={<span className="font-mono text-xs">{job.jobId}</span>}
            description={
              <>
                <span className="block">
                  Thread: {jobThreadId(job) ?? job.partitionKey} · Attempts: {job.attempt}
                </span>
                {job.errorSummary ? (
                  <span className="block text-destructive">{job.errorSummary}</span>
                ) : null}
              </>
            }
            actions={
              <div className="flex gap-2">
                {RESOLUTIONS.map(({ resolution, label }) => (
                  <Button
                    key={resolution}
                    size="xs"
                    variant={resolution === "markDead" ? "destructive-outline" : "outline"}
                    disabled={resolvingJobId !== null}
                    onClick={() => resolveJob(job.jobId, resolution)}
                  >
                    {resolvingJobId === job.jobId ? "Resolving..." : label}
                  </Button>
                ))}
              </div>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}
