/**
 * Tests for the `sequant ready` gate engine (#683).
 *
 * Layer-1 deterministic wiring (issue Testing Strategy):
 * - AC-1: phase sequence dispatched is `qa → loop → qa …`.
 * - AC-3: policy-driven loop-exit thresholds + each guard-based exit.
 * - AC-3a: Non-Goal-touching gaps are report-only (excluded from the fix loop).
 * - AC-4: never merges; terminal state + structured report shape.
 * - AC-5: #534 class (zero-diff exec / null verdict) is never reported ready.
 * - AC-6: iteration + token-budget caps halt cleanly.
 */

import { describe, it, expect } from "vitest";
import {
  runReadyGate,
  isAtThreshold,
  parseNonGoals,
  gapTouchesNonGoals,
  formatReadyReport,
  type ReadyPhaseRunner,
  type RunReadyGateOptions,
  type ReadyResult,
} from "./ready-gate.js";
import type { PhaseResult } from "./types.js";
import type { QaVerdict } from "./run-log-schema.js";
import type { LoopProgressSnapshot } from "./qa-stagnation.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

function qaResult(verdict: QaVerdict | null, gaps: string[] = []): PhaseResult {
  return {
    phase: "qa",
    success: true,
    verdict: verdict ?? undefined,
    summary: { acMet: 0, acTotal: gaps.length, gaps, suggestions: [] },
  };
}

function loopResult(success = true): PhaseResult {
  return { phase: "loop", success };
}

interface RunCall {
  phase: "qa" | "loop";
  failedAcs?: string;
  promptContext?: string;
  fullQa?: boolean;
}

/**
 * Build a `runPhase` that returns scripted results in order and records every
 * call (phase + the config fields the engine sets). Lets a test assert the
 * dispatched sequence and the env-weight / scoping it implies.
 */
function scriptedRunner(queue: PhaseResult[]): {
  runPhase: ReadyPhaseRunner;
  calls: RunCall[];
} {
  const calls: RunCall[] = [];
  let i = 0;
  const runPhase: ReadyPhaseRunner = (phase, config) => {
    calls.push({
      phase,
      failedAcs: config.failedAcs,
      promptContext: config.promptContext,
      fullQa: config.fullQa,
    });
    const result = queue[i++];
    if (!result) throw new Error(`scriptedRunner exhausted at call ${i}`);
    return Promise.resolve(result);
  };
  return { runPhase, calls };
}

/**
 * A snapshot function that returns a *new* SHA on each call so
 * `compareLoopProgress` always reports progress. Use for the happy-path loop.
 */
function progressingSnapshots(): (cwd: string) => LoopProgressSnapshot {
  let n = 0;
  return () => ({ sha: `sha-${n++}`, dirty: [] });
}

/** A snapshot function that always returns the same state → LOOP_NO_DIFF. */
function stagnantSnapshots(): (cwd: string) => LoopProgressSnapshot {
  return () => ({ sha: "sha-fixed", dirty: [] });
}

function baseOpts(
  overrides: Partial<RunReadyGateOptions> &
    Pick<RunReadyGateOptions, "runPhase">,
): RunReadyGateOptions {
  return {
    issueNumber: 683,
    worktreePath: "/tmp/worktree-683",
    policy: "ac",
    maxIterations: 3,
    phaseTimeout: 1800,
    mcp: false,
    hasChangesFn: () => true,
    readTokensUsed: () => 0,
    snapshotFn: progressingSnapshots(),
    ...overrides,
  };
}

// ─── isAtThreshold (AC-3) ────────────────────────────────────────────────────

