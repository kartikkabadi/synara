import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Runtime from "effect/Runtime";
import { trackAcpProcess, untrackAcpProcess, killTrackedProcesses } from "./acpProcessCleanup.ts";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
const childPid = child.pid;
if (!childPid) {
  throw new Error("Failed to spawn tracked child");
}

trackAcpProcess(childPid);
child.on("exit", () => untrackAcpProcess(childPid));

let asyncFinalizerDone = false;

// Simulate a coordinated shutdown finalizer that does asynchronous work.
// The ACP teardown must run *after* this finalizer completes, so the
// child is still killed but the async work is not preempted.
const program = Effect.gen(function* () {
  yield* Effect.never;
}).pipe(
  Effect.ensuring(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            asyncFinalizerDone = true;
            process.stdout.write("finalizer done\n");
            resolve();
          }, 150);
        }),
    ),
  ),
);

const teardown: Runtime.Teardown = (exit, onExit) => {
  if (!asyncFinalizerDone) {
    process.stderr.write("ACP teardown ran before coordinated shutdown finalizer\n");
  }
  killTrackedProcesses();
  process.stdout.write("teardown done\n");
  Runtime.defaultTeardown(exit, onExit);
};

process.stdout.write(`ready ${childPid}\n`);
NodeRuntime.runMain(program, { teardown });
