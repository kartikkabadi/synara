// FILE: LoopComposerMode.tsx
// Purpose: Composer-mode UI for guided `/loop` setup and Edit Loop — header, budget picker, hints.
// Layer: Web chat composer surface
// The outer composer shell stays unchanged; this renders inside the existing surface
// and receives the existing editor as a slot rather than duplicating composer controls.

import { useEffect, useState } from "react";
import { LoopIcon } from "~/lib/icons";
import { Button } from "../ui/button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ChevronDownIcon } from "~/lib/icons";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { LOOP_DEFAULT_HARD_CAP } from "@synara/contracts";
import {
  LOOP_COUNT_PRESETS,
  LOOP_DURATION_PRESETS_SECONDS,
  LOOP_UNSUPPORTED_CONTEXT_MESSAGE,
  formatLoopBudgetChoiceLabel,
  type LoopBudgetChoice,
} from "~/lib/loop";
import { type LoopComposerMode as LoopComposerModeState } from "./useLoopComposerMode";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";

function formatDurationPreset(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

type CustomEntry =
  | { kind: "none" }
  | { kind: "count"; raw: string }
  | { kind: "duration"; raw: string; unit: "minutes" | "hours" };

export function loopBudgetRadioValue(budget: LoopBudgetChoice, custom: CustomEntry): string {
  if (custom.kind === "count") return "custom-count";
  if (custom.kind === "duration") return "custom-duration";
  if (budget.kind === "until-stopped") return "until-stopped";
  if (budget.kind === "count") {
    return (LOOP_COUNT_PRESETS as readonly number[]).includes(budget.turns)
      ? `count-${budget.turns}`
      : "custom-count";
  }
  return (LOOP_DURATION_PRESETS_SECONDS as readonly number[]).includes(budget.seconds)
    ? `duration-${budget.seconds}`
    : "custom-duration";
}

export function LoopBudgetPicker(props: {
  budget: LoopBudgetChoice;
  disabled: boolean;
  onChange: (budget: LoopBudgetChoice) => void;
}) {
  const [custom, setCustom] = useState<CustomEntry>({ kind: "none" });

  // Commits happen on Enter/blur only so half-typed values never dispatch.
  const commitCustom = (entry: CustomEntry) => {
    if (entry.kind === "count") {
      const turns = Number(entry.raw);
      props.onChange({
        kind: "count",
        turns: Number.isFinite(turns) ? Math.trunc(turns) : 0,
      });
    } else if (entry.kind === "duration") {
      const value = Number(entry.raw);
      const seconds = Number.isFinite(value)
        ? Math.trunc(value) * (entry.unit === "hours" ? 3600 : 60)
        : 0;
      props.onChange({ kind: "duration", seconds });
    }
  };

  const radioValue = loopBudgetRadioValue(props.budget, custom);
  const triggerLabel =
    custom.kind !== "none" && custom.raw.trim().length === 0
      ? custom.kind === "count"
        ? "Custom turns…"
        : "Custom duration…"
      : formatLoopBudgetChoiceLabel(props.budget);

  return (
    <div className="flex flex-col items-end gap-1">
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={props.disabled}
              className="h-6 shrink-0 gap-1 px-2 text-[11px] font-normal text-muted-foreground hover:text-foreground"
            />
          }
        >
          {triggerLabel}
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end" side="bottom">
          <MenuGroup>
            <MenuGroupLabel>Stop after</MenuGroupLabel>
            <MenuRadioGroup value={radioValue}>
              {LOOP_COUNT_PRESETS.map((turns) => (
                <MenuRadioItem
                  key={`count-${turns}`}
                  value={`count-${turns}`}
                  onClick={() => {
                    setCustom({ kind: "none" });
                    props.onChange({ kind: "count", turns });
                  }}
                >
                  {turns} turns
                </MenuRadioItem>
              ))}
              <MenuSeparator />
              {LOOP_DURATION_PRESETS_SECONDS.map((seconds) => (
                <MenuRadioItem
                  key={`duration-${seconds}`}
                  value={`duration-${seconds}`}
                  onClick={() => {
                    setCustom({ kind: "none" });
                    props.onChange({ kind: "duration", seconds });
                  }}
                >
                  {formatDurationPreset(seconds)}
                </MenuRadioItem>
              ))}
              <MenuSeparator />
              <MenuRadioItem
                value="until-stopped"
                onClick={() => {
                  setCustom({ kind: "none" });
                  props.onChange({ kind: "until-stopped" });
                }}
              >
                <span className="flex flex-col items-start">
                  <span>Until stopped</span>
                  <span className="text-[10.5px] text-muted-foreground/60">
                    Safety limit: {LOOP_DEFAULT_HARD_CAP} turns
                  </span>
                </span>
              </MenuRadioItem>
              <MenuRadioItem
                closeOnClick={false}
                value="custom-count"
                onClick={() => {
                  setCustom({
                    kind: "count",
                    raw: props.budget.kind === "count" ? String(props.budget.turns) : "",
                  });
                }}
              >
                Custom turns…
              </MenuRadioItem>
              <MenuRadioItem
                closeOnClick={false}
                value="custom-duration"
                onClick={() => {
                  setCustom({ kind: "duration", raw: "", unit: "minutes" });
                }}
              >
                Custom duration…
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
          {radioValue === "custom-count" || radioValue === "custom-duration" ? (
            <>
              <MenuSeparator />
              {/* stopPropagation keeps menu typeahead from stealing keystrokes. */}
              <div
                className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground"
                onKeyDown={(event) => {
                  if (event.key !== "Escape") event.stopPropagation();
                  if (event.key === "Enter") {
                    commitCustom(custom);
                  }
                }}
              >
                {radioValue === "custom-count" ? (
                  <label className="flex items-center gap-1.5">
                    Turns:
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={custom.kind === "count" ? custom.raw : ""}
                      autoFocus
                      onChange={(event) => {
                        setCustom({ kind: "count", raw: event.target.value });
                      }}
                      onBlur={() => commitCustom(custom)}
                      className="h-6 w-16 rounded border border-border bg-transparent px-1.5 text-foreground"
                    />
                  </label>
                ) : (
                  <label className="flex items-center gap-1.5">
                    Duration:
                    <input
                      type="number"
                      min={1}
                      value={custom.kind === "duration" ? custom.raw : ""}
                      autoFocus
                      onChange={(event) => {
                        setCustom((previous) => ({
                          kind: "duration",
                          raw: event.target.value,
                          unit: previous.kind === "duration" ? previous.unit : "minutes",
                        }));
                      }}
                      onBlur={() => commitCustom(custom)}
                      className="h-6 w-16 rounded border border-border bg-transparent px-1.5 text-foreground"
                    />
                  </label>
                )}
                {radioValue === "custom-duration" ? (
                  <Select
                    value={custom.kind === "duration" ? custom.unit : "minutes"}
                    onValueChange={(unit) => {
                      setCustom((previous) => {
                        const next: CustomEntry = {
                          kind: "duration",
                          raw: previous.kind === "duration" ? previous.raw : "",
                          unit: unit === "hours" ? "hours" : "minutes",
                        };
                        commitCustom(next);
                        return next;
                      });
                    }}
                  >
                    <SelectTrigger aria-label="Duration unit" className="h-6 px-1.5 text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="minutes">minutes</SelectItem>
                      <SelectItem value="hours">hours</SelectItem>
                    </SelectPopup>
                  </Select>
                ) : null}
              </div>
            </>
          ) : null}
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  );
}

