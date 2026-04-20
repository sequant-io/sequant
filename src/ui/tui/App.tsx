import { useEffect, useRef, useState, type JSX } from "react";
import { Box, useStdout } from "ink";
import type { RunSnapshot } from "../../lib/workflow/run-state.js";
import { Header } from "./Header.js";
import { IssueBox } from "./IssueBox.js";

const POLL_MS = 100; // 10 Hz

/**
 * Root TUI component.
 *
 * Polls `getSnapshot` at 10 Hz. A 1 Hz "now" tick keeps the
 * last-activity stamp moving even when the snapshot itself is unchanged.
 * When the snapshot reports `done`, the component stops polling and
 * invokes `onDone` so the caller can `unmount` the ink instance.
 */
export function App({
  getSnapshot,
  onDone,
}: {
  getSnapshot: () => RunSnapshot;
  onDone?: () => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<RunSnapshot>(() => getSnapshot());
  const [now, setNow] = useState(() => Date.now());
  const doneFired = useRef(false);
  const { stdout } = useStdout();

  // Snapshot poller (drives all state transitions).
  useEffect(() => {
    const id = setInterval(() => {
      const next = getSnapshot();
      setSnapshot(next);
      if (next.done && !doneFired.current) {
        doneFired.current = true;
        clearInterval(id);
        onDone?.();
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [getSnapshot, onDone]);

  // Coarse 1 Hz tick for the last-activity stamp.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const columns = stdout?.columns ?? 80;
  const boxWidth = Math.min(columns - 2, 100);

  return (
    <Box flexDirection="column">
      <Header snapshot={snapshot} />
      {snapshot.issues.map((issue, i) => (
        <IssueBox
          key={issue.number}
          state={issue}
          slot={i}
          width={boxWidth}
          now={now}
        />
      ))}
    </Box>
  );
}
