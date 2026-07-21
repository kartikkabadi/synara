// FILE: abortErrorClassification.ts
// Purpose: Classifies provider error messages caused by intentional aborts/cancellations.
// Layer: Server provider utilities
// Exports: isAbortLikeProviderErrorMessage

// Cancellation phrasings emitted by provider runtimes and fetch/AbortController
// stacks when a turn is intentionally stopped. Matched case-insensitively
// against the trimmed message.
const ABORT_LIKE_ERROR_MESSAGE_PATTERNS: ReadonlyArray<RegExp> = [
  /^aborted\.?$/,
  /\babort ?error\b/,
  /\b(?:operation|request|signal|session|turn|run) (?:was |is |has been )?aborted\b/,
  /\baborted by (?:the )?user\b/,
  /\b(?:interrupted|cancell?ed) by (?:the )?user\b/,
  /\buser (?:interrupted|cancell?ed|aborted)\b/,
  /write_stdin failed: stdin is closed/,
];

/**
 * True when a provider `runtime.error` / `session.exited` message describes an
 * intentional abort or cancellation (user stop, AbortController) rather than a
 * genuine provider failure. Such turns settle as `interrupted`, not `error`.
 */
export function isAbortLikeProviderErrorMessage(message: string | null | undefined): boolean {
  const normalized = message?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return ABORT_LIKE_ERROR_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
}
