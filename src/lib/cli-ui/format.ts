/**
 * Shared formatting helpers used by run-renderer and friends.
 *
 * Lives in cli-ui/ so renderer and heartbeat can share without depending on
 * the legacy phase-spinner module.
 */

/**
 * Format elapsed time in human-readable form.
 *
 * @example
 *   formatElapsedTime(5)       // "5s"
 *   formatElapsedTime(75)      // "1m 15s"
 *   formatElapsedTime(3725)    // "1h 2m"
 */
export function formatElapsedTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r > 0 ? `${m}m ${r}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const r = Math.floor((s % 3600) / 60);
  return r > 0 ? `${h}h ${r}m` : `${h}h`;
}

/**
 * Format a wall-clock timestamp as `HH:MM:SS`. Accepts a `Date` or an ISO
 * string; an unparsable string is returned unchanged.
 */
export function formatTimestamp(input: Date | string): string {
  const date = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return String(input);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}
