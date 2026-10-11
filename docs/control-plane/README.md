# Checkpoint revert kernel status

The canonical kernel stack supports `SYNARA_CONTROL_PLANE_KERNEL=off` (default)
and `shadow`. The existing checkpoint reactor remains the executor in both
modes. It captures the pre-revert workspace, compensates failures, and commits
conversation completion before deleting checkpoints. Shadow failures do not
change that execution path.

`on` fails server startup with `AuthoritativeModeUnavailable`. The original
PR 73 implementation is preserved in the branch history, but its execution
path is incompatible with current recovery guarantees and is not enabled.
This branch is a draft for source and native-runtime validation.

## Shadow mode

Shadow mode loads `minisqlite-node` from normal module resolution or the explicit
`SYNARA_CONTROL_PLANE_ADDON_PATH`. Startup checks the exported constructor and
required store methods, including the operator lookup/pagination methods. A
missing or incompatible addon fails startup. The addon is not packaged by this
change; no installed app is switched to shadow mode.

The kernel uses `control-plane.db` in the configured server state directory.
It does not read another Stable/Beta data home. Each recording has its own
partition so an earlier uncertain recording from the same thread cannot be
claimed during a later recording's settlement. The job and its shadow context
are created in one transaction. Completion and the observation's ACK also
share one transaction. These records are observations, not executable recovery
requests. An uncertain event can leave an observation pending or leased; kernel
lease maintenance determines when its job appears in the uncertain-job list.

The rescue-checkpoint helper keeps the first snapshot for a saga and exposes
enumeration for manual inspection. Current checkpoint execution retains its
existing rescue namespace and cleanup policy. Automatic bounded retention for
historical saga rescue refs is deferred: the missing recovery executor cannot
safely establish that an interrupted saga no longer needs a snapshot.

## Operator surface

Only owner sessions can list, inspect, or resolve kernel jobs. Settings shows
paginated uncertain observations. A confirmation requires a reason and shows
the recorded thread, target checkpoint, and rescue reference when available.
The UI explicitly states that snapshot presence and provider history are not
verified by this view.

Only a job with verified new shadow context can receive a terminal operator
annotation. The decision and reason are committed atomically with the job
resolution; a state race fails without a success claim. This never changes
files, provider history, or the domain saga lock. Older jobs without shadow
context remain inspectable and require manual recovery. `retry` is rejected
because there is no durable consumer that can execute it.

## Authoritative-mode work still required

Before `on` can be implemented and enabled, the existing orchestration delivery
and executor boundaries need:

- Durable restart execution with exact saga/job identity and recovered claims.
- Lease renewal and cancellation ownership throughout provider and Git work.
- Recovery of indeterminate commits before repeating any external effect.
- A per-step recovery schedule that never repeats an ambiguous provider rollback.
- Domain settlement for compensation and operator decisions, with retained rescue
  snapshots until that settlement commits.
- Safe rescue-ref reconciliation, bounded retention, and native process crash drills.

The additive migration `135_ProjectionThreadsRevertSaga` persists saga identity
and uncertainty in the existing SQL projection and all continuation snapshots.
It invalidates the thread projection cursor for journal replay. This repairs the
contract/persistence gap but does not provide the missing executor. Migration
135 must be renumbered to the next contiguous slot if another unreleased branch
lands first; already released migration identities must never be rewritten.

## Verification

Run root formatting, lint, typecheck, full tests and build; also run
`bun run migrations:check`. Focused server coverage includes
`ControlPlaneKernel.test.ts`, `RevertSagaWorker.test.ts`,
`RevertSagaDrills.test.ts`, `CheckpointReactor.test.ts`, checkpoint store/Utils,
`controlPlaneOperator.test.ts`, `wsRpc.auth.test.ts`, and the projection tests.
Native tests are skipped when the addon is absent. Passing source tests does
not prove addon packaging, native crash recovery, or a production rollout.