describe("isAtThreshold (AC-3)", () => {
  it("READY_FOR_MERGE always stops, both policies", () => {
    expect(isAtThreshold("ac", "READY_FOR_MERGE")).toBe(true);
    expect(isAtThreshold("a-plus", "READY_FOR_MERGE")).toBe(true);
  });

  it("ac stops at AC_MET_BUT_NOT_A_PLUS; a-plus does not", () => {
    expect(isAtThreshold("ac", "AC_MET_BUT_NOT_A_PLUS")).toBe(true);
    expect(isAtThreshold("a-plus", "AC_MET_BUT_NOT_A_PLUS")).toBe(false);
  });

  it("AC_NOT_MET and NEEDS_VERIFICATION never stop", () => {
    for (const p of ["ac", "a-plus"] as const) {
      expect(isAtThreshold(p, "AC_NOT_MET")).toBe(false);
      expect(isAtThreshold(p, "NEEDS_VERIFICATION")).toBe(false);
    }
  });
});

// ─── Non-Goals parsing + classification (AC-3a) ──────────────────────────────

describe("parseNonGoals (AC-3a)", () => {
  it("extracts bullet items under a Non-goals heading", () => {
    const body = [
      "## Problem",
      "Something.",
      "## Non-goals",
      "- `--from-pr` / reverse PR→issue resolution (follow-up).",
      "- Auto-merge of any kind.",
      "## Risks",
      "- Not a non-goal.",
    ].join("\n");
    const items = parseNonGoals(body);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("from-pr");
    expect(items[1]).toContain("Auto-merge");
  });

  it("returns [] when no Non-Goals section exists", () => {
    expect(parseNonGoals("## Problem\nNo non-goals here.")).toEqual([]);
    expect(parseNonGoals("")).toEqual([]);
  });

  it("recognizes 'Out of scope' heading variants", () => {
    const body = "### Out of scope\n- Reverse resolution support\n";
    expect(parseNonGoals(body)).toEqual(["Reverse resolution support"]);
  });
});

describe("gapTouchesNonGoals (AC-3a)", () => {
  const nonGoals = ["--from-pr / reverse PR→issue resolution (follow-up)"];

  it("flags a gap sharing >=2 significant tokens with a Non-Goal", () => {
    expect(gapTouchesNonGoals("add reverse resolution support", nonGoals)).toBe(
      true,
    );
  });

  it("does not flag an unrelated AC gap", () => {
    expect(gapTouchesNonGoals("fix the auth token validation", nonGoals)).toBe(
      false,
    );
  });

  it("returns false when there are no Non-Goals", () => {
    expect(gapTouchesNonGoals("anything", [])).toBe(false);
  });
});

// ─── runReadyGate: phase sequence + policy exits ─────────────────────────────

describe("runReadyGate — AC-1 phase sequence", () => {
  it("dispatches qa → loop → qa against the worktree", async () => {
    const { runPhase, calls } = scriptedRunner([
      qaResult("AC_NOT_MET", ["fix the validation bug"]),
      loopResult(),
      qaResult("AC_MET_BUT_NOT_A_PLUS"),
    ]);
    const result = await runReadyGate(baseOpts({ runPhase, policy: "ac" }));

    expect(calls.map((c) => c.phase)).toEqual(["qa", "loop", "qa"]);
    expect(result.iterations).toBe(2);
    expect(result.ready).toBe(true);
  });

  it("forces full-weight QA — every qa call sets fullQa", async () => {
    const { runPhase, calls } = scriptedRunner([
      qaResult("AC_NOT_MET", ["bug"]),
      loopResult(),
      qaResult("READY_FOR_MERGE"),
    ]);
    await runReadyGate(baseOpts({ runPhase, policy: "a-plus" }));

    for (const c of calls.filter((x) => x.phase === "qa")) {
      expect(c.fullQa).toBe(true);
    }
    // The loop phase is NOT full-QA (it has no git-trust skip to override).
    for (const c of calls.filter((x) => x.phase === "loop")) {
      expect(c.fullQa).toBeFalsy();
    }
  });
});

