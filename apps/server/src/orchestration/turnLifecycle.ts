import type { OrchestrationSession } from "@synara/contracts";

type TurnState = "pending" | "running" | "completed" | "interrupted" | "error";

/**
 * Returns the terminal turn state implied by a session update, or `null` while
 * the provider can still deliver the authoritative terminal event.
 */
export function settleTurnStateFromSession(
  session: Pick<OrchestrationSession, "status" | "activeTurnId" | "lastError">,
  existingState: TurnState,
): Exclude<TurnState, "pending" | "running"> | null {
  if (session.activeTurnId !== null && session.status !== "error") {
    return null;
  }

  switch (session.status) {
    case "error":
      return "error";
    case "interrupted":
      return "interrupted";
    case "stopped":
      // A stopped session that is carrying a runtime error settles the open
      // turn as an error so downstream consumers (e.g. `/loop` consecutive-error
      // accounting) see a terminal error rather than an interruption.
      return session.lastError !== null ? "error" : "interrupted";
    case "ready":
      return existingState === "error"
        ? "error"
        : existingState === "interrupted"
          ? "interrupted"
          : "completed";
    case "idle":
    case "starting":
    case "running":
      return null;
  }
}
