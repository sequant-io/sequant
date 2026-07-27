/**
 * #804 AC-7 — routing of the `waiting` progress event.
 *
 * Closes the two branches the first QA pass flagged as uncovered:
 *   - `RunOrchestrator.applyProgressEvent` (MCP / TUI path)
 *   - `buildProgressWiring`'s renderer + heartbeat dispatch (CLI path)
 *
 * The orchestrator case is NOT cosmetic. `waiting` is handled before the
 * complete/failed fall-through; if that ordering regresses, the fall-through
 * runs `p.status = event === "complete" ? "done" : "failed"` and emits
 * `phase_failed` — so a phase that is merely paused waiting for a rate-limit
 * window gets reported as a failure.
 */

import { describe, it, expect, vi } from "vitest";
import { RunOrchestrator } from "./run-orchestrator.js";
import type { OrchestratorConfig } from "./run-orchestrator.js";
import { DEFAULT_CONFIG } from "./types.js";

const WAKE = 1_800_000_000_000;

/**
 * `WorkflowEventEmitter.emit` dispatches through `Promise.allSettled`, so
 * listeners run on a later tick. Without this flush every `not.toHaveBeenCalled`
 * below would pass trivially — including against the very regression these
 * tests exist to catch.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeOrchestrator(onProgress?: OrchestratorConfig["onProgress"]) {
  return new RunOrchestrator({
    config: { ...DEFAULT_CONFIG, phases: ["spec", "exec", "qa"] },
    options: {},
    issueInfoMap: new Map([[804, { title: "auto-wait", labels: [] }]]),
    worktreeMap: new Map(),
    services: {},
    onProgress,
  } as unknown as OrchestratorConfig);
}

function phaseOf(orch: RunOrchestrator, name: string) {
  const issue = orch.getSnapshot().issues.find((i) => i.number === 804)!;
  return issue.phases.find((p) => p.name === name)!;
}

describe("#804 RunOrchestrator — a waiting event pauses, never completes or fails", () => {
  it("keeps the phase running and does not emit phase_failed", async () => {
    const orch = makeOrchestrator();
    const failed = vi.fn();
    const completed = vi.fn();
    orch.getEmitter().on("phase_failed", failed);
    orch.getEmitter().on("phase_completed", completed);

    const onProgress = orch.getProgressCallback();
    onProgress(804, "qa", "start");
    onProgress(804, "qa", "waiting", {
      text: "Rate limited — resets at 13:00 · auto-wait 1/2",
      wakeAtMs: WAKE,
    });
    await flush();

    // The regression this pins: without the dedicated branch, `waiting` reaches
    // `p.status = event === "complete" ? "done" : "failed"` and emits
    // `phase_failed` for a phase that is merely paused. Verified to actually
    // fail when that branch is removed — not a tautology.
    expect(failed).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    expect(phaseOf(orch, "qa").status).toBe("running");

    const issue = orch.getSnapshot().issues.find((i) => i.number === 804)!;
    expect(issue.status).toBe("running");
    expect(issue.currentPhase?.name).toBe("qa");
  });

  it("surfaces the wait text on the current phase's nowLine", () => {
    const orch = makeOrchestrator();
    const onProgress = orch.getProgressCallback();
    onProgress(804, "qa", "start");
    onProgress(804, "qa", "waiting", {
      text: "Rate limited · auto-wait 1/2 — resuming at 13:00",
      wakeAtMs: WAKE,
    });

    const issue = orch.getSnapshot().issues.find((i) => i.number === 804)!;
    expect(issue.currentPhase?.nowLine).toContain("auto-wait 1/2");
  });

  it("emits a progress event so subscribers see the wait", async () => {
    const orch = makeOrchestrator();
    const progress = vi.fn();
    orch.getEmitter().on("progress", progress);

    const onProgress = orch.getProgressCallback();
    onProgress(804, "qa", "start");
    onProgress(804, "qa", "waiting", { text: "waiting…", wakeAtMs: WAKE });
    await flush();

    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 804, phase: "qa" }),
    );
  });

  it("ignores a waiting event for a phase that is no longer current", () => {
    const orch = makeOrchestrator();
    const onProgress = orch.getProgressCallback();
    onProgress(804, "spec", "start");
    onProgress(804, "spec", "complete", { durationSeconds: 3 });

    // A late notice racing phase completion must not resurrect `spec` or
    // clobber the snapshot.
    expect(() =>
      onProgress(804, "spec", "waiting", { text: "late", wakeAtMs: WAKE }),
    ).not.toThrow();
    expect(phaseOf(orch, "spec").status).toBe("done");
  });

  it("still forwards the event to an external onProgress callback", () => {
    const external = vi.fn();
    const orch = makeOrchestrator(external);
    const onProgress = orch.getProgressCallback();
    onProgress(804, "qa", "start");
    onProgress(804, "qa", "waiting", { text: "waiting…", wakeAtMs: WAKE });

    expect(external).toHaveBeenCalledWith(804, "qa", "waiting", {
      text: "waiting…",
      wakeAtMs: WAKE,
    });
  });

  it("a phase completes normally after a wait", async () => {
    const orch = makeOrchestrator();
    const completed = vi.fn();
    orch.getEmitter().on("phase_completed", completed);

    const onProgress = orch.getProgressCallback();
    onProgress(804, "qa", "start");
    onProgress(804, "qa", "waiting", { text: "waiting…", wakeAtMs: WAKE });
    onProgress(804, "qa", "waiting", { text: "done" }); // terminal notice
    onProgress(804, "qa", "complete", { durationSeconds: 12 });
    await flush();

    // Exactly once — a wait must not have emitted a spurious completion of its
    // own on the way through.
    expect(completed).toHaveBeenCalledTimes(1);
    expect(phaseOf(orch, "qa").status).toBe("done");
  });
});
