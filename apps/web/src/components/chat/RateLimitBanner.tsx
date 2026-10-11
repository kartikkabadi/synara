// FILE: RateLimitBanner.tsx
// Purpose: Derives and renders provider rate-limit warnings for the active chat.
// Layer: Chat status presentation
// Exports: RateLimitBanner and rate-limit derivation helpers.

import type { OrchestrationThreadActivity } from "@synara/contracts";
import { useEffect, useState } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { ChatColumnBannerFrame } from "./ChatColumnBannerFrame";

export type RateLimitStatus = {
  status: "rejected" | "allowed_warning";
  resetsAt?: string;
  utilization?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function deriveLatestRateLimitStatus(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): RateLimitStatus | null {
  const now = Date.now();
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (!activity || activity.kind !== "account.rate-limited") continue;
    const payload = asRecord(activity.payload);
    if (!payload) continue;
    const status = payload.status;
    if (status !== "rejected" && status !== "allowed_warning") continue;
    // If resetsAt is in the past, the limit has expired — skip
    if (typeof payload.resetsAt === "string") {
      const resetsAtMs = Date.parse(payload.resetsAt);
      if (!Number.isNaN(resetsAtMs) && resetsAtMs < now) continue;
    }
    return {
      status,
      ...(typeof payload.resetsAt === "string" ? { resetsAt: payload.resetsAt } : {}),
      ...(typeof payload.utilization === "number" ? { utilization: payload.utilization } : {}),
    };
  }
  return null;
}

export function rateLimitSecondsLeft(resetsAt: string | undefined, now: number): number {
  const ms = resetsAt ? Date.parse(resetsAt) : NaN;
  return Number.isFinite(ms) ? Math.max(0, Math.ceil((ms - now) / 1000)) : 0;
}

export function useRateLimitSecondsLeft(resetsAt: string | undefined): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (rateLimitSecondsLeft(resetsAt, Date.now()) === 0) return;
    const tick = () => {
      setNow(Date.now());
      if (rateLimitSecondsLeft(resetsAt, Date.now()) === 0) window.clearInterval(timer);
    };
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [resetsAt]);
  return rateLimitSecondsLeft(resetsAt, now);
}

function formatResetsAt(secondsLeft: number): string {
  if (secondsLeft === 0) return "";
  if (secondsLeft < 60) return ` Resets in ${secondsLeft}s.`;
  const minutesLeft = Math.ceil(secondsLeft / 60);
  return ` Resets in ${minutesLeft}m.`;
}

export const RateLimitBanner = function RateLimitBanner({
  onDismiss,
  rateLimitStatus,
}: {
  onDismiss?: () => void;
  rateLimitStatus: RateLimitStatus | null;
}) {
  const secondsLeft = useRateLimitSecondsLeft(rateLimitStatus?.resetsAt);
  if (!rateLimitStatus) return null;

  const { status, resetsAt, utilization } = rateLimitStatus;
  const isRejected = status === "rejected";
  if (resetsAt && Number.isFinite(Date.parse(resetsAt)) && secondsLeft === 0) return null;

  const message = isRejected
    ? `Rate limit reached.${formatResetsAt(secondsLeft)}`
    : `Approaching rate limit${utilization !== undefined ? ` (${Math.round(utilization * 100)}% used)` : ""}.${formatResetsAt(secondsLeft)}`;

  return (
    <ChatColumnBannerFrame>
      <Alert variant={isRejected ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertDescription>{message}</AlertDescription>
        {onDismiss ? (
          <AlertAction>
            <IconButton
              label="Dismiss rate limit status"
              title="Dismiss rate limit status"
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </IconButton>
          </AlertAction>
        ) : null}
      </Alert>
    </ChatColumnBannerFrame>
  );
};