describe("runReadyGate — AC-3 policy thresholds", () => {
  it("ac stops at AC_MET_BUT_NOT_A_PLUS and does NOT auto-fix a quality gap", async () => {
    const { runPhase, calls } = scriptedRunner([
      qaResult("AC_MET_BUT_NOT_A_PLUS", ["polish: rename a variable"]),
    ]);
    const result = await runReadyGate(baseOpts({ runPhase, policy: "ac" }));

    expect(calls.map((c) => c.phase)).toEqual(["qa"]); // no loop ran
    expect(result.ready).toBe(true);
    expect(result.reason).toBe("AC_MET");
    expect(result.autoFixed).toEqual([]); // quality gap not fixed
    expect(result.remaining.map((r) => r.description)).toContain(
      "polish: rename a variable",
    );
    expect(result.issueStatus).toBe("waiting_for_human_merge");
  });

  it("a-plus loops past AC_MET_BUT_NOT_A_PLUS toward READY_FOR_MERGE", async () => {
    const { runPhase, calls } = scriptedRunner([
      qaResult("AC_MET_BUT_NOT_A_PLUS", ["polish: extract a helper"]),
      loopResult(),
      qaResult("READY_FOR_MERGE"),
    ]);
    const result = await runReadyGate(baseOpts({ runPhase, policy: "a-plus" }));

    expect(calls.map((c) => c.phase)).toEqual(["qa", "loop", "qa"]);
    expect(result.reason).toBe("READY_FOR_MERGE");
    expect(result.ready).toBe(true);
    expect(result.autoFixed).toContain("polish: extract a helper");
  });
});

// ─── runReadyGate: guard-based exits (AC-3 / AC-6) ───────────────────────────

describe("runReadyGate — AC-6 runaway protection", () => {
  it("halts at maxIterations when never converging (clean 'needs human')", async () => {
    const { runPhase, calls } = scriptedRunner([
      qaResult("AC_NOT_MET", ["bug a"]),
      loopResult(),
      qaResult("AC_NOT_MET", ["bug a still"]),
    ]);
    const result = await runReadyGate(
      baseOpts({ runPhase, policy: "a-plus", maxIterations: 2 }),
    );

    expect(result.reason).toBe("MAX_ITERATIONS");
    expect(result.ready).toBe(false);
    expect(result.iterations).toBe(2);
    // Did not run a third QA after the cap.
    expect(calls.filter((c) => c.phase === "qa")).toHaveLength(2);
    expect(result.issueStatus).toBe("blocked");
  });

  it("halts on token-budget exhaustion before the threshold", async () => {
    const { runPhase } = scriptedRunner([qaResult("AC_NOT_MET", ["bug"])]);
    const result = await runReadyGate(
      baseOpts({
        runPhase,
        policy: "a-plus",
        maxIterations: 5,
        tokenBudget: 1000,
        readTokensUsed: () => 5000, // first QA already blew the budget
      }),
    );

    expect(result.reason).toBe("TOKEN_BUDGET");
    expect(result.ready).toBe(false);
  });

  it("halts on LOOP_NO_DIFF when the fix loop produces no diff", async () => {
    const { runPhase } = scriptedRunner([
      qaResult("AC_NOT_MET", ["bug"]),
      loopResult(true), // loop "succeeds" but changes nothing
      // no second QA expected — stagnation halts first
    ]);
    const result = await runReadyGate(
      baseOpts({
        runPhase,
        policy: "a-plus",
        snapshotFn: stagnantSnapshots(),
      }),
    );

    expect(result.reason).toBe("LOOP_NO_DIFF");
    expect(result.ready).toBe(false);
  });

  it("halts when the loop phase itself fails", async () => {
    const { runPhase } = scriptedRunner([
      qaResult("AC_NOT_MET", ["bug"]),
      loopResult(false),
    ]);
    const result = await runReadyGate(baseOpts({ runPhase, policy: "a-plus" }));

    expect(result.reason).toBe("LOOP_FAILED");
    expect(result.ready).toBe(false);
  });
});

