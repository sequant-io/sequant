/**
 * Event-replay harness for #647 AC-3 residual probe.
 *
 * Reads the original 2026-05-14 #504/#505 run log — the workload that
 * produced the motivating duplicate-header transcript — and replays each
 * phase start/complete/failed event through the *real* TTYRenderer wired
 * to a real `log-update` instance bound to a VirtualTerminal. Because the
 * renderer's event-line writes are what scroll the live frame off the top
 * (Mechanism #1), replaying the exact event sequence reproduces the bug
 * conditions deterministically without spending claude budget.
 *
 * Inputs:
 *   - /Users/tony/Projects/sequant/.sequant/logs/run-2026-05-14T03-16-47-*.json
 *
 * Outputs:
 *   - stdout: scrollback header count + per-event trace
 *   - replay-report.txt in this directory
 *
 * Run from project root:
 *   npx tsx docs/incidents/647/captures/2026-05-19/replay-504-505.ts
 *
 * Limitations:
 *   - No subprocess stdout writes between phase events. If the production
 *     residual is caused by claude subprocess output landing outside the
 *     pause/resume brackets, this harness will NOT see it.
 *   - Synthetic wallclock: events fire back-to-back (no inter-event delay).
 *     For Mechanism #1, what matters is the SEQUENCE of (event-line write →
 *     redraw) cycles, not the wall-clock spacing between them.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { TTYRenderer } from "../../../../../src/lib/cli-ui/run-renderer.js";
import { createTerminalHarness } from "../../../../../src/lib/cli-ui/scrollback-harness.js";
import type { ProgressEvent } from "../../../../../src/lib/cli-ui/run-renderer-types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RUN_LOG = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  ".sequant",
  "logs",
  "run-2026-05-14T03-16-47-1c43f889-6e0f-46fa-a892-3041227b8704.json",
);
const REPORT_PATH = join(__dirname, "replay-report.txt");

// ---------------------------------------------------------------------------
// Parse the run log into a chronologically ordered ProgressEvent stream.
// Each phase entry produces two events: start at startTime, complete/failed
// at endTime. Sort by timestamp to interleave the two issues like the
// original parallel run did.
// ---------------------------------------------------------------------------

interface RunLogPhase {
  phase: string;
  issueNumber: number;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  status: string;
}
interface RunLogIssue {
  issueNumber: number;
  phases: RunLogPhase[];
  prNumber?: number;
  prUrl?: string;
}
interface RunLog {
  startTime: string;
  endTime: string;
  issues: RunLogIssue[];
}

const log: RunLog = JSON.parse(readFileSync(RUN_LOG, "utf8"));

interface TimedEvent {
  t: number; // ms since run start
  event: ProgressEvent;
}

const runStart = Date.parse(log.startTime);
const timedEvents: TimedEvent[] = [];

// Track per-issue per-phase iteration counter (1-based) so retried phases
// get the correct `iteration` field.
const iterCounter = new Map<string, number>(); // key: `${issue}:${phase}`

for (const issue of log.issues) {
  for (const ph of issue.phases) {
    const key = `${ph.issueNumber}:${ph.phase}`;
    const iter = (iterCounter.get(key) ?? 0) + 1;
    iterCounter.set(key, iter);

    timedEvents.push({
      t: Date.parse(ph.startTime) - runStart,
      event: {
        issue: ph.issueNumber,
        phase: ph.phase,
        event: "start",
        iteration: iter > 1 ? iter : undefined,
      },
    });
    timedEvents.push({
      t: Date.parse(ph.endTime) - runStart,
      event: {
        issue: ph.issueNumber,
        phase: ph.phase,
        event: ph.status === "success" ? "complete" : "failed",
        durationSeconds: ph.durationSeconds,
        iteration: iter > 1 ? iter : undefined,
        error:
          ph.status === "success"
            ? undefined
            : "Replay-synthesized failure from run log",
      },
    });
  }
}

timedEvents.sort((a, b) => a.t - b.t);

// ---------------------------------------------------------------------------
// Set up the harness. Match the conditions that produced the original
// transcript: small-ish terminal (the motivating run was probably ~24-40 rows)
// to force the live frame off-screen as event lines accumulate. We pick 24×100
// to match the existing scrollback-harness.test.ts AC-2 reproduction.
// ---------------------------------------------------------------------------

const VT_ROWS = 24;
const VT_COLS = 100;

const harness = createTerminalHarness({ rows: VT_ROWS, cols: VT_COLS });
const renderer = new TTYRenderer({
  stdoutWrite: harness.stdoutWrite,
  stderrWrite: harness.stderrWrite,
  logUpdateInstance: harness.logUpdate,
  isTTY: true,
  noColor: true,
  columns: VT_COLS,
  rows: VT_ROWS,
  liveTickMs: 0,
  noSignalListeners: true,
  now: () => 1_700_000_000_000,
  wallClock: () => new Date(2026, 4, 14, 0, 0, 0, 0),
});

// ---------------------------------------------------------------------------
// Replay.
// ---------------------------------------------------------------------------

for (const issue of log.issues) {
  renderer.registerIssue({ issueNumber: issue.issueNumber });
}

for (const te of timedEvents) {
  renderer.onEvent(te.event);
}

// Apply PR information for any issue that produced one (mirrors what the
// real run did at completion).
for (const issue of log.issues) {
  if (issue.prNumber && issue.prUrl) {
    renderer.setPullRequest(issue.issueNumber, issue.prNumber, issue.prUrl);
  }
}

// Don't dispose: dispose clears the live frame, which would erase the
// (single, expected) header from the visible viewport. We measure the
// state a real user sees mid-/post-run.

// ---------------------------------------------------------------------------
// Measure + report.
// ---------------------------------------------------------------------------

const totalHeaders = harness.vt.countOccurrences(/SEQUANT WORKFLOW · /);
const scrollbackHeaderRows = harness.vt.scrollback.filter((l) =>
  l.includes("SEQUANT WORKFLOW · "),
).length;
const visibleHeaderRows = harness.vt
  .getVisibleLines()
  .filter((l) => l.includes("SEQUANT WORKFLOW · ")).length;
const scrollbackRowCount = harness.vt.scrollback.length;

const lines: string[] = [];
lines.push("# Event-replay forensic — #647 AC-3 probe via #504/#505 timeline");
lines.push("");
lines.push("## Source");
lines.push(`  Run log: ${RUN_LOG.replace(__dirname + "/", "")}`);
lines.push(`  Run start: ${log.startTime}`);
lines.push(`  Run end: ${log.endTime}`);
lines.push(
  `  Issues: ${log.issues.map((i) => `#${i.issueNumber}`).join(", ")}`,
);
lines.push(`  Phases replayed: ${timedEvents.length / 2}`);
lines.push(`  Total events emitted: ${timedEvents.length}`);
lines.push("");
lines.push("## Harness");
lines.push(`  VT: ${VT_COLS} × ${VT_ROWS}`);
lines.push("  log-update: real `createLogUpdate` bound to VT stream");
lines.push("  Renderer: real TTYRenderer (no test stub)");
lines.push("");
lines.push("## Header occurrence counts");
lines.push(`  Total (visible + scrollback): ${totalHeaders}`);
lines.push(
  `  Scrollback rows containing header: ${scrollbackHeaderRows}` +
    ` (of ${scrollbackRowCount} total scrollback rows)`,
);
lines.push(`  Visible rows containing header: ${visibleHeaderRows}`);
lines.push("");
lines.push("## Sanity");
lines.push(
  `  Scrollback populated: ${scrollbackRowCount > 0 ? "YES" : "NO (trivial pass — bug had no opportunity to fire)"}`,
);
lines.push("");

if (scrollbackRowCount === 0) {
  lines.push("## Verdict");
  lines.push("  INCONCLUSIVE — same failure mode as the live capture.");
  lines.push(
    "  Live frame never overflowed the 24-row viewport during replay.",
  );
  lines.push(
    "  Re-run with smaller VT_ROWS (e.g. 12) or extended event flood.",
  );
} else if (scrollbackHeaderRows <= 1) {
  lines.push("## Verdict");
  lines.push(
    "  PASS — scrollback was populated but ≤1 header survives. The renderer +",
  );
  lines.push(
    "  log-update + file sink combination correctly erases prior frames.",
  );
  lines.push(
    "  This is strong evidence that #647 AC-3 has no real residual under",
  );
  lines.push(
    "  the original #504/#505 workload pattern. Consider closing #647.",
  );
} else {
  lines.push("## Verdict");
  lines.push(
    `  FAIL — ${scrollbackHeaderRows} duplicate headers in scrollback under the`,
  );
  lines.push("  exact #504/#505 event timeline. The bug reproduces post-#665.");
  lines.push("  AC-3 fix is needed. Examine the captured scrollback below");
  lines.push("  for clustering patterns:");
  lines.push("");
  lines.push("  Affected scrollback rows:");
  const affected = harness.vt.scrollback
    .map((line, idx) => ({ idx, line }))
    .filter(({ line }) => line.includes("SEQUANT WORKFLOW · "));
  for (const { idx, line } of affected.slice(0, 10)) {
    lines.push(
      `    s${idx.toString().padStart(3, "0")} | ${line.substring(0, 100)}`,
    );
  }
  if (affected.length > 10) {
    lines.push(`    ... and ${affected.length - 10} more`);
  }
}
lines.push("");
lines.push("## Final visible viewport (last 5 rows)");
for (const row of harness.vt.getVisibleLines().slice(-5)) {
  lines.push(`  | ${row}`);
}
lines.push("");

renderer.dispose();

const report = lines.join("\n");
writeFileSync(REPORT_PATH, report);
console.log(report);
console.log(`\n[report also written to ${REPORT_PATH}]`);
