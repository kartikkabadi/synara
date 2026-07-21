"use client";

// FILE: LoopCompletionRecord.tsx
// Purpose: Durable transcript card summarizing a finished `/loop` run.
// Layer: Chat transcript UI

import type { ThreadLoop } from "@synara/contracts";
import { useState } from "react";

import {
  CheckCircle2Icon,
  CircleAlertIcon,
  ClockIcon,
  StopIcon,
  type LucideIcon,
} from "~/lib/icons";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { formatLoopStopReason, type LoopStopReasonCopy } from "./loopPresentation";

interface LoopCompletionRecordProps {
  loop: ThreadLoop;
}

function outcomeIcon(reason: NonNullable<ThreadLoop["lastStopReason"]>): LucideIcon {
  switch (reason) {
    case "budget_iterations":
      return CheckCircle2Icon;
    case "budget_duration":
      return ClockIcon;
    case "consecutive_errors":
    case "prompt_invalid":
    case "thread_unrunnable":
      return CircleAlertIcon;
    default:
      return StopIcon;
  }
}

function formatRecordTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function budgetLabel(loop: ThreadLoop): string {
  if (loop.maxIterations !== null) {
    return `${loop.maxIterations} ${loop.maxIterations === 1 ? "turn" : "turns"}`;
  }
  if (loop.endsAt !== null) {
    const totalMs = new Date(loop.endsAt).getTime() - new Date(loop.createdAt).getTime();
    const minutes = Math.max(1, Math.round(totalMs / 60_000));
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `None (safety limit ${loop.hardCap})`;
}

function detailRows(loop: ThreadLoop, copy: LoopStopReasonCopy): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  // "Final objective" because the user may have steered the loop mid-run.
  if (loop.prompt.trim().length > 0) {
    rows.push(["Final objective", loop.prompt]);
  }
  rows.push(["Budget", budgetLabel(loop)]);
  rows.push(["Started", formatRecordTimestamp(loop.createdAt)]);
  rows.push(["Stopped", formatRecordTimestamp(loop.updatedAt)]);
  if (copy.reason !== null) {
    rows.push(["Reason", copy.reason]);
  }
  return rows;
}

export function LoopCompletionRecord({ loop }: LoopCompletionRecordProps) {
  const [expanded, setExpanded] = useState(false);
  const reason = loop.lastStopReason;
  if (reason == null) {
    return null;
  }

  const copy = formatLoopStopReason(reason, loop, loop.iteration);
  const Icon = outcomeIcon(reason);

  return (
    <div className="my-3 overflow-hidden rounded-[0.65rem] border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] font-system-ui">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border)]"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13px] font-medium text-foreground">{copy.title}</span>
          <span className="truncate text-[11px] text-muted-foreground">
            {copy.summary}
            {copy.reason !== null ? ` · ${copy.reason}` : ""}
          </span>
        </div>
        <DisclosureChevron open={expanded} className="text-muted-foreground/55" />
      </button>
      <DisclosureRegion open={expanded}>
        <dl className="space-y-1.5 border-t border-[color:var(--color-border-light)] px-3.5 py-3">
          {detailRows(loop, copy).map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-2 text-[11px]">
              <dt className="w-24 shrink-0 text-muted-foreground/70">{label}</dt>
              <dd className="min-w-0 break-words text-foreground/90">{value}</dd>
            </div>
          ))}
        </dl>
      </DisclosureRegion>
    </div>
  );
}
