import type {
  ProviderCompactionCapabilities,
  ThreadCompactionRuntimeStatus,
  ThreadCompactionSettings,
} from "@synara/contracts";
import {
  CONTEXT_WINDOW_METER_GEOMETRY,
  type ContextWindowSnapshot,
  contextWindowMeterSectorPath,
  deriveContextWindowMeterDisplay,
  deriveContextCompactionStatusLine,
  formatContextWindowTokens,
  formatCostUsd,
} from "~/lib/contextWindow";
import { useState } from "react";
import { useNowMs } from "~/hooks/useNowMs";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ClaudeCacheDetails } from "./ClaudeCacheDetails";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { disclosureChevronClassName } from "~/lib/disclosureMotion";

type ContextWindowMeterProps = {
  usage: ContextWindowSnapshot;
  compaction?: ProviderCompactionCapabilities | null | undefined;
  compactionRuntimeStatus?: ThreadCompactionRuntimeStatus | null | undefined;
  onCompactNow?: (() => void) | null | undefined;
  compactDisabledReason?: string | null | undefined;
  onUpdateCompactionSettings?: ((settings: ThreadCompactionSettings) => void) | null | undefined;
  cumulativeCostUsd?: number | null | undefined;
  activeWindowLabel?: string | null | undefined;
  pendingWindowLabel?: string | null | undefined;
  showClaudeCache?: boolean;
  onOpenChange?: (open: boolean) => void;
  compactAction?: {
    disabledReason: string | null;
    isSubmitting: boolean;
    onCompact: () => Promise<boolean>;
  };
};

export function ContextWindowMeter(props: ContextWindowMeterProps) {
  const { usage } = props;
  const [open, setOpen] = useState(false);
  const nowMs = useNowMs(open && usage.claudeCache != null, 10_000);
  const display = deriveContextWindowMeterDisplay(usage);
  // Never an empty dial once anything is used: a sliver keeps "some" distinct from "none".
  const sectorPath = contextWindowMeterSectorPath(
    display.normalizedPercentage > 0 ? Math.max(display.normalizedPercentage, 4) : 0,
  );

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        props.onOpenChange?.(nextOpen);
      }}
    >
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex shrink-0 items-center justify-center rounded-full p-0.5 transition-opacity hover:opacity-80"
            aria-label={display.ariaLabel}
          >
            <span className="relative flex h-4 w-4 items-center justify-center">
              <svg
                viewBox="0 0 16 16"
                className="absolute inset-0 h-full w-full"
                aria-hidden="true"
                data-context-window-meter-glyph=""
              >
                <circle
                  cx={CONTEXT_WINDOW_METER_GEOMETRY.center}
                  cy={CONTEXT_WINDOW_METER_GEOMETRY.center}
                  r={CONTEXT_WINDOW_METER_GEOMETRY.outlineRadius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  className="text-muted-foreground/45 dark:text-muted-foreground/55"
                />
                {/* The faint disc is the remaining window, so the sector reads as a share of it. */}
                <circle
                  cx={CONTEXT_WINDOW_METER_GEOMETRY.center}
                  cy={CONTEXT_WINDOW_METER_GEOMETRY.center}
                  r={CONTEXT_WINDOW_METER_GEOMETRY.pieRadius}
                  fill="currentColor"
                  className="text-muted-foreground/20 dark:text-muted-foreground/30"
                />
                {sectorPath ? (
                  <path
                    d={sectorPath}
                    fill="currentColor"
                    className="text-primary dark:text-[var(--color-text-foreground)]"
                  />
                ) : null}
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <ContextWindowMeterDetails {...props} nowMs={nowMs} />
      </PopoverPopup>
    </Popover>
  );
}

