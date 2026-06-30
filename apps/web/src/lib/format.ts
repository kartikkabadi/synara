/** Compact duration label for seconds (e.g. 45s, 12m, 1.5h). */
export function formatSecondsCompact(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
}
