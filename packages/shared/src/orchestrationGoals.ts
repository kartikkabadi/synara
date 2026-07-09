import { ORCHESTRATION_GOAL_COMPLETION_SENTINEL } from "@t3tools/contracts";

/** Remove the internal completion marker from the user-visible assistant reply. */
export function stripGoalCompletionSentinel(text: string): {
  readonly text: string;
  readonly hadSentinel: boolean;
} {
  const lines = text.trimEnd().split(/\r?\n/);
  const finalLine = lines.at(-1)?.trim() ?? "";
  const normalizedFinalLine = finalLine
    .replace(/^```[a-zA-Z]*\n?|\n?```$/g, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
  if (normalizedFinalLine !== ORCHESTRATION_GOAL_COMPLETION_SENTINEL) {
    return { text, hadSentinel: false };
  }
  return {
    text: lines.slice(0, -1).join("\n").trimEnd(),
    hadSentinel: true,
  };
}