export function ContextWindowMeterDetails(props: ContextWindowMeterProps & { nowMs?: number }) {
  const {
    usage,
    cumulativeCostUsd,
    activeWindowLabel,
    pendingWindowLabel,
    compaction,
    compactionRuntimeStatus,
    onCompactNow,
    onUpdateCompactionSettings,
  } = props;
  const display = deriveContextWindowMeterDisplay(usage);
  const compactionStatusLine = deriveContextCompactionStatusLine({
    compaction,
    runtimeStatus: compactionRuntimeStatus,
  });
  const nowMs = props.nowMs ?? 0;
  return (
    <div className="space-y-1.5 leading-tight">
      <div className="text-ui-sm font-medium text-muted-foreground">Context window</div>
      {pendingWindowLabel ? (
        <div className="text-ui leading-snug text-muted-foreground">
          Current session: {activeWindowLabel ?? "Unknown"}
        </div>
      ) : null}
      {display.usedPercentageLabel ? (
        <div className="whitespace-nowrap text-ui leading-snug font-medium text-foreground">
          <span>{display.usedPercentageLabel}</span>
          {display.hasReliableTokenRatio ? (
            <>
              <span className="mx-1">⋅</span>
              <span>{display.tokenUsageLabel}</span>
              <span>/</span>
              <span>{formatContextWindowTokens(usage.maxTokens)} context used</span>
            </>
          ) : (
            <span className="ml-1">context used</span>
          )}
        </div>
      ) : (
        <div className="text-ui leading-snug text-foreground">
          {display.tokenUsageLabel} tokens used so far
        </div>
      )}
      {usage.maxTokens !== null ? (
        <div className="text-ui leading-snug text-muted-foreground">
          Active context limit: {formatContextWindowTokens(usage.maxTokens)} tokens
        </div>
      ) : null}
      {props.showClaudeCache && activeWindowLabel ? (
        <div className="max-w-72 space-y-1 text-ui leading-snug text-muted-foreground">
          <div>Auto-compact target: {activeWindowLabel}</div>
          <p className="leading-relaxed">
            The session's auto-compact target can be lower than the model's supported window.
          </p>
        </div>
      ) : null}
      {pendingWindowLabel ? (
        <div className="text-ui leading-snug text-muted-foreground">
          Next turn: {pendingWindowLabel}
        </div>
      ) : null}
      {(usage.totalProcessedTokens ?? null) !== null &&
      (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
        <div className="text-ui leading-snug text-muted-foreground">
          {usage.tokenAccountingVersion === 1 ? "Estimated total processed" : "Total processed"}:{" "}
          {formatContextWindowTokens(usage.totalProcessedTokens ?? null)} tokens
        </div>
      ) : null}
      {compactionStatusLine?.kind === "in-progress" ? (
        <div className="flex items-center gap-1.5 text-ui-sm text-muted-foreground">
          <Spinner className="h-3 w-3" />
          <span>Compacting context…</span>
        </div>
      ) : null}
      {compactionStatusLine?.kind === "error" ? (
        <div className="space-y-1 text-ui-sm text-destructive">
          <div>{compactionStatusLine.reason}</div>
          {compactionStatusLine.retryable && onCompactNow && !props.compactAction ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={Boolean(props.compactDisabledReason)}
              onClick={onCompactNow}
            >
              Retry compaction
            </Button>
          ) : null}
        </div>
      ) : null}
      {compactionStatusLine?.kind === "provider-auto" ? (
        <div className="text-ui-sm text-muted-foreground">
          <div>Auto-compacts when context is nearly full.</div>
          {compactionStatusLine.triggerLabel ? (
            <div>{compactionStatusLine.triggerLabel}</div>
          ) : null}
        </div>
      ) : null}
      {compactionStatusLine?.kind === "synara-auto" ? (
        <div className="text-ui-sm text-muted-foreground">
          <div>Synara will compact automatically.</div>
          {compactionStatusLine.triggerLabel ? (
            <div>{compactionStatusLine.triggerLabel}</div>
          ) : null}
        </div>
      ) : null}
      {!props.compactAction &&
      onCompactNow &&
      compactionStatusLine?.kind !== "in-progress" &&
      compactionStatusLine?.kind !== "error" ? (
        <div className="space-y-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              Boolean(props.compactDisabledReason) ||
              compactionRuntimeStatus?.manualAvailability.available === false
            }
            onClick={onCompactNow}
          >
            Compact now
          </Button>
          {props.compactDisabledReason || compactionRuntimeStatus?.manualAvailability.reason ? (
            <p className="text-ui-sm text-muted-foreground">
              {props.compactDisabledReason ?? compactionRuntimeStatus?.manualAvailability.reason}
            </p>
          ) : null}
        </div>
      ) : !props.compactAction && compactionStatusLine?.kind === "manual" ? (
        <div className="text-ui-sm text-muted-foreground">Compact now with /compact.</div>
      ) : null}
      {compactionStatusLine?.kind === "unavailable" && !props.compactAction ? (
        <div className="text-ui-sm text-muted-foreground">
          Compaction unavailable for this provider.
        </div>
      ) : null}
      {onUpdateCompactionSettings &&
      compaction &&
      compaction.automatic.mode !== "native" &&
      compaction.manual.mode !== "unsupported" ? (
        <CompactionSettingsSection
          compactionRuntimeStatus={compactionRuntimeStatus}
          onUpdateCompactionSettings={onUpdateCompactionSettings}
        />
      ) : null}
      {cumulativeCostUsd !== null && cumulativeCostUsd !== undefined ? (
        <div className="text-ui leading-snug text-muted-foreground">
          Session cost: {formatCostUsd(cumulativeCostUsd)}
        </div>
      ) : null}
      {usage.claudeCache || props.showClaudeCache ? (
        <ClaudeCacheDetails observation={usage.claudeCache ?? undefined} nowMs={nowMs} />
      ) : null}
      {props.compactAction ? (
        <div className="max-w-72 space-y-1.5 border-t border-border/50 pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              props.compactAction.disabledReason !== null || props.compactAction.isSubmitting
            }
            onClick={() => {
              void props.compactAction?.onCompact();
            }}
          >
            {props.compactAction.isSubmitting ? "Starting compaction..." : "Compact now"}
          </Button>
          <p className="text-ui leading-relaxed text-muted-foreground">
            {props.compactAction.disabledReason ??
              "Compaction processes this conversation and consumes usage. Later turns use its summary."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
// Per-thread Synara-managed auto-compaction policy editor. Only rendered when
// the provider has no native auto-compaction but supports manual compaction.
function CompactionSettingsSection(props: {
  compactionRuntimeStatus?: ThreadCompactionRuntimeStatus | null | undefined;
  onUpdateCompactionSettings: (settings: ThreadCompactionSettings) => void;
}) {
  const { compactionRuntimeStatus, onUpdateCompactionSettings } = props;
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-1 border-border border-t pt-1.5">
      <Button
        variant="ghost"
        size="sm"
        type="button"
        className="flex items-center gap-1 text-ui-xs font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          viewBox="0 0 8 8"
          className={disclosureChevronClassName(open, "h-2 w-2")}
          aria-hidden="true"
        >
          <path d="M2 1l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        Compaction settings
      </Button>
      <DisclosureRegion open={open}>
        <CompactionSettingsFields
          key={JSON.stringify(
            compactionRuntimeStatus?.settings ?? {
              owner: compactionRuntimeStatus?.owner,
              trigger: compactionRuntimeStatus?.trigger,
            },
          )}
          compactionRuntimeStatus={compactionRuntimeStatus}
          onUpdateCompactionSettings={onUpdateCompactionSettings}
        />
      </DisclosureRegion>
    </div>
  );
}

function CompactionSettingsFields(props: {
  compactionRuntimeStatus?: ThreadCompactionRuntimeStatus | null | undefined;
  onUpdateCompactionSettings: (settings: ThreadCompactionSettings) => void;
}) {
  const { compactionRuntimeStatus, onUpdateCompactionSettings } = props;
  const savedSettings = compactionRuntimeStatus?.settings;
  const [autoEnabled, setAutoEnabled] = useState(
    savedSettings?.autoEnabled ?? compactionRuntimeStatus?.owner === "synara",
  );
  const initialTrigger = savedSettings?.trigger ?? compactionRuntimeStatus?.trigger;
  const [thresholdPercent, setThresholdPercent] = useState(
    initialTrigger?.kind === "percent" ? String(Math.round(initialTrigger.percent)) : "85",
  );
  const [cooldownSeconds, setCooldownSeconds] = useState(
    savedSettings?.cooldownSeconds === undefined ? "" : String(savedSettings.cooldownSeconds),
  );

  const commit = (next: { autoEnabled?: boolean; threshold?: string; cooldown?: string }) => {
    const enabled = next.autoEnabled ?? autoEnabled;
    const percent = Number.parseFloat(next.threshold ?? thresholdPercent);
    const cooldownText = next.cooldown ?? cooldownSeconds;
    const cooldown = Number(cooldownText);
    if (
      !Number.isFinite(percent) ||
      percent <= 0 ||
      percent > 100 ||
      (cooldownText.trim() !== "" && (!Number.isInteger(cooldown) || cooldown < 0))
    )
      return;
    onUpdateCompactionSettings({
      autoEnabled: enabled,
      trigger:
        next.threshold === undefined && initialTrigger && initialTrigger.kind !== "opaque"
          ? initialTrigger
          : { kind: "percent", percent },
      ...(cooldownText.trim() !== "" ? { cooldownSeconds: cooldown } : {}),
    });
  };

  return (
    <div className="space-y-1.5 pt-1 text-ui-sm">
      <label className="flex items-center gap-1.5 text-muted-foreground">
        <Checkbox
          checked={autoEnabled}
          onCheckedChange={(checked) => {
            setAutoEnabled(checked);
            commit({ autoEnabled: checked });
          }}
        />
        Enable Synara-managed auto-compaction
      </label>
      <label className="flex items-center justify-between gap-2 text-muted-foreground">
        Threshold (% used)
        <Input
          size="sm"
          type="number"
          min={1}
          max={100}
          className="w-20 text-right"
          value={thresholdPercent}
          disabled={!autoEnabled}
          onChange={(event) => setThresholdPercent(event.target.value)}
          onBlur={(event) => commit({ threshold: event.target.value })}
        />
      </label>
      <label className="flex items-center justify-between gap-2 text-muted-foreground">
        Cooldown (seconds)
        <Input
          size="sm"
          type="number"
          min={0}
          placeholder="Default"
          className="w-20 text-right"
          value={cooldownSeconds}
          disabled={!autoEnabled}
          onChange={(event) => setCooldownSeconds(event.target.value)}
          onBlur={(event) => commit({ cooldown: event.target.value })}
        />
      </label>
    </div>
  );
}
