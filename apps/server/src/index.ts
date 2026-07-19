import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";

import { CliConfig, synaraCli } from "./main";
import { OpenLive } from "./open";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json" with { type: "json" };
import { ServerLive } from "./effectServer";
import { NetService } from "@synara/shared/Net";
import { FetchHttpClient } from "effect/unstable/http";
import { killTrackedProcesses } from "./provider/acp/acpProcessCleanup.ts";

const RuntimeLayer = Layer.empty.pipe(
  Layer.provideMerge(CliConfig.layer),
  Layer.provideMerge(ServerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

const acpTeardown: Runtime.Teardown = (exit, onExit) => {
  // The ACP child is spawned outside of Effect's async finalizer path,
  // so kill it synchronously before the runtime calls process.exit.
  killTrackedProcesses();
  Runtime.defaultTeardown(exit, onExit);
};

Command.run(synaraCli, { version })
  .pipe(Effect.provide(RuntimeLayer))
  .pipe((program) => NodeRuntime.runMain(program, { teardown: acpTeardown }));
