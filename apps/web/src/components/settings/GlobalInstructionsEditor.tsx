import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SettingsRow } from "./SettingsPanelPrimitives";
import { ensureNativeApi } from "../../nativeApi";
import { serverGlobalInstructionsQueryOptions, serverQueryKeys } from "../../lib/serverReactQuery";

export function GlobalInstructionsEditor() {
  const globalInstructionsQuery = useQuery(serverGlobalInstructionsQueryOptions());
  const queryClient = useQueryClient();
  const [globalInstructionsDraft, setGlobalInstructionsDraft] = useState<string | undefined>();
  const globalInstructionsMutation = useMutation({
    mutationFn: async (contents: string) => {
      const api = ensureNativeApi();
      return api.server.updateGlobalInstructions({ contents });
    },
    onSuccess: (result) => {
      setGlobalInstructionsDraft(result.contents);
      queryClient.setQueryData(serverQueryKeys.globalInstructions(), result);
    },
  });
  const globalInstructions =
    globalInstructionsDraft ?? globalInstructionsQuery.data?.contents ?? "";
  const savedGlobalInstructions = globalInstructionsQuery.data?.contents ?? "";
  const globalInstructionsError = globalInstructionsQuery.error ?? globalInstructionsMutation.error;
  const globalInstructionsLoading =
    globalInstructionsQuery.isPending && globalInstructionsDraft === undefined;
  const globalInstructionsSaving = globalInstructionsMutation.isPending;
  return (
    <SettingsRow
      title="Global instructions content"
      description="Edit the optional guidance stored in this app’s data home. It is limited to 6,000 characters and can be saved while the setting above is off."
      status={
        globalInstructionsError
          ? globalInstructionsError instanceof Error
            ? globalInstructionsError.message
            : "Failed to load or save."
          : globalInstructionsLoading
            ? "Loading…"
            : globalInstructions !== savedGlobalInstructions
              ? "Unsaved changes"
              : "Saved"
      }
      control={
        <Button
          variant="outline"
          disabled={
            globalInstructionsLoading ||
            globalInstructionsSaving ||
            globalInstructions === savedGlobalInstructions
          }
          onClick={() => globalInstructionsMutation.mutate(globalInstructions)}
        >
          {globalInstructionsSaving ? "Saving…" : "Save"}
        </Button>
      }
    >
      <div className="mt-3 space-y-2">
        <Textarea
          value={globalInstructions}
          maxLength={6_000}
          disabled={globalInstructionsLoading || globalInstructionsSaving}
          onChange={(event) => setGlobalInstructionsDraft(event.target.value)}
          aria-label="Global SYNARA.md instructions content"
          placeholder="Add durable guidance for new or restarted agent sessions…"
        />
        <div className="text-right text-ui-xs text-muted-foreground">
          {globalInstructions.length.toLocaleString()} / 6,000 characters
        </div>
      </div>
    </SettingsRow>
  );
}
