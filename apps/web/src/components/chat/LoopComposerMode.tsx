// FILE: LoopComposerMode.tsx
// Purpose: Composer-mode UI for guided `/loop` setup and Edit Loop — header, budget picker, hints.
// Layer: Web chat composer surface
// The outer composer shell stays unchanged; this renders inside the existing surface
// and receives the existing editor as a slot rather than duplicating composer controls.

import { useEffect, useState, type ReactNode } from "react";
import { LoopIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ChevronDownIcon } from "~/lib/icons";
import {
  LOOP_BUDGET_COUNT_ERROR,
  LOOP_BUDGET_DURATION_ERROR,
  LOOP_COUNT_PRESETS,
  LOOP_DEFAULT_HARD_CAP,
  LOOP_DURATION_PRESETS_SECONDS,
  LOOP_UNSUPPORTED_CONTEXT_MESSAGE,
  formatLoopBudgetChoiceLabel,
  validateLoopBudgetChoice,
  type LoopBudgetChoice,
  type LoopComposerMode as LoopComposerModeState,
} from "./useLoopComposerMode";
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

function LoopBudgetPicker(props: {
  budget: LoopBudgetChoice;
  disabled: boolean;
  onChange: (budget: LoopBudgetChoice) => void;
}) {
  const [custom, setCustom] = useState<CustomEntry>({ kind: "none" });

  const commitCustom = (entry: CustomEntry) => {
    if (entry.kind === "count") {
      const turns = Number(entry.raw);
      props.onChange({ kind: "count", turns: Number.isFinite(turns) ? Math.trunc(turns) : 0 });
    } else if (entry.kind === "duration") {
      const value = Number(entry.raw);
      const seconds = Number.isFinite(value)
        ? Math.trunc(value) * (entry.unit === "hours" ? 3600 : 60)
        : 0;
      props.onChange({ kind: "duration", seconds });
    }
  };

  const budgetError = validateLoopBudgetChoice(props.budget);

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
          {formatLoopBudgetChoiceLabel(props.budget)}
          <ChevronDownIcon className="size-3" />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end" side="bottom">
          {LOOP_COUNT_PRESETS.map((turns) => (
            <MenuItem
              key={`count-${turns}`}
              onClick={() => {
                setCustom({ kind: "none" });
                props.onChange({ kind: "count", turns });
              }}
            >
              {turns} turns
            </MenuItem>
          ))}
          <MenuSeparator />
          {LOOP_DURATION_PRESETS_SECONDS.map((seconds) => (
            <MenuItem
              key={`duration-${seconds}`}
              onClick={() => {
                setCustom({ kind: "none" });
                props.onChange({ kind: "duration", seconds });
              }}
            >
              {formatDurationPreset(seconds)}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem
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
          </MenuItem>
          <MenuItem
            onClick={() => {
              setCustom({ kind: "count", raw: "" });
            }}
          >
            Custom turns…
          </MenuItem>
          <MenuItem
            onClick={() => {
              setCustom({ kind: "duration", raw: "", unit: "minutes" });
            }}
          >
            Custom duration…
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
      {custom.kind === "count" ? (
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          Turns:
          <input
            type="number"
            min={1}
            max={100}
            value={custom.raw}
            autoFocus
            onChange={(event) => {
              const next: CustomEntry = { kind: "count", raw: event.target.value };
              setCustom(next);
              commitCustom(next);
            }}
            className="h-6 w-16 rounded border border-border bg-transparent px-1.5 text-foreground"
          />
        </label>
      ) : null}
      {custom.kind === "duration" ? (
        <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          Duration:
          <input
            type="number"
            min={1}
            value={custom.raw}
            autoFocus
            onChange={(event) => {
              const next: CustomEntry = { ...custom, raw: event.target.value };
              setCustom(next);
              commitCustom(next);
            }}
            className="h-6 w-16 rounded border border-border bg-transparent px-1.5 text-foreground"
          />
          <select
            value={custom.unit}
            onChange={(event) => {
              const next: CustomEntry = {
                ...custom,
                unit: event.target.value === "hours" ? "hours" : "minutes",
              };
              setCustom(next);
              commitCustom(next);
            }}
            className="h-6 rounded border border-border bg-transparent px-1 text-foreground"
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
        </label>
      ) : null}
      {budgetError ? (
        <p className="text-[11px] text-destructive" role="alert">
          {budgetError === LOOP_BUDGET_COUNT_ERROR
            ? LOOP_BUDGET_COUNT_ERROR
            : LOOP_BUDGET_DURATION_ERROR}
        </p>
      ) : null}
    </div>
  );
}

export function LoopComposerModeHeader(props: {
  mode: Exclude<LoopComposerModeState, { kind: "closed" }>;
  isDispatching: boolean;
  isLoopTurnRunning: boolean;
  inlineError: string | null;
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
      <div className="flex min-h-9 items-center justify-between gap-2 border-border/60 border-b px-3 py-1.5">
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
        <p className="px-3 pt-1.5 text-[11px] text-muted-foreground/70">
          Changes apply after the current turn.
        </p>
      ) : null}
      {props.isUnsupportedContext ? (
        <p className="px-3 pt-1.5 text-[11px] text-warning" role="alert">
          {LOOP_UNSUPPORTED_CONTEXT_MESSAGE}
        </p>
      ) : props.inlineError ? (
        <p className="px-3 pt-1.5 text-[11px] text-destructive" role="alert">
          {props.inlineError}
        </p>
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
        ? "Starting loop…"
        : props.mode.kind === "edit"
          ? "Save changes"
          : "Start loop"}
    </Button>
  );
}

/**
 * Guided Loop setup / Edit Loop composer mode (sections 4 and 6).
 *
 * Renders the Loop header (icon + budget picker), inline validation, the
 * existing editor slot with an expanded objective area, and the `Esc to
 * cancel` hint. Footer controls stay owned by the composer; the send CTA is
 * swapped via `LoopComposerModeCta`.
 */
export function LoopComposerMode(props: {
  mode: Exclude<LoopComposerModeState, { kind: "closed" }>;
  isDispatching: boolean;
  isLoopTurnRunning: boolean;
  inlineError: string | null;
  isUnsupportedContext: boolean;
  onBudgetChange: (budget: LoopBudgetChoice) => void;
  editorSlot: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col", props.className)}>
      <LoopComposerModeHeader
        mode={props.mode}
        isDispatching={props.isDispatching}
        isLoopTurnRunning={props.isLoopTurnRunning}
        inlineError={props.inlineError}
        isUnsupportedContext={props.isUnsupportedContext}
        onBudgetChange={props.onBudgetChange}
      />
      <div className="min-h-[112px]">{props.editorSlot}</div>
    </div>
  );
}

export function LoopComposerModeCancelHint() {
  return <p className="pt-1 text-center text-[10.5px] text-muted-foreground/50">Esc to cancel</p>;
}
