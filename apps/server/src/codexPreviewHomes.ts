// Shared by HTTP previews and per-file grants so both honor the same enabled accounts.
import { Effect, Option } from "effect";
import {
  codexConfiguredHomePathsFromSettings,
  enabledCodexProviderInstanceIdsFromSettings,
  type CodexGeneratedImageHomeCandidate,
} from "./codexGeneratedImages";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { ServerSettingsService } from "./serverSettings";

export const codexPreviewHomes = Effect.gen(function* () {
  // Dedicated per-account Codex homes anchor their own generated-image roots;
  // resolve them from settings when the service can be read so those images
  // stay servable. When settings are unavailable, configured roots cannot be
  // trusted, but auth-fresh live session homes remain eligible.
  const settingsService = yield* Effect.serviceOption(ServerSettingsService);
  const codexSettingsScope = Option.isSome(settingsService)
    ? yield* settingsService.value.getSettings.pipe(
        Effect.map((settings) => ({
          configuredHomePaths: codexConfiguredHomePathsFromSettings(settings),
          enabledProviderInstanceIds: enabledCodexProviderInstanceIdsFromSettings(settings),
        })),
        Effect.catch(() => Effect.succeed(null)),
      )
    : null;
  const adapterRegistry = yield* Effect.serviceOption(ProviderAdapterRegistry);
  const liveCodexHomePaths = Option.isSome(adapterRegistry)
    ? yield* adapterRegistry.value.getByProvider("codex").pipe(
        Effect.flatMap((adapter) =>
          adapter.listGeneratedImageHomePaths
            ? adapter.listGeneratedImageHomePaths(
                codexSettingsScope
                  ? {
                      enabledProviderInstanceIds: codexSettingsScope.enabledProviderInstanceIds,
                    }
                  : undefined,
              )
            : Effect.succeed<readonly CodexGeneratedImageHomeCandidate[]>([]),
        ),
        Effect.catch(() => Effect.succeed<readonly CodexGeneratedImageHomeCandidate[]>([])),
      )
    : [];
  const codexHomePaths: readonly CodexGeneratedImageHomeCandidate[] = [
    ...(codexSettingsScope?.configuredHomePaths ?? []),
    ...liveCodexHomePaths,
  ];

  return codexHomePaths;
});
