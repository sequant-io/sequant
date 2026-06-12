#!/usr/bin/env npx tsx
/**
 * Privacy-safe demo harness for the boxed Ink TUI run grid (#695).
 *
 * Mounts the REAL renderer (`renderTui()` → `src/ui/tui/App.tsx`,
 * IssueBox/Header/Spinner) against a FAKE, time-driven snapshot provider — no
 * orchestrator, no worktree, no GitHub, no local paths. A single fictional
 * issue **#64: Add user authentication** progresses through `spec → exec → qa`
 * over ~10s, then the run completes with a green success rollup, so a VHS
 * recording captures the live spinner, ticking elapsed timer, in-place phase
 * glyphs, and the "now" activity line of the current branded TUI.
 *
 * Privacy (AC-2): the synthetic snapshot exposes **zero real-machine data** —
 * fictional issue #64, fictional branch `feature/64-user-auth`, a generic
 * relative log path, base branch `main` (no SHA), and no repo/org/usernames.
 * Nothing here is read from the environment.
 *
 * Run it in a real terminal (a TTY is required; VHS provides one):
 *   npx tsx scripts/demo/run-grid-demo.ts
 *
 * Recorded by `docs/assets/run-grid.tape` into `docs/assets/run-grid.gif`,
 * which is embedded near the top of the README.
 */

import { loadTui } from "../../src/ui/tui/load.js";
import type {
  RunSnapshot,
  IssueRuntimeState,
  PhaseRuntimeState,
  CurrentPhaseState,
} from "../../src/lib/workflow/run-state.js";

/** One scheduled phase: when it begins (ms from run start) and how long it runs. */
interface PhasePlan {
  name: string;
  start: number;
  dur: number;
}

/** The fictional run: one issue, three phases, all privacy-safe literals. */
const ISSUE = {
  number: 64,
  title: "Add user authentication",
  branch: "feature/64-user-auth",
} as const;

/**
 * A short "queued" lead-in before spec starts. The TUI mounts on a calm queued
 * box rather than popping in already mid-spec, so the entrance eases in instead
 * of jumping. Phase starts are offset past this window.
 */
const QUEUED_MS = 700;

const PHASES: PhasePlan[] = [
  { name: "spec", start: QUEUED_MS, dur: 2400 },
  { name: "exec", start: QUEUED_MS + 2400, dur: 4000 },
  { name: "qa", start: QUEUED_MS + 6400, dur: 2400 },
];

/** Per-phase rotating "now" activity lines (generic, no real-machine data). */
const NOW_LINES: Record<string, string[]> = {
  spec: [
    "reading issue + acceptance criteria",
    "drafting implementation plan · 5 ACs",
    "posting plan comment to the issue",
  ],
  exec: [
    "creating worktree · feature/64-user-auth",
    "implementing auth middleware",
    "writing tests · 12 added",
    "npm test · 47 passed",
    "committing to the feature branch",
  ],
  qa: [
    "full build + test suite",
    "re-checking AC 4/5 independently",
    "type safety · 0 issues · AC 5/5 MET",
  ],
};

const RUN_BASE = Date.now();
const LAST_END = Math.max(...PHASES.map((p) => p.start + p.dur));
/** Hold the green success state visible before unmounting. */
const DONE_AT = LAST_END + 1600;

/** Pick the activity line for the current point within a phase. */
function rotate(lines: string[], elapsedInPhase: number, dur: number): string {
  if (lines.length === 0) return "working…";
  const step = dur / lines.length;
  const idx = Math.min(lines.length - 1, Math.floor(elapsedInPhase / step));
  return lines[idx];
}

/** Build the fictional issue's runtime state for a given elapsed time. */
function buildIssue(elapsed: number): IssueRuntimeState {
  const phases: PhaseRuntimeState[] = PHASES.map((p) => {
    const end = p.start + p.dur;
    if (elapsed >= end) {
      return {
        name: p.name,
        status: "done",
        startedAt: new Date(RUN_BASE + p.start),
        elapsedMs: p.dur,
      };
    }
    if (elapsed >= p.start) {
      return {
        name: p.name,
        status: "running",
        startedAt: new Date(RUN_BASE + p.start),
      };
    }
    return { name: p.name, status: "pending" };
  });

  const active = PHASES.find(
    (p) => elapsed >= p.start && elapsed < p.start + p.dur,
  );

  let currentPhase: CurrentPhaseState | undefined;
  if (active) {
    const elapsedInPhase = elapsed - active.start;
    currentPhase = {
      name: active.name,
      startedAt: new Date(RUN_BASE + active.start),
      // Stagger the activity stamp slightly behind "now" so it ticks visibly.
      lastActivityAt: new Date(RUN_BASE + elapsed - 600),
      nowLine: rotate(NOW_LINES[active.name] ?? [], elapsedInPhase, active.dur),
      logPath: `.sequant/logs/${ISSUE.number}-${active.name}.log`,
    };
  }

  const status: IssueRuntimeState["status"] =
    elapsed < QUEUED_MS ? "queued" : elapsed >= LAST_END ? "passed" : "running";

  // Issue clock starts when the first phase begins (after the queued lead-in),
  // so the header elapsed timer reads from spec, not from the queued window.
  const startedAt =
    elapsed >= QUEUED_MS ? new Date(RUN_BASE + QUEUED_MS) : undefined;

  return {
    number: ISSUE.number,
    title: ISSUE.title,
    branch: ISSUE.branch,
    status,
    phases,
    currentPhase,
    startedAt,
    completedAt:
      elapsed >= LAST_END ? new Date(RUN_BASE + LAST_END) : undefined,
  };
}

/** Pull-based snapshot consumed by the TUI's 10 Hz poll loop. */
function getSnapshot(): RunSnapshot {
  const elapsed = Date.now() - RUN_BASE;
  return {
    config: {
      concurrency: 1,
      baseBranch: "main",
      qualityLoop: true,
    },
    issues: [buildIssue(elapsed)],
    done: elapsed >= DONE_AT,
    capturedAt: new Date(),
  };
}

async function main(): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write(
      "run-grid-demo: not a TTY — the boxed TUI needs a terminal " +
        "(VHS provides one). Run via `vhs docs/assets/run-grid.tape`.\n",
    );
  }

  const { renderTui } = await loadTui();
  const handle = renderTui({ getSnapshot });

  // Safety net: force-unmount shortly after the fake run completes, in case the
  // poll loop's `done` transition is missed.
  const safety = setTimeout(() => handle.unmount(), DONE_AT + 1500);
  await handle.done;
  clearTimeout(safety);
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(String(err?.stack ?? err) + "\n");
    process.exit(1);
  },
);
