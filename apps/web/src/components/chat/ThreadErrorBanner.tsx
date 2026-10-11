// FILE: ThreadErrorBanner.tsx
// Purpose: Presents runtime errors and persistent turn failures with recovery actions.
// Layer: Chat status presentation
// Exports: ThreadErrorBanner
//
// Live session errors sit above the transcript; durable turn failures reuse
// the same banner inside the timeline. Threads off screen still toast live
// session errors via useThreadErrorToast.

import { isProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import { useId, useLayoutEffect, useRef, useState } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { CopyTextButton } from "../ui/copyTextButton";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { IconButton } from "../ui/icon-button";
import { CircleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { presentThreadError } from "./threadErrorPresentation";
import { useRateLimitSecondsLeft, type RateLimitStatus } from "./RateLimitBanner";

type ThreadErrorBannerProps = {
  error: string | null;
  title?: string;
  onContinue?: () => void;
  /** Only supplied for an owned, unacknowledged composer snapshot. */
  onRetry?: () => void;
  rateLimitStatus?: RateLimitStatus | null;
  onChangeModel?: () => void;
  recoveryDisabled?: boolean;
  onDismiss?: () => void;
  /** Recovery action offered only when the error is a provider-delivery quarantine. */
  onUnblock?: () => void;
  unblocking?: boolean;
  className?: string;
};

export function ThreadErrorBanner(props: ThreadErrorBannerProps) {
  if (!props.error) return null;
  // A different failure starts collapsed, with fresh copy feedback.
  return <ThreadErrorBannerContent key={props.error} {...props} error={props.error} />;
}

function ThreadErrorBannerContent({
  error,
  title,
  onContinue,
  onRetry,
  rateLimitStatus,
  onChangeModel,
  recoveryDisabled,
  onDismiss,
  onUnblock,
  unblocking,
  className,
}: ThreadErrorBannerProps & { error: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const detailsId = useId();
  const presentation = presentThreadError(error);
  const secondsLeft = useRateLimitSecondsLeft(rateLimitStatus?.resetsAt);
  const retryBlocked =
    presentation.kind === "rate-limit" && rateLimitStatus?.status === "rejected" && secondsLeft > 0;
  const displayTitle = title ?? (presentation.kind === "generic" ? null : presentation.title);
  // Offer "Show details" only when the collapsed text actually hides something.
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node || expanded) return;
    const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [error, expanded]);
  const canUnblock = onUnblock !== undefined && isProviderDeliveryBlockDetail(error);
  return (
    <Alert variant={presentation.tone} className={cn("w-full max-w-[36rem] shadow-sm", className)}>
      <CircleAlertIcon />
      {displayTitle ? <AlertTitle>{displayTitle}</AlertTitle> : null}
      <AlertDescription className="min-w-0">
        {presentation.detail && presentation.kind !== "delivery-block" ? (
          <p>{presentation.detail}</p>
        ) : null}
        <p
          ref={textRef}
          id={detailsId}
          className={cn(
            "whitespace-pre-wrap [overflow-wrap:anywhere]",
            expanded ? "max-h-60 overflow-y-auto" : "line-clamp-3",
          )}
          tabIndex={expanded ? 0 : undefined}
        >
          {error}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {clamped || expanded ? (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => setExpanded((value) => !value)}
            >
              <DisclosureChevron open={expanded} />
              {expanded ? "Hide details" : "Show details"}
            </Button>
          ) : null}
          <CopyTextButton text={error} label="error" />
          {onRetry && !isProviderDeliveryBlockDetail(error) ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={recoveryDisabled || retryBlocked}
              onClick={onRetry}
            >
              {retryBlocked
                ? `Retry in ${secondsLeft < 60 ? `${secondsLeft}s` : `${Math.ceil(secondsLeft / 60)}m`}`
                : "Try again"}
            </Button>
          ) : null}
          {onContinue ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={recoveryDisabled}
              onClick={onContinue}
            >
              Continue task
            </Button>
          ) : null}
          {onContinue && onChangeModel ? (
            <Button size="xs" variant="outline" disabled={recoveryDisabled} onClick={onChangeModel}>
              Change model
            </Button>
          ) : null}
          {canUnblock ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={unblocking}
              onClick={() => onUnblock?.()}
            >
              {unblocking ? "Unblocking…" : "Unblock thread"}
            </Button>
          ) : null}
        </div>
      </AlertDescription>
      {onDismiss ? (
        <AlertAction className="items-center">
          <IconButton
            label="Dismiss error"
            className="size-6 text-destructive/60 hover:text-destructive sm:size-6"
            onClick={onDismiss}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
