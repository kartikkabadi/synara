// FILE: ComposerInputBanners.tsx
// Purpose: Picks which banner (if any) renders inside the composer surface — a plan
// follow-up or automation setup prompt. Pending approvals and AskUserQuestion prompts
// render as detached cards above the composer (see ComposerPendingApprovalPanel /
// ComposerPendingUserInputPanel), not here. Centralizes the precedence and the shared
// banner chrome so callers pass data, not layout.
// Layer: Chat composer UI
// Exports: ComposerInputBanners

import { type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { Thread } from "../../types";
import { ComposerAutomationSetupBanner } from "./ComposerAutomationSetupBanner";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { isLoopRuntimeRailVisible, LoopRuntimeRail } from "./loop/LoopRuntimeRail";
import { COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME } from "./composerPickerStyles";

interface ComposerInputBannersProps {
  // Drop the rounded top when rows are stacked above the composer so the banner sits
  // flush under them.
  roundedTopReset: boolean;
  // `id` keys the banner so it remounts when the proposed plan changes.
  planFollowUp: { id: string; title: string | null } | null;
  // Setup-mode control while gathering an automation's task/schedule (the exchange
  // itself renders as bubbles in the transcript).
  automationSetup: { onCancel: () => void } | null;
  thread: Thread | null | undefined;
  onStopLoopAfterTurn: () => void;
  onStopLoopNow: () => void;
  onEditLoop: () => void;
}

export function ComposerInputBanners({
  roundedTopReset,
  planFollowUp,
  automationSetup,
  thread,
  onStopLoopAfterTurn,
  onStopLoopNow,
  onEditLoop,
}: ComposerInputBannersProps) {
  const loop = thread?.loop;
  const banners: ReactNode[] = [];
  // Actionable blocker-resolution controls (plan follow-up, automation setup)
  // take visual precedence over the passive loop status banner.
  if (planFollowUp) {
    banners.push(
      <ComposerPlanFollowUpBanner key={planFollowUp.id} planTitle={planFollowUp.title} />,
    );
  }
  if (automationSetup) {
    banners.push(
      <ComposerAutomationSetupBanner key="automation" onCancel={automationSetup.onCancel} />,
    );
  }
  if (loop != null && isLoopRuntimeRailVisible(loop, thread?.latestTurn)) {
    banners.push(
      <LoopRuntimeRail
        key="loop"
        hasPendingApprovals={thread?.hasPendingApprovals === true}
        hasPendingUserInput={thread?.hasPendingUserInput === true}
        interactionMode={thread?.interactionMode ?? "default"}
        latestTurn={thread?.latestTurn ?? null}
        loop={loop}
        onEditLoop={onEditLoop}
        onStopAfterTurn={onStopLoopAfterTurn}
        onStopNow={onStopLoopNow}
      />,
    );
  }

  if (banners.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        COMPOSER_INPUT_SURFACE_BANNER_CLASS_NAME,
        // Stacked banners separate with an internal divider instead of each
        // banner carrying its own chrome.
        "divide-y divide-border/50",
        roundedTopReset && "!rounded-t-none",
      )}
    >
      {banners}
    </div>
  );
}
