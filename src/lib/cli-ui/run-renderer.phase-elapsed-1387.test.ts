/**
 * #1387 AC-4: the `still running` heartbeat shows time since the current
 * phase started, not since the issue started.
 */

import { describe, expect, it } from "vitest";
import { NonTTYRenderer } from "./run-renderer.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function setup() {
  const out: string[] = [];
  const clock = { now: T0 };
  const r = new NonTTYRenderer({
    stdoutWrite: (s: string) => out.push(s),
    noColor: true,
    now: () => clock.now,
    wallClock: () => new Date(2026, 9, 9, 2, 47, 45),
    nonTtyHeartbeatMs: 60_000,
  });
  r.registerIssue({ issueNumber: 21 });
  const heartbeats = () =>
    out
      .join("")
      .split("\n")
      .filter((l) => l.includes("still running"));
  return { r, clock, heartbeats };
}

describe("run-renderer heartbeat (#1387)", () => {
  describe("AC-4: elapsed is per phase", () => {
    it("reads `#21 exec (1m)` when the issue started at T0, exec at T0+11m, now T0+12m", () => {
      const { r, clock, heartbeats } = setup();
      r.onEvent({ issue: 21, phase: "spec", event: "start" });
      clock.now = T0 + 11 * MIN;
      r.onEvent({
        issue: 21,
        phase: "spec",
        event: "complete",
        durationSeconds: 660,
      });
      r.onEvent({ issue: 21, phase: "exec", event: "start" });

      clock.now = T0 + 12 * MIN;
      r.tickHeartbeatNow();

      const lines = heartbeats();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("#21 exec (1m)");
      expect(lines[0]).not.toContain("12m");
      r.dispose();
    });

    describe("error handling", () => {
      it("falls back to the issue start when the running phase has no start recorded", () => {
        const { r, clock, heartbeats } = setup();
        r.onEvent({ issue: 21, phase: "exec", event: "start" });
        // Simulate a phase entry without a recorded start.
        const state = (
          r as unknown as {
            issues: Map<number, { phases: Array<{ startedAt?: number }> }>;
          }
        ).issues.get(21)!;
        for (const p of state.phases) p.startedAt = undefined;

        clock.now = T0 + 3 * MIN;
        r.tickHeartbeatNow();

        expect(heartbeats()[0]).toContain("#21 exec (3m)");
        r.dispose();
      });
    });
  });
});
