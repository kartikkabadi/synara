// FILE: controlPlane.ts
// Purpose: Schemas for the control-plane kernel operator RPCs (uncertain
// checkpoint-revert job listing, lookup, and resolution). Backed by the
// minisqlite control-plane kernel; endpoints degrade gracefully when the
// kernel rollout flag is off.
// Layer: shared contracts (schema-only, no runtime logic)

import { Schema } from "effect";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const CONTROL_PLANE_KERNEL_DISABLED_CODE = "CONTROL_PLANE_KERNEL_DISABLED";

// ── Building blocks ──────────────────────────────────────────────────

/** Operator decision for a job in the `uncertain` state. */
export const ControlPlaneJobResolution = Schema.Literals(["retry", "markSucceeded", "markDead"]);
export type ControlPlaneJobResolution = typeof ControlPlaneJobResolution.Type;

// Mirrors the kernel's job info: `state` is a kernel state name (e.g.
// "pending", "leased", "uncertain", "succeeded", "dead") and `partitionKey`
// carries the saga scope (checkpoint-revert jobs use "thread:<threadId>").
export const ControlPlaneJob = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  queue: TrimmedNonEmptyString,
  partitionKey: TrimmedNonEmptyString,
  state: TrimmedNonEmptyString,
  attempt: NonNegativeInt,
  leaseExpiresAtMs: Schema.optional(Schema.Number),
  workerId: Schema.optional(Schema.String),
  errorSummary: Schema.optional(Schema.String),
});
export type ControlPlaneJob = typeof ControlPlaneJob.Type;

// ── List uncertain checkpoint-revert jobs ────────────────────────────

export const ControlPlaneListUncertainRevertJobsInput = Schema.Struct({
  /** Pagination cursor (enqueue sequence); start from 0. */
  afterSequence: Schema.optional(NonNegativeInt),
  limit: Schema.optional(NonNegativeInt),
});
export type ControlPlaneListUncertainRevertJobsInput =
  typeof ControlPlaneListUncertainRevertJobsInput.Type;

// `kernelEnabled` is false when SYNARA_CONTROL_PLANE_KERNEL is off; the list
// is then always empty so clients can hide the operator surface.
export const ControlPlaneListUncertainRevertJobsResult = Schema.Struct({
  kernelEnabled: Schema.Boolean,
  jobs: Schema.Array(ControlPlaneJob),
  nextAfterSequence: NonNegativeInt,
});
export type ControlPlaneListUncertainRevertJobsResult =
  typeof ControlPlaneListUncertainRevertJobsResult.Type;

// ── Single job lookup ────────────────────────────────────────────────

export const ControlPlaneGetJobInput = Schema.Struct({
  jobId: TrimmedNonEmptyString,
});
export type ControlPlaneGetJobInput = typeof ControlPlaneGetJobInput.Type;

export const ControlPlaneGetJobResult = Schema.Struct({
  job: Schema.NullOr(ControlPlaneJob),
});
export type ControlPlaneGetJobResult = typeof ControlPlaneGetJobResult.Type;

// ── Resolve one uncertain job ────────────────────────────────────────

export const ControlPlaneResolveUncertainJobInput = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  resolution: ControlPlaneJobResolution,
});
export type ControlPlaneResolveUncertainJobInput = typeof ControlPlaneResolveUncertainJobInput.Type;

/** The job's state after the resolution committed. */
export const ControlPlaneResolveUncertainJobResult = Schema.Struct({
  job: Schema.NullOr(ControlPlaneJob),
});
export type ControlPlaneResolveUncertainJobResult =
  typeof ControlPlaneResolveUncertainJobResult.Type;