export function LoopComposerModeHeader(props: {
  mode: Exclude<LoopComposerModeState, { kind: "closed" }>;
  isDispatching: boolean;
  isLoopTurnRunning: boolean;
  note: string | null;
  error: string | null;
  isUnsupportedContext: boolean;
  onBudgetChange: (budget: LoopBudgetChoice) => void;
}) {
  const isEdit = props.mode.kind === "edit";
  // The header mounts and unmounts with the composer mode; toggling `open`
  // after mount lets the shared 220 ms disclosure expand actually play.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(true);
  }, []);
  return (
    <DisclosureRegion open={open}>
      <div className="flex min-h-[38px] items-center justify-between gap-2 border-border/60 border-b px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-foreground/80">
          <LoopIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {isEdit ? "Edit loop" : "Loop"}
        </span>
        <LoopBudgetPicker
          budget={props.mode.budget}
          disabled={props.isDispatching}
          onChange={props.onBudgetChange}
        />
      </div>
      {isEdit && props.isLoopTurnRunning ? (
        <p className="px-3 py-1.5 text-[11px] text-muted-foreground/70">
          Changes apply after the current turn.
        </p>
      ) : null}
      {props.isUnsupportedContext ? (
        <p className="px-3 pt-1.5 pb-1 text-[11px] text-warning" role="alert">
          {LOOP_UNSUPPORTED_CONTEXT_MESSAGE}
        </p>
      ) : props.error ? (
        <p className="px-3 pt-1.5 pb-1 text-[11px] text-destructive" role="alert">
          {props.error}
        </p>
      ) : props.note ? (
        <p className="px-3 pt-1.5 pb-1 text-[11px] text-muted-foreground">{props.note}</p>
      ) : null}
    </DisclosureRegion>
  );
}

export function LoopComposerModeCta(props: {
  mode: Exclude<LoopComposerModeState, { kind: "closed" }>;
  isDispatching: boolean;
  startDisabled: boolean;
}) {
  return (
    <Button
      type="submit"
      size="sm"
      className="h-9 rounded-full px-4 sm:h-8"
      disabled={props.startDisabled}
    >
      {props.isDispatching
        ? props.mode.kind === "edit"
          ? "Saving…"
          : "Starting loop…"
        : props.mode.kind === "edit"
          ? "Save changes"
          : "Start loop"}
    </Button>
  );
}
