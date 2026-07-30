import { type JSX } from "react";
import { Text } from "ink";

/**
 * Per-issue elapsed timer. Reads the shared 1 Hz `now` that `App` already owns
 * and threads through `IssueBox`, rather than running its own interval: `App`'s
 * snapshot poller re-renders the whole tree every tick regardless, so a
 * per-issue clock bought no re-render scoping.
 *
 * When `completedAt` is set, the duration freezes at `completedAt - startedAt`.
 * This is computed in render (not by tearing down an interval on mount), so an
 * issue that transitions running → passed on the same mounted component freezes
 * at the transition without a remount.
 */
export function ElapsedTimer({
  startedAt,
  completedAt,
  now,
}: {
  startedAt?: Date;
  completedAt?: Date;
  now: number;
}): JSX.Element {
  if (!startedAt) return <Text>--:--</Text>;
  const end = completedAt?.getTime() ?? now;
  const secs = Math.max(0, Math.floor((end - startedAt.getTime()) / 1000));
  const mm = Math.floor(secs / 60)
    .toString()
    .padStart(2, "0");
  const ss = (secs % 60).toString().padStart(2, "0");
  return <Text>{`${mm}:${ss}`}</Text>;
}

/** Format an absolute timestamp as the "last activity Xs ago" stamp. */
export function formatSinceActivity(now: number, activityAt: Date): string {
  const secs = Math.max(0, Math.floor((now - activityAt.getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  return `${mm}m ${ss}s ago`;
}
