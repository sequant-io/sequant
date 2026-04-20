import { describe, it, expect } from "vitest";
import { RunOrchestrator } from "./run-orchestrator.js";
import type { ExecutionConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

function makeOrchestrator(issueNumbers: number[]): RunOrchestrator {
  const config: ExecutionConfig = {
    ...DEFAULT_CONFIG,
    phases: ["spec", "exec", "qa"],
  };
  const issueInfoMap = new Map(
    issueNumbers.map((n) => [
      n,
      { title: `Issue ${n}`, labels: ["enhancement"] },
    ]),
  );
  return new RunOrchestrator({
    config,
    options: {},
    issueInfoMap,
    worktreeMap: new Map(
      issueNumbers.map((n) => [
        n,
        {
          issue: n,
          path: `/tmp/wt-${n}`,
          branch: `feature/${n}-test`,
          existed: false,
          rebased: false,
        },
      ]),
    ),
    services: {},
    baseBranch: "main",
  });
}

describe("RunOrchestrator.getSnapshot", () => {
  it("initializes one state per issue with pending phases", () => {
    const orch = makeOrchestrator([1, 2]);
    const snap = orch.getSnapshot();
    expect(snap.issues).toHaveLength(2);
    expect(snap.issues[0].number).toBe(1);
    expect(snap.issues[0].phases.every((p) => p.status === "pending")).toBe(
      true,
    );
    expect(snap.issues[0].status).toBe("queued");
    expect(snap.done).toBe(false);
  });

  it("reflects config (concurrency, base, quality loop)", () => {
    const orch = makeOrchestrator([1]);
    const snap = orch.getSnapshot();
    expect(snap.config.concurrency).toBe(DEFAULT_CONFIG.concurrency);
    expect(snap.config.baseBranch).toBe("main");
    expect(snap.config.qualityLoop).toBe(DEFAULT_CONFIG.qualityLoop);
  });

  it("tracks phase transitions through the wrapped onProgress", () => {
    const orch = makeOrchestrator([42]);
    const progress = orch["cfg"].onProgress!;
    progress(42, "spec", "start");
    let snap = orch.getSnapshot();
    expect(snap.issues[0].status).toBe("running");
    expect(snap.issues[0].phases[0].status).toBe("running");
    expect(snap.issues[0].currentPhase?.name).toBe("spec");

    progress(42, "spec", "complete", { durationSeconds: 12 });
    snap = orch.getSnapshot();
    expect(snap.issues[0].phases[0].status).toBe("done");
    expect(snap.issues[0].phases[0].elapsedMs).toBe(12000);
    expect(snap.issues[0].currentPhase).toBeUndefined();
  });

  it("marks issue passed after all phases complete", () => {
    const orch = makeOrchestrator([7]);
    const progress = orch["cfg"].onProgress!;
    for (const phase of ["spec", "exec", "qa"]) {
      progress(7, phase, "start");
      progress(7, phase, "complete", { durationSeconds: 1 });
    }
    const snap = orch.getSnapshot();
    expect(snap.issues[0].status).toBe("passed");
    expect(snap.issues[0].completedAt).toBeInstanceOf(Date);
  });

  it("marks issue failed on first failed phase", () => {
    const orch = makeOrchestrator([7]);
    const progress = orch["cfg"].onProgress!;
    progress(7, "spec", "start");
    progress(7, "spec", "failed");
    const snap = orch.getSnapshot();
    expect(snap.issues[0].status).toBe("failed");
    expect(snap.issues[0].phases[0].status).toBe("failed");
  });

  it("forwards onProgress events to an external callback", () => {
    const events: Array<[number, string, string]> = [];
    const config: ExecutionConfig = {
      ...DEFAULT_CONFIG,
      phases: ["spec", "exec"],
    };
    const orch = new RunOrchestrator({
      config,
      options: {},
      issueInfoMap: new Map([[5, { title: "t", labels: [] }]]),
      worktreeMap: new Map(),
      services: {},
      onProgress: (issue, phase, event) => events.push([issue, phase, event]),
    });
    orch["cfg"].onProgress!(5, "spec", "start");
    orch["cfg"].onProgress!(5, "spec", "complete", { durationSeconds: 1 });
    expect(events).toEqual([
      [5, "spec", "start"],
      [5, "spec", "complete"],
    ]);
  });

  it("returns an isolated snapshot that does not share state with internals", () => {
    const orch = makeOrchestrator([1]);
    const first = orch.getSnapshot();
    orch["cfg"].onProgress!(1, "spec", "start");
    expect(first.issues[0].phases[0].status).toBe("pending");
    expect(first.issues[0].status).toBe("queued");
    const second = orch.getSnapshot();
    expect(second.issues[0].phases[0].status).toBe("running");
    expect(second).not.toBe(first);
    expect(second.issues).not.toBe(first.issues);
  });

  it("flips done=true after markDone()", () => {
    const orch = makeOrchestrator([1]);
    expect(orch.getSnapshot().done).toBe(false);
    orch.markDone();
    expect(orch.getSnapshot().done).toBe(true);
  });
});
