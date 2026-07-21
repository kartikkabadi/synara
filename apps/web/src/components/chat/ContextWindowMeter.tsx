import type {
  ProviderCompactionCapabilities,
  ThreadCompactionRuntimeStatus,
  ThreadCompactionSettings,
} from "@synara/contracts";
import { useState } from "react";
import {
  type ContextWindowSnapshot,
  deriveContextCompactionStatusLine,
  deriveContextWindowMeterDisplay,
  formatContextWindowTokens,
  formatCostUsd,
} from "~/lib/contextWindow";
import { disclosureChevronClassName } from "~/lib/disclosureMotion";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Spinner } from "../ui/spinner";

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  compaction?: ProviderCompactionCapabilities | null | undefined;
  compactionRuntimeStatus?: ThreadCompactionRuntimeStatus | null | undefined;
  cumulativeCostUsd?: number | null | undefined;
  activeWindowLabel?: string | null | undefined;
  pendingWindowLabel?: string | null | undefined;
  onCompactNow?: (() => void) | null | undefined;
  onUpdateCompactionSettings?: ((settings: ThreadCompactionSettings) => void) | null | undefined;
}) {
  const {
    usage,
    compaction,
    compactionRuntimeStatus,
    cumulativeCostUsd,
    activeWindowLabel,
    pendingWindowLabel,
    onCompactNow,
    onUpdateCompactionSettings,
  } = props;
  const display = deriveContextWindowMeterDisplay(usage);
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (display.normalizedPercentage / 100) * circumference;

  return (
    <Popover>
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
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="8"
                  cy="8"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-muted-foreground/25 dark:text-muted-foreground/40"
                />
                <circle
                  cx="8"
                  cy="8"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="text-primary transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none dark:text-[var(--color-text-foreground)]"
                />
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <ContextWindowMeterDetails
          usage={usage}
          compaction={compaction}
          compactionRuntimeStatus={compactionRuntimeStatus}
          cumulativeCostUsd={cumulativeCostUsd}
          activeWindowLabel={activeWindowLabel}
          pendingWindowLabel={pendingWindowLabel}
          onCompactNow={onCompactNow}
          onUpdateCompactionSettings={onUpdateCompactionSettings}
        />
      </PopoverPopup>
    </Popover>
  );
}