// ─── runReadyGate: #534 regression guards (AC-5) ─────────────────────────────

describe("runReadyGate — AC-5 #534 regression guard", () => {
  it("a null / unparseable QA verdict is never ready", async () => {
    const { runPhase } = scriptedRunner([qaResult(null)]);
    const result = await runReadyGate(baseOpts({ runPhase }));

    expect(result.reason).toBe("NO_IMPLEMENTATION");
    expect(result.ready).toBe(false);
    expect(result.finalVerdict).toBeNull();
  });

  it("a zero-diff worktree (empty branch, #529/#570) is never ready", async () => {
    // QA somehow returns a positive verdict, but the worktree has no changes.
    const { runPhase } = scriptedRunner([qaResult("AC_MET_BUT_NOT_A_PLUS")]);
    const result = await runReadyGate(
      baseOpts({ runPhase, hasChangesFn: () => false }),
    );

    expect(result.reason).toBe("NO_IMPLEMENTATION");
    expect(result.ready).toBe(false);
  });
});

// ─── runReadyGate: never-merges + report shape (AC-4) ────────────────────────

describe("runReadyGate — AC-4 never merges + report", () => {
  it("only ever dispatches qa/loop (never merge) and ends in a human gate", async () => {
    const { runPhase, calls } = scriptedRunner([qaResult("READY_FOR_MERGE")]);
    const result = await runReadyGate(baseOpts({ runPhase }));

    expect(calls.every((c) => c.phase === "qa" || c.phase === "loop")).toBe(
      true,
    );
    expect(result.issueStatus).toBe("waiting_for_human_merge");
    // Report carries the structured shape: verdict, auto-fixed, remaining.
    expect(result.report).toContain("never auto-merged");
    expect(result.report).toContain("Auto-fixed");
    expect(result.report).toContain("Remaining / accepted gaps");
  });
});

// ─── runReadyGate: Non-Goal report-only under ac (AC-3a) ─────────────────────

describe("runReadyGate — AC-3a Non-Goal report-only under ac", () => {
  it("excludes Non-Goal-touching gaps from the fix loop, reports them", async () => {
    const nonGoals = ["--from-pr / reverse PR→issue resolution (follow-up)"];
    const { runPhase, calls } = scriptedRunner([
      qaResult("AC_NOT_MET", [
        "fix the auth token validation",
        "add reverse resolution support",
      ]),
      loopResult(),
      // The AC gap is fixed; the deliberately-unfixed Non-Goal gap re-surfaces.
      qaResult("AC_MET_BUT_NOT_A_PLUS", ["add reverse resolution support"]),
    ]);
    const result = await runReadyGate(
      baseOpts({ runPhase, policy: "ac", nonGoals }),
    );

    const loopCall = calls.find((c) => c.phase === "loop");
    expect(loopCall?.failedAcs).toContain("auth token validation");
    expect(loopCall?.failedAcs).not.toContain("reverse resolution");
    // The Non-Goal gap is surfaced in the report as report-only, not fixed.
    expect(result.report).toContain("Non-Goal — report-only");
    expect(result.autoFixed).not.toContain("add reverse resolution support");
  });
});

// ─── formatReadyReport (AC-4) ────────────────────────────────────────────────

describe("formatReadyReport (AC-4)", () => {
  it("renders a NOT-READY no-implementation headline", () => {
    const result: ReadyResult = {
      issueNumber: 999,
      policy: "ac",
      ready: false,
      reason: "NO_IMPLEMENTATION",
      issueStatus: "blocked",
      iterations: 1,
      finalVerdict: null,
      autoFixed: [],
      remaining: [],
      tokensUsed: 0,
      report: "",
    };
    const report = formatReadyReport(result);
    expect(report).toContain("NOT READY — no implementation");
    expect(report).toContain("#534");
  });
});
