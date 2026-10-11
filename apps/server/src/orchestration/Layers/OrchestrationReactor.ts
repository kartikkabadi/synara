import { Effect, Layer } from "effect";

import {
  OrchestrationReactor,
  type OrchestrationReactorShape,
} from "../Services/OrchestrationReactor.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { CompactionReactor } from "../Services/CompactionReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { SidechatExpiryReactor } from "../Services/SidechatExpiryReactor.ts";
import { HubOutputReactor } from "../Services/HubOutputReactor.ts";
import { ThreadGitMetadataReactor } from "../Services/ThreadGitMetadataReactor.ts";

export const makeOrchestrationReactor = Effect.gen(function* () {
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const providerCommandReactor = yield* ProviderCommandReactor;
  const checkpointReactor = yield* CheckpointReactor;
  const compactionReactor = yield* CompactionReactor;
  const hubOutputReactor = yield* HubOutputReactor;
  const threadGitMetadataReactor = yield* ThreadGitMetadataReactor;
  const sidechatExpiryReactor = yield* SidechatExpiryReactor;

  const start: OrchestrationReactorShape["start"] = Effect.gen(function* () {
    yield* hubOutputReactor.start;
    yield* checkpointReactor.start;
    yield* compactionReactor.start;
    yield* threadGitMetadataReactor.start;
    yield* providerRuntimeIngestion.start;
    yield* sidechatExpiryReactor.start;
    // Install every runtime observer before provider command dispatch can
    // begin. Reverse-order finalization then drains provider commands first,
    // side-chat expiry second, runtime ingestion third, Git metadata fourth,
    // checkpoints fifth, and Hub output last.
    yield* providerCommandReactor.start;
  });

  return {
    start,
    reconcileSettledOpenTurns: providerRuntimeIngestion.reconcileSettledOpenTurns,
  } satisfies OrchestrationReactorShape;
});

export const OrchestrationReactorLive = Layer.effect(
  OrchestrationReactor,
  makeOrchestrationReactor,
);
