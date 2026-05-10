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
 * Format a wall-clock timestamp as `HH:MM:SS`. Used by the non-TTY renderer.
 */
export function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
