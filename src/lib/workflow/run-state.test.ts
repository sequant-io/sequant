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

  // #766 — a phase that fails on an early quality-loop iteration must not pin
  // the live card `failed` once a later iteration recovers.
  describe("recovered phase failure (#766)", () => {
    function runToRecovery(orch: RunOrchestrator): void {
      const progress = orch["cfg"].onProgress!;
      // iteration 1: spec+exec pass, qa fails, loop runs and fails
      progress(1, "spec", "start");
      progress(1, "spec", "complete", { durationSeconds: 1 });
      progress(1, "exec", "start");
      progress(1, "exec", "complete", { durationSeconds: 1 });
      progress(1, "qa", "start");
      progress(1, "qa", "failed", { error: "AC not met" });
      progress(1, "loop", "start", { iteration: 1 });
      progress(1, "loop", "failed", { error: "loop crashed", iteration: 1 });
      // iteration 2: exec + qa re-run and pass (slots overwrite by name)
      progress(1, "exec", "start", { iteration: 2 });
      progress(1, "exec", "complete", { durationSeconds: 1, iteration: 2 });
      progress(1, "qa", "start", { iteration: 2 });
      progress(1, "qa", "complete", { durationSeconds: 1, iteration: 2 });
    }

    it("finalizes passed after a loop fails then a later iteration succeeds (AC-1/AC-8)", () => {
      const orch = makeOrchestrator([1]);
      runToRecovery(orch);
      const snap = orch.getSnapshot();
      expect(snap.issues[0].status).toBe("passed");
      // The stale loop slot is still recorded as failed — it just no longer
      // pins the issue.
      expect(snap.issues[0].phases.find((p) => p.name === "loop")?.status).toBe(
        "failed",
      );
    });

    it("keeps a #762-style all-failed run red when qa never recovers (negative guard)", () => {
      const orch = makeOrchestrator([1]);
      const progress = orch["cfg"].onProgress!;
      progress(1, "spec", "start");
      progress(1, "spec", "complete", { durationSeconds: 1 });
      progress(1, "exec", "start");
      progress(1, "exec", "complete", { durationSeconds: 1 });
      progress(1, "qa", "start");
      progress(1, "qa", "failed", { error: "Timeout after 1800s" });
      progress(1, "loop", "start", { iteration: 1 });
      progress(1, "loop", "failed", { error: "loop failed", iteration: 1 });
      // iteration 2: exec passes but qa dies again (max iter, no further loop)
      progress(1, "exec", "start", { iteration: 2 });
      progress(1, "exec", "complete", { durationSeconds: 1, iteration: 2 });
      progress(1, "qa", "start", { iteration: 2 });
      progress(1, "qa", "failed", { error: "Connection closed", iteration: 2 });
      expect(orch.getSnapshot().issues[0].status).toBe("failed");
    });
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

  // #543 — sub-phase activity enrichment
  describe("activity events", () => {
    it("updates nowLine and lastActivityAt on activity events", async () => {
      const orch = makeOrchestrator([42]);
      const progress = orch["cfg"].onProgress!;
      progress(42, "exec", "start");
      const startSnap = orch.getSnapshot();
      const startActivityAt =
        startSnap.issues[0].currentPhase!.lastActivityAt.getTime();
      expect(startSnap.issues[0].currentPhase!.nowLine).toBe("running exec");

      // Wait long enough that lastActivityAt advances by at least 1ms.
      await new Promise((resolve) => setTimeout(resolve, 5));
      progress(42, "exec", "activity", { text: "Editing src/foo.ts" });

      const snap = orch.getSnapshot();
      expect(snap.issues[0].currentPhase!.nowLine).toBe("Editing src/foo.ts");
      expect(
        snap.issues[0].currentPhase!.lastActivityAt.getTime(),
      ).toBeGreaterThan(startActivityAt);
    });

    it("uses the last non-empty line from a multi-line chunk", () => {
      const orch = makeOrchestrator([1]);
      const progress = orch["cfg"].onProgress!;
      progress(1, "exec", "start");
      progress(1, "exec", "activity", {
        text: "first line\nmiddle\nlast useful line\n\n",
      });
      expect(orch.getSnapshot().issues[0].currentPhase!.nowLine).toBe(
        "last useful line",
      );
    });

    it("strips ANSI escape sequences from activity text", () => {
      const orch = makeOrchestrator([1]);
      const progress = orch["cfg"].onProgress!;
      progress(1, "exec", "start");
      progress(1, "exec", "activity", {
        text: "\x1b[32mwriting tests\x1b[0m",
      });
      expect(orch.getSnapshot().issues[0].currentPhase!.nowLine).toBe(
        "writing tests",
      );
    });

    it("strips non-SGR CSI sequences (cursor moves, line clears, mode toggles)", () => {
      const orch = makeOrchestrator([1]);
      const progress = orch["cfg"].onProgress!;
      progress(1, "exec", "start");
      // Mix of line-clear (\x1b[2K), cursor-column (\x1b[G), DEC private
      // hide-cursor (\x1b[?25l), and a trailing SGR colour reset.
      progress(1, "exec", "activity", {
        text: "\x1b[2K\x1b[G\x1b[?25lediting src/foo.ts\x1b[0m",
      });
      expect(orch.getSnapshot().issues[0].currentPhase!.nowLine).toBe(
        "editing src/foo.ts",
      );
    });

    it("ignores activity events for stale phase names", () => {
      const orch = makeOrchestrator([1]);
      const progress = orch["cfg"].onProgress!;
      progress(1, "spec", "start");
      progress(1, "spec", "complete", { durationSeconds: 1 });
      // After completion, currentPhase is cleared — activity must be a no-op.
      progress(1, "spec", "activity", { text: "leaked output" });
      const snap = orch.getSnapshot();
      expect(snap.issues[0].currentPhase).toBeUndefined();
    });

    it("ignores activity events when there is no usable text", () => {
      const orch = makeOrchestrator([1]);
      const progress = orch["cfg"].onProgress!;
      progress(1, "exec", "start");
      const before = orch.getSnapshot().issues[0].currentPhase!.nowLine;
      progress(1, "exec", "activity", { text: "   \n\n  " });
      progress(1, "exec", "activity", { text: undefined });
      const after = orch.getSnapshot().issues[0].currentPhase!.nowLine;
      expect(after).toBe(before);
    });

    it("falls back to coarse 'running <phase>' when activity is stale ≥5s", () => {
      const orch = makeOrchestrator([1]);
      const progress = orch["cfg"].onProgress!;
      progress(1, "exec", "start");
      progress(1, "exec", "activity", { text: "fresh activity" });

      // Force lastActivityAt to 6 seconds ago.
      const internal = orch["issueStates"].get(1)!;
      internal.currentPhase!.lastActivityAt = new Date(Date.now() - 6_000);

      const snap = orch.getSnapshot();
      expect(snap.issues[0].currentPhase!.nowLine).toBe("running exec");
      // The underlying timestamp is preserved so the "Xs ago" stamp still ticks.
      expect(
        Date.now() - snap.issues[0].currentPhase!.lastActivityAt.getTime(),
      ).toBeGreaterThanOrEqual(6_000);
    });

    it("does not fall back while activity is fresh", () => {
      const orch = makeOrchestrator([1]);
      const progress = orch["cfg"].onProgress!;
      progress(1, "exec", "start");
      progress(1, "exec", "activity", { text: "live signal" });
      const snap = orch.getSnapshot();
      expect(snap.issues[0].currentPhase!.nowLine).toBe("live signal");
    });
  });
});
