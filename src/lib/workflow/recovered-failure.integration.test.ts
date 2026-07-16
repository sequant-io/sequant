import { describe, it, expect } from "vitest";
import { RunOrchestrator } from "./run-orchestrator.js";
import { NonTTYRenderer } from "../cli-ui/run-renderer.js";
import { LogWriter } from "./log-writer.js";
import {
  finalizeRunLog,
  type RunConfig,
  type PhaseLog,
  type PhaseStatus,
} from "./run-log-schema.js";
import type { ExecutionConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

/**
 * #766 AC-3 / AC-7 — the live card, the summary-table verdict, and the JSON log
 * must agree for the same run. Historically they disagreed: a run that failed a
 * quality-loop phase and then recovered showed `failed` on the card, `passed`
 * in the table, and `partial` (neither passed nor failed) in the log.
 *
 * These tests feed the *same* qa-fails-twice-then-succeeds sequence to all three
 * state machines and assert they land on the same verdict.
 */

const PHASES = ["spec", "exec", "qa"] as const;

function makeOrchestrator(issue: number): RunOrchestrator {
  const config: ExecutionConfig = {
    ...DEFAULT_CONFIG,
    phases: [...PHASES],
    qualityLoop: true,
  };
  return new RunOrchestrator({
    config,
    options: {},
    issueInfoMap: new Map([[issue, { title: `Issue ${issue}`, labels: [] }]]),
    worktreeMap: new Map(),
    services: {},
    baseBranch: "main",
  });
}

const runConfig: RunConfig = {
  phases: [...PHASES],
  sequential: false,
  qualityLoop: true,
  maxIterations: 3,
};

function phaseLog(
  issue: number,
  phase: string,
  status: PhaseStatus,
  error?: string,
): PhaseLog {
  return {
    phase,
    issueNumber: issue,
    startTime: "2026-07-15T00:00:00.000Z",
    endTime: "2026-07-15T00:00:30.000Z",
    durationSeconds: 30,
    status,
    ...(error ? { error } : {}),
  };
}

describe("recovered failure — three outputs agree (#766 AC-3/AC-7)", () => {
  it("qa fails twice then succeeds → passed on card, renderer, and log", async () => {
    const issue = 760;

    // ── Live card (orchestrator) ──────────────────────────────────────────
    const orch = makeOrchestrator(issue);
    const progress = orch["cfg"].onProgress!;
    // ── Renderer (summary-table state machine) ────────────────────────────
    const renderer = new NonTTYRenderer({
      stdoutWrite: () => {},
      noColor: true,
      nonTtyHeartbeatMs: 0,
    });
    renderer.registerIssue({ issueNumber: issue, plannedPhases: [...PHASES] });
    // ── JSON log ──────────────────────────────────────────────────────────
    const writer = new LogWriter();
    await writer.initialize(runConfig);
    writer.startIssue(issue, `Issue ${issue}`, []);

    const emit = (
      phase: string,
      event: "start" | "complete" | "failed",
      iteration: number,
      error?: string,
    ) => {
      progress(issue, phase, event, { iteration, error, durationSeconds: 1 });
      renderer.onEvent({
        issue,
        phase,
        event,
        iteration,
        ...(event === "complete" ? { durationSeconds: 1 } : {}),
        ...(error ? { error } : {}),
      });
    };

    // spec runs once up front.
    emit("spec", "start", 1);
    emit("spec", "complete", 1);
    writer.logPhase(phaseLog(issue, "spec", "success"));

    // Three iterations: qa fails (iter1), fails (iter2), succeeds (iter3).
    for (let iter = 1; iter <= 3; iter++) {
      emit("exec", "start", iter);
      emit("exec", "complete", iter);
      writer.logPhase(phaseLog(issue, "exec", "success"));

      if (iter < 3) {
        emit("qa", "start", iter);
        emit("qa", "failed", iter, "AC not met");
        writer.logPhase(phaseLog(issue, "qa", "failure", "AC not met"));
        // loop runs to fix, and succeeds (moves to next iteration)
        emit("loop", "start", iter);
        emit("loop", "complete", iter);
        writer.logPhase(phaseLog(issue, "loop", "success"));
      } else {
        emit("qa", "start", iter);
        emit("qa", "complete", iter);
        writer.logPhase(phaseLog(issue, "qa", "success"));
      }
    }

    // Card
    expect(orch.getSnapshot().issues[0].status).toBe("passed");
    // Renderer
    expect(renderer["issues"].get(issue)!.status).toBe("done");
    // Log
    writer.completeIssue();
    const finalized = finalizeRunLog(writer.getRunLog()!);
    expect(finalized.issues[0].status).toBe("success");
    expect(finalized.summary.passed).toBe(1);
    expect(finalized.summary.failed).toBe(0);
    expect(finalized.summary.partial).toBe(0);

    renderer.dispose();
    orch.markDone();
  });

  // NOTE: this asserts the writer/schema layer round-trips a loop entry — it
  // hand-writes the entry, so it does NOT cover AC-6's producer. The
  // batch-executor call site that emits it is covered in
  // `batch-executor.test.ts` ("#766: loop phase reaches the run log (AC-6)").
  it("round-trips a hand-written loop entry through the writer and schema", async () => {
    const issue = 760;
    const writer = new LogWriter();
    await writer.initialize(runConfig);
    writer.startIssue(issue, `Issue ${issue}`, []);
    writer.logPhase(phaseLog(issue, "qa", "failure", "AC not met"));
    writer.logPhase(phaseLog(issue, "loop", "failure", "loop crashed"));
    writer.logPhase(phaseLog(issue, "qa", "success"));
    writer.completeIssue();

    const finalized = finalizeRunLog(writer.getRunLog()!);
    const loopEntry = finalized.issues[0].phases.find(
      (p) => p.phase === "loop",
    );
    expect(loopEntry).toBeDefined();
    expect(loopEntry!.status).toBe("failure");
    expect(loopEntry!.durationSeconds).toBe(30);
    expect(loopEntry!.error).toBe("loop crashed");
    // The failed loop must not pin the issue once qa recovered.
    expect(finalized.issues[0].status).toBe("success");
  });

  it("an all-partial run is counted in its own bucket, not 0 passed · 0 failed (AC-4)", async () => {
    const writer = new LogWriter();
    await writer.initialize(runConfig);
    writer.startIssue(762, "Issue 762", []);
    writer.logPhase(phaseLog(762, "exec", "success"));
    writer.logPhase(phaseLog(762, "qa", "timeout", "Timeout after 1800s"));
    writer.completeIssue();

    const finalized = finalizeRunLog(writer.getRunLog()!);
    expect(finalized.issues[0].status).toBe("partial");
    expect(finalized.summary.partial).toBe(1);
    expect(finalized.summary.passed).toBe(0);
    expect(finalized.summary.failed).toBe(0);
    expect(finalized.summary.totalIssues).toBe(1);
  });
});