export function ContextWindowMeterDetails(props: {
  usage: ContextWindowSnapshot;
  compaction?: ProviderCompactionCapabilities | null | undefined;
  compactionRuntimeStatus?: ThreadCompactionRuntimeStatus | null | undefined;
  cumulativeCostUsd?: number | null | undefined;
  activeWindowLabel?: string | null | undefined;
  pendingWindowLabel?: string | null | undefined;
  onCompactNow?: (() => void) | null | undefined;
  onUpdateCompactionSettings?: ((settings: ThreadCompactionSettings) => void) | null | undefined;
}) {
  const {
    usage,
    compaction,
    compactionRuntimeStatus,
    cumulativeCostUsd,
    activeWindowLabel,
    pendingWindowLabel,
    onCompactNow,
    onUpdateCompactionSettings,
  } = props;
  const display = deriveContextWindowMeterDisplay(usage);
  const compactionStatusLine = deriveContextCompactionStatusLine({
    compaction,
    runtimeStatus: compactionRuntimeStatus,
  });
  return (
    <div className="space-y-1.5 leading-tight">
      <div className="text-[11px] font-medium text-muted-foreground">Context window</div>
      {pendingWindowLabel ? (
        <div className="text-xs text-muted-foreground">
          Current session: {activeWindowLabel ?? "Unknown"}
        </div>
      ) : null}
      {display.usedPercentageLabel ? (
        <div className="whitespace-nowrap text-xs font-medium text-foreground">
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
        <div className="text-sm text-foreground">{display.tokenUsageLabel} tokens used so far</div>
      )}
      {usage.maxTokens !== null ? (
        <div className="text-xs text-muted-foreground">
          Model window: {formatContextWindowTokens(usage.maxTokens)} tokens
        </div>
      ) : null}
      {pendingWindowLabel ? (
        <div className="text-xs text-muted-foreground">Next turn: {pendingWindowLabel}</div>
      ) : null}
      {(usage.totalProcessedTokens ?? null) !== null &&
      (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
        <div className="text-xs text-muted-foreground">
          Total processed: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)} tokens
        </div>
      ) : null}
      {compactionStatusLine?.kind === "in-progress" ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="h-3 w-3" />
          <span>Compacting context…</span>
        </div>
      ) : null}
      {compactionStatusLine?.kind === "error" ? (
        <div className="space-y-1 text-xs text-destructive">
          <div>{compactionStatusLine.reason}</div>
          {compactionStatusLine.retryable && onCompactNow ? (
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-xs text-foreground hover:bg-muted"
              onClick={onCompactNow}
            >
              Retry compaction
            </button>
          ) : null}
        </div>
      ) : null}
      {compactionStatusLine?.kind === "provider-auto" ? (
        <div className="text-xs text-muted-foreground">
          <div>Auto-compacts when context is nearly full.</div>
          {compactionStatusLine.triggerLabel ? (
            <div>{compactionStatusLine.triggerLabel}</div>
          ) : null}
        </div>
      ) : null}
      {compactionStatusLine?.kind === "synara-auto" ? (
        <div className="text-xs text-muted-foreground">
          <div>Synara will compact automatically.</div>
          {compactionStatusLine.triggerLabel ? (
            <div>{compactionStatusLine.triggerLabel}</div>
          ) : null}
        </div>
      ) : null}
      {compactionStatusLine?.kind === "manual" ? (
        onCompactNow ? (
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5 text-xs text-foreground hover:bg-muted"
            onClick={onCompactNow}
          >
            Compact now
          </button>
        ) : (
          <div className="text-xs text-muted-foreground">Compact now with /compact.</div>
        )
      ) : null}
      {compactionStatusLine?.kind === "unavailable" ? (
        <div className="text-xs text-muted-foreground">
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
        <div className="text-xs text-muted-foreground">
          Session cost: {formatCostUsd(cumulativeCostUsd)}
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
  const [autoEnabled, setAutoEnabled] = useState(compactionRuntimeStatus?.owner === "synara");
  const initialTrigger = compactionRuntimeStatus?.trigger;
  const [thresholdPercent, setThresholdPercent] = useState(
    initialTrigger?.kind === "percent" ? String(Math.round(initialTrigger.percent)) : "85",
  );
  const [cooldownSeconds, setCooldownSeconds] = useState("60");

  const commit = (next: { autoEnabled?: boolean; threshold?: string; cooldown?: string }) => {
    const enabled = next.autoEnabled ?? autoEnabled;
    const percent = Number.parseFloat(next.threshold ?? thresholdPercent);
    const cooldown = Number.parseInt(next.cooldown ?? cooldownSeconds, 10);
    onUpdateCompactionSettings({
      autoEnabled: enabled,
      ...(Number.isFinite(percent) && percent > 0 && percent <= 100
        ? { trigger: { kind: "percent", percent } }
        : {}),
      ...(Number.isInteger(cooldown) && cooldown >= 0 ? { cooldownSeconds: cooldown } : {}),
    });
  };

  return (
    <div className="space-y-1 border-border border-t pt-1.5">
      <button
        type="button"
        className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
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
      </button>
      <DisclosureRegion open={open}>
        <div className="space-y-1.5 pt-1 text-xs">
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <input
              type="checkbox"
              checked={autoEnabled}
              onChange={(event) => {
                setAutoEnabled(event.target.checked);
                commit({ autoEnabled: event.target.checked });
              }}
            />
            Enable Synara-managed auto-compaction
          </label>
          <label className="flex items-center justify-between gap-2 text-muted-foreground">
            Threshold (% used)
            <input
              type="number"
              min={1}
              max={100}
              className="w-14 rounded border border-border bg-transparent px-1 py-0.5 text-right text-foreground"
              value={thresholdPercent}
              disabled={!autoEnabled}
              onChange={(event) => setThresholdPercent(event.target.value)}
              onBlur={(event) => commit({ threshold: event.target.value })}
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-muted-foreground">
            Cooldown (seconds)
            <input
              type="number"
              min={0}
              className="w-14 rounded border border-border bg-transparent px-1 py-0.5 text-right text-foreground"
              value={cooldownSeconds}
              disabled={!autoEnabled}
              onChange={(event) => setCooldownSeconds(event.target.value)}
              onBlur={(event) => commit({ cooldown: event.target.value })}
            />
          </label>
        </div>
      </DisclosureRegion>
    </div>
  );
}
