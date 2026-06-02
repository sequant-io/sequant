import { describe, it, expect } from "vitest";
import { ReadySnapshotAdapter } from "./ready-tui-adapter.js";

function makeAdapter(): ReadySnapshotAdapter {
  return new ReadySnapshotAdapter({
    issueNumber: 699,
    title: "Upgrade ready to the Ink TUI",
    branch: "feature/699-tui",
  });
}

describe("ReadySnapshotAdapter (#699 AC-1)", () => {
  it("starts queued with a single-issue, not-done snapshot", () => {
    const snap = makeAdapter().getSnapshot();
    expect(snap.done).toBe(false);
    expect(snap.issues).toHaveLength(1);
    expect(snap.issues[0]).toMatchObject({
      number: 699,
      title: "Upgrade ready to the Ink TUI",
      branch: "feature/699-tui",
      status: "queued",
    });
    expect(snap.config.concurrency).toBe(1);
  });

  it("on `start`, appends a running phase with a coarse now line", () => {
    const a = makeAdapter();
    a.onProgress(699, "qa", "start", { iteration: 1 });
    const issue = a.getSnapshot().issues[0];
    expect(issue.status).toBe("running");
    expect(issue.phases).toEqual([
      expect.objectContaining({ name: "qa", status: "running" }),
    ]);
    expect(issue.currentPhase).toMatchObject({
      name: "qa",
      nowLine: "running qa",
    });
    expect(issue.startedAt).toBeInstanceOf(Date);
  });

  it("on `complete`, marks the phase done with elapsed and clears the now line", () => {
    const a = makeAdapter();
    a.onProgress(699, "qa", "start", { iteration: 1 });
    a.onProgress(699, "qa", "complete", { iteration: 1, durationSeconds: 3 });
    const issue = a.getSnapshot().issues[0];
    expect(issue.phases[0]).toMatchObject({
      name: "qa",
      status: "done",
      elapsedMs: 3000,
    });
    expect(issue.currentPhase).toBeUndefined();
  });

  it("models qa → loop → qa passes as the phase row", () => {
    const a = makeAdapter();
    a.onProgress(699, "qa", "start", { iteration: 1 });
    a.onProgress(699, "qa", "complete", { iteration: 1, durationSeconds: 1 });
    a.onProgress(699, "loop", "start", { iteration: 1 });
    a.onProgress(699, "loop", "complete", { iteration: 1, durationSeconds: 1 });
    a.onProgress(699, "qa", "start", { iteration: 2 });
    const names = a.getSnapshot().issues[0].phases.map((p) => p.name);
    expect(names).toEqual(["qa", "loop", "qa"]);
  });

  it("on `failed`, marks the phase failed and flips the issue to failed", () => {
    const a = makeAdapter();
    a.onProgress(699, "qa", "start", { iteration: 1 });
    a.onProgress(699, "qa", "failed", { iteration: 1, error: "boom" });
    const issue = a.getSnapshot().issues[0];
    expect(issue.phases[0].status).toBe("failed");
    expect(issue.status).toBe("failed");
  });

  it("`activity` refreshes the now line when a finer signal lands", () => {
    const a = makeAdapter();
    a.onProgress(699, "qa", "start", { iteration: 1 });
    a.onProgress(699, "qa", "activity", { text: "  reviewing AC-3  " });
    expect(a.getSnapshot().issues[0].currentPhase?.nowLine).toBe(
      "reviewing AC-3",
    );
  });

  it("`activity` with no current phase is a no-op", () => {
    const a = makeAdapter();
    a.onProgress(699, "qa", "activity", { text: "stray" });
    expect(a.getSnapshot().issues[0].currentPhase).toBeUndefined();
  });

  it("markDone(true) flips done and sets passed", () => {
    const a = makeAdapter();
    a.onProgress(699, "qa", "start", { iteration: 1 });
    a.onProgress(699, "qa", "complete", { iteration: 1 });
    a.markDone(true);
    const snap = a.getSnapshot();
    expect(snap.done).toBe(true);
    expect(snap.issues[0].status).toBe("passed");
    expect(snap.issues[0].completedAt).toBeInstanceOf(Date);
  });

  it("markDone(false) sets failed", () => {
    const a = makeAdapter();
    a.markDone(false);
    expect(a.getSnapshot().issues[0].status).toBe("failed");
  });

  it("markDone never downgrades an already-failed phase status", () => {
    const a = makeAdapter();
    a.onProgress(699, "qa", "start", { iteration: 1 });
    a.onProgress(699, "qa", "failed", { iteration: 1 });
    a.markDone(true); // gate says ready, but a phase already failed
    expect(a.getSnapshot().issues[0].status).toBe("failed");
  });

  it("returns a fresh snapshot object each call (no leaked mutable refs)", () => {
    const a = makeAdapter();
    a.onProgress(699, "qa", "start", { iteration: 1 });
    const first = a.getSnapshot();
    a.onProgress(699, "qa", "complete", { iteration: 1 });
    const second = a.getSnapshot();
    expect(first).not.toBe(second);
    // The earlier snapshot's phase array wasn't mutated in place.
    expect(first.issues[0].phases[0].status).toBe("running");
    expect(second.issues[0].phases[0].status).toBe("done");
  });
});
