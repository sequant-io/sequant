import { useEffect, useState, type JSX } from "react";
import { Text } from "ink";

/**
 * Per-issue elapsed timer. Owns its own interval so tick-driven re-renders
 * are scoped to this leaf component and do not propagate to `IssueBox`.
 */
export function ElapsedTimer({ startedAt }: { startedAt?: Date }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!startedAt) return <Text>--:--</Text>;
  const secs = Math.max(0, Math.floor((now - startedAt.getTime()) / 1000));
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
