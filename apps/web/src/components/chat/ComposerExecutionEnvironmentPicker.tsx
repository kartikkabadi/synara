// FILE: ComposerExecutionEnvironmentPicker.tsx
// Purpose: Composer picker choosing where a new thread executes — Local or a
// remote SSH execution environment plus its remote workspace root.
// Layer: Chat composer presentation
// Depends on: server.listEnvironments query, thread execution environment store.

import type {
  ExecutionEnvironmentDescriptor,
  ExecutionProfile,
  ProviderKind,
  ThreadId,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { GlobeIcon } from "~/lib/icons";
import { serverEnvironmentsQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import {
  type ThreadEnvironmentSelection,
  useThreadExecutionEnvironmentStore,
} from "~/threadExecutionEnvironmentStore";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { PickerTriggerButton } from "./PickerTriggerButton";

function isRemoteSelectable(
  descriptor: ExecutionEnvironmentDescriptor,
  providerKind: ProviderKind,
): boolean {
  return (
    providerKind === "codex" &&
    descriptor.runtime?.runtimeType === "ssh-process" &&
    descriptor.capabilities.providerKinds.includes(providerKind)
  );
}

const OPTION_ROW_CLASS_NAME =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui-sm hover:bg-[var(--color-background-button-secondary-hover)] disabled:cursor-not-allowed disabled:opacity-50";

export function ComposerExecutionEnvironmentPicker(props: {
  threadId: ThreadId;
  providerKind: ProviderKind;
  /** Selection is thread-start only; lock the picker once the thread has started. */
  locked: boolean;
  executionProfile?: ExecutionProfile;
  hasSession: boolean;
  compact?: boolean;
  hideLabel?: boolean;
}) {
  const { threadId, providerKind, locked, executionProfile, hasSession, compact, hideLabel } =
    props;
  const environmentsQuery = useQuery(serverEnvironmentsQueryOptions());
  const environments = environmentsQuery.data?.environments ?? [];
  const draftSelection = useThreadExecutionEnvironmentStore(
    (state) => state.selectionByThreadId[threadId] ?? null,
  );
  const lastUsedSelection = useThreadExecutionEnvironmentStore((state) => state.lastUsedSelection);
  const setThreadEnvironmentSelection = useThreadExecutionEnvironmentStore(
    (state) => state.setThreadEnvironmentSelection,
  );

  const selectableEnvironments = environments.filter((descriptor) =>
    isRemoteSelectable(descriptor, providerKind),
  );
  const unsupportedEnvironments = environments.filter(
    (descriptor) => !isRemoteSelectable(descriptor, providerKind),
  );
  const activeSelection: ThreadEnvironmentSelection | null = hasSession
    ? executionProfile
      ? {
          ...executionProfile,
          environmentLabel:
            environments.find(
              (environment) => environment.environmentId === executionProfile.environmentId,
            )?.label ?? executionProfile.environmentId,
        }
      : null
    : draftSelection;
  const selectionAvailable =
    !activeSelection ||
    selectableEnvironments.some(
      (environment) => environment.environmentId === activeSelection.environmentId,
    );
  const selectionError = environmentsQuery.isError
    ? "Could not load execution environments. Try again."
    : activeSelection && providerKind !== "codex"
      ? "Remote execution supports Codex only. Choose Codex or This machine."
      : activeSelection && !environmentsQuery.isPending && !selectionAvailable
        ? "This environment is unavailable. Choose another environment or This machine."
        : null;

  const selectEnvironment = (descriptor: ExecutionEnvironmentDescriptor) => {
    const remembered: ThreadEnvironmentSelection | null =
      lastUsedSelection?.environmentId === descriptor.environmentId ? lastUsedSelection : null;
    setThreadEnvironmentSelection(threadId, {
      environmentId: descriptor.environmentId,
      environmentLabel: descriptor.label,
      remoteWorkspaceRoot:
        (activeSelection?.environmentId === descriptor.environmentId
          ? activeSelection.remoteWorkspaceRoot
          : remembered?.remoteWorkspaceRoot) ?? "",
    });
  };

  // The branch tools trigger already reads "Local"; use "This machine" here so
  // the two composer buttons keep distinct accessible names.
  const triggerLabel = activeSelection ? activeSelection.environmentLabel : "This machine";

  return (
    <Popover>
      <PopoverTrigger
        render={
          <PickerTriggerButton
            icon={<GlobeIcon aria-hidden="true" className="size-3.5" />}
            label={triggerLabel}
            {...(compact !== undefined ? { compact } : {})}
            {...(hideLabel !== undefined ? { hideLabel } : {})}
            disabled={locked}
            className={selectionError ? "text-destructive" : undefined}
            title={
              locked
                ? `Execution environment is locked after the thread starts (${triggerLabel})`
                : (selectionError ?? "Choose where this thread executes")
            }
            aria-label={`Execution environment: ${triggerLabel}`}
          />
        }
      />
      <PopoverPopup align="start" className="w-72">
        <div className="flex flex-col gap-0.5">
          <Button
            variant="ghost"
            disabled={locked}
            className={OPTION_ROW_CLASS_NAME}
            onClick={() => setThreadEnvironmentSelection(threadId, null)}
          >
            <span className={cn("flex-1 truncate", activeSelection ? undefined : "font-medium")}>
              Local
            </span>
            {activeSelection ? null : <span className="text-muted-foreground">Selected</span>}
          </Button>
          {selectableEnvironments.map((descriptor) => {
            const isSelected = activeSelection?.environmentId === descriptor.environmentId;
            return (
              <Button
                key={descriptor.environmentId}
                variant="ghost"
                disabled={locked}
                className={OPTION_ROW_CLASS_NAME}
                onClick={() => selectEnvironment(descriptor)}
              >
                <span className={cn("flex-1 truncate", isSelected ? "font-medium" : undefined)}>
                  {descriptor.label}
                </span>
                {isSelected ? <span className="text-muted-foreground">Selected</span> : null}
              </Button>
            );
          })}
          {unsupportedEnvironments.map((descriptor) => (
            <Button
              key={descriptor.environmentId}
              variant="ghost"
              className={OPTION_ROW_CLASS_NAME}
              disabled
              title={
                descriptor.runtime?.runtimeType === "ssh-process"
                  ? `Not configured for provider "${providerKind}"`
                  : "Only SSH process environments support remote execution"
              }
            >
              <span className="flex-1 truncate">{descriptor.label}</span>
              <span className="text-muted-foreground">Unsupported</span>
            </Button>
          ))}
          {environmentsQuery.isPending ? (
            <p className="px-2 py-1.5 text-ui-sm text-muted-foreground">Loading environments…</p>
          ) : null}
          {selectionError ? (
            <p role="alert" className="px-2 py-1.5 text-ui-sm text-destructive">
              {selectionError}
            </p>
          ) : null}
          {!environmentsQuery.isPending &&
          !environmentsQuery.isError &&
          environments.length === 0 ? (
            <p className="px-2 py-1.5 text-ui-sm text-muted-foreground">
              No remote environments yet.
            </p>
          ) : null}
          <DisclosureRegion open={activeSelection !== null} contentClassName="px-2 pt-2 pb-1">
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-ui-sm font-medium text-muted-foreground">
                Remote workspace root
              </span>
              <Input
                disabled={locked}
                value={activeSelection?.remoteWorkspaceRoot ?? ""}
                placeholder="/absolute/path/on/remote/host"
                onChange={(event) => {
                  if (!activeSelection) {
                    return;
                  }
                  setThreadEnvironmentSelection(threadId, {
                    ...activeSelection,
                    remoteWorkspaceRoot: event.target.value,
                  });
                }}
              />
            </label>
          </DisclosureRegion>
          <Link
            to="/settings"
            search={{ section: "environments" }}
            className="px-2 pt-1.5 text-ui-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            Manage environments
          </Link>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
