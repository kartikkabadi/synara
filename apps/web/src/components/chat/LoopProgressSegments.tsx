// FILE: LoopProgressSegments.tsx
// Purpose: Segmented progress strip for the `/loop` runtime rail and completion record.
// Layer: Chat composer UI
// The strip is decorative (`aria-hidden`); the host owns the ARIA progress attributes.

import { cn } from "~/lib/utils";
import type { LoopSemanticColor } from "./loopPresentation";

interface LoopProgressSegmentsProps {
  // Per-segment fill in [0, 1]; > 0 renders as filled.
  segments: number[];
  color: LoopSemanticColor;
  className?: string;
}

function filledSegmentClassName(color: LoopSemanticColor): string {
  switch (color) {
    case "waiting":
      return "bg-warning";
    case "error":
      return "bg-destructive";
    case "running":
    case "neutral":
      return "bg-foreground/80";
    default:
      return color satisfies never;
  }
}

export function LoopProgressSegments({ segments, color, className }: LoopProgressSegmentsProps) {
  if (segments.length === 0) {
    return null;
  }
  return (
    <div aria-hidden className={cn("flex w-full max-w-36 items-center gap-1", className)}>
      {segments.map((fill, index) => (
        <span
          // Position is the identity of a segment; the list never reorders.
          // oxlint-disable-next-line no-array-index-key
          key={index}
          className={cn(
            "h-1 flex-1 rounded-full transition-[background-color,opacity] duration-200 motion-reduce:transition-none",
            fill > 0 ? filledSegmentClassName(color) : "bg-muted/60",
          )}
        />
      ))}
    </div>
  );
}
