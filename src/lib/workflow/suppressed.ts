/**
 * Counter for errors a run deliberately drops (#1504).
 *
 * Many catch sites in the run path swallow errors on purpose ("state tracking
 * errors shouldn't stop execution"). The policy stays; what this module adds
 * is the trace: each dropped error increments a per-run count by scope and
 * writes one debug line to an optional sink. `LogWriter` resets the counter at
 * `initialize()` and persists it into the run log at `finalize()`.
 *
 * The state is module-level on purpose: one process runs one `sequant run`
 * (the MCP server spawns runs as subprocesses), and the call sites have no
 * handle to the log writer, which may be absent when logging is disabled.
 */

export type SuppressedScope =
  "state" | "progress" | "cleanup" | "platform" | "other";

export interface SuppressedCounts {
  total: number;
  byScope: Partial<Record<SuppressedScope, number>>;
}

type SuppressedSink = (line: string) => void;

let counts: SuppressedCounts = { total: 0, byScope: {} };
let sink: SuppressedSink | undefined;

/**
 * Record an error that the caller drops on purpose. Never throws: counting
 * comes first, and a failing sink or a hostile `err` is itself ignored.
 */
export function noteSuppressed(
  scope: SuppressedScope,
  err: unknown,
  context?: string,
): void {
  counts.total++;
  counts.byScope[scope] = (counts.byScope[scope] ?? 0) + 1;
  if (!sink) return;
  try {
    const message = err instanceof Error ? err.message : String(err);
    sink(`suppressed[${scope}]${context ? ` ${context}` : ""}: ${message}`);
  } catch {
    // The trace is best-effort; the count above is already recorded.
    return;
  }
}

/** Start a new run: zero the counts and set (or clear) the debug-line sink. */
export function resetSuppressed(nextSink?: SuppressedSink): void {
  counts = { total: 0, byScope: {} };
  sink = nextSink;
}

/** A copy of the current run's counts. */
export function suppressedCounts(): SuppressedCounts {
  return { total: counts.total, byScope: { ...counts.byScope } };
}
