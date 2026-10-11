import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { ControlPlaneJob, ControlPlaneJobResolution } from "@synara/contracts";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { ensureNativeApi } from "~/nativeApi";
import { SettingsListRow, SettingsSection } from "./SettingsPanelPrimitives";

const PAGE_SIZE = 50;

export function UncertainRevertJobsSection() {
  const [cursors, setCursors] = useState([0]);
  const [selected, setSelected] = useState<ControlPlaneJob | null>(null);
  const [resolution, setResolution] = useState<ControlPlaneJobResolution>("markDead");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const afterSequence = cursors.at(-1) ?? 0;
  const jobsQuery = useQuery({
    queryKey: ["controlPlane", "uncertainRevertJobs", afterSequence],
    queryFn: () =>
      ensureNativeApi().controlPlane.listUncertainRevertJobs({ afterSequence, limit: PAGE_SIZE }),
  });
  const contextQuery = useQuery({
    queryKey: ["controlPlane", "revertJob", selected?.jobId],
    queryFn: () => ensureNativeApi().controlPlane.getJob({ jobId: selected!.jobId }),
    enabled: selected !== null,
  });
  const context = contextQuery.data?.context;

  if (jobsQuery.isError) {
    return (
      <SettingsSection title="Checkpoint revert observations">
        <SettingsListRow
          title="Observations could not be loaded"
          description={jobsQuery.error.message}
          actions={
            <Button size="sm" variant="outline" onClick={() => void jobsQuery.refetch()}>
              Reload
            </Button>
          }
        />
      </SettingsSection>
    );
  }
  if (!jobsQuery.data?.kernelEnabled) return null;
  const jobs = jobsQuery.data.jobs;

  const resolveJob = async () => {
    if (!selected || !context || !reason.trim() || pending) return;
    setPending(true);
    try {
      await ensureNativeApi().controlPlane.resolveUncertainJob({
        jobId: selected.jobId,
        resolution,
        reason,
      });
      toastManager.add({
        type: "success",
        title: "Observation decision recorded",
        description: "The conversation and workspace were not changed.",
      });
      setSelected(null);
      await jobsQuery.refetch();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Decision could not be recorded",
        description:
          error instanceof Error ? error.message : "Reload the observation before trying again.",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <SettingsSection title="Checkpoint revert observations">
        {jobs.length === 0 ? (
          <SettingsListRow
            title="No uncertain observations"
            description="Shadow records help inspect past checkpoint reverts. They do not execute recovery."
          />
        ) : (
          jobs.map((job) => (
            <SettingsListRow
              key={job.jobId}
              align="start"
              title={<span className="font-mono text-ui-xs">{job.jobId}</span>}
              description={
                <>
                  <span className="block break-all">
                    Partition: {job.partitionKey} · Attempts: {job.attempt}
                  </span>
                  {job.errorSummary ? (
                    <span className="block text-destructive">{job.errorSummary}</span>
                  ) : null}
                </>
              }
              actions={
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setSelected(job);
                    setReason("");
                    setResolution("markDead");
                  }}
                >
                  Inspect
                </Button>
              }
            />
          ))
        )}
        {cursors.length > 1 || jobsQuery.data.nextAfterSequence > afterSequence ? (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={cursors.length === 1}
              onClick={() => setCursors((values) => values.slice(0, -1))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={jobsQuery.data.nextAfterSequence <= afterSequence}
              onClick={() => setCursors((values) => [...values, jobsQuery.data.nextAfterSequence])}
            >
              Next
            </Button>
          </div>
        ) : null}
      </SettingsSection>
      <AlertDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setSelected(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Inspect revert observation</AlertDialogTitle>
            <AlertDialogDescription>
              Recording a decision changes only this shadow record. It does not roll back the
              provider, restore files, or clear a live conversation lock. Automatic retry is
              unavailable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 px-4 py-2 text-ui-sm">
            {contextQuery.isPending ? (
              <p>Loading recorded context…</p>
            ) : contextQuery.isError ? (
              <p className="text-destructive">{contextQuery.error.message}</p>
            ) : context ? (
              <>
                <dl className="space-y-1 break-all">
                  <dt>Thread</dt>
                  <dd>{context.threadId}</dd>
                  <dt>Target checkpoint</dt>
                  <dd>{context.targetCheckpointRef}</dd>
                  <dt>Rescue snapshot reference</dt>
                  <dd>{context.rescueCheckpointRef ?? "Not recorded"}</dd>
                </dl>
                {context.uncertainStepId ? (
                  <p>
                    Uncertain step: {context.uncertainStepId}. {context.detail}
                  </p>
                ) : null}
                <p className="text-muted-foreground">
                  Snapshot presence and provider rollback are not verified here. Inspect the
                  workspace and provider history before recording a decision.
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={resolution === "markSucceeded" ? "default" : "outline"}
                    disabled={pending}
                    onClick={() => setResolution("markSucceeded")}
                  >
                    Record success
                  </Button>
                  <Button
                    size="sm"
                    variant={resolution === "markDead" ? "destructive" : "outline"}
                    disabled={pending}
                    onClick={() => setResolution("markDead")}
                  >
                    Close unresolved
                  </Button>
                </div>
                <label className="block space-y-1">
                  <span>Reason for this decision</span>
                  <Textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={2000}
                    disabled={pending}
                  />
                </label>
              </>
            ) : (
              <p>
                This older record has no verified shadow context. Keep it for manual recovery; it
                cannot be resolved here.
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" disabled={pending} />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={
                pending ||
                !context ||
                !reason.trim() ||
                context.status !== "uncertain" ||
                !["pending", "uncertain"].includes(contextQuery.data?.job?.state ?? "")
              }
              onClick={() => void resolveJob()}
            >
              {pending ? "Recording…" : "Confirm decision"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
