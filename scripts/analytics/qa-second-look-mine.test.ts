/**
 * Tests for the second-look miner's signal rules (#1067).
 */
import { describe, it, expect } from "vitest";
import { mineLines } from "./qa-second-look-mine.js";

const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", timestamp: "2026-03-01T00:00:00Z", message: { role: "user", content }, ...extra });
const assistant = (content: unknown[]) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content } });

describe("mineLines", () => {
  it("finds the gap turn, buckets edits/commits around it, and records verdicts", () => {
    const s = mineLines([
      user("qa 503"),
      assistant([{ type: "text", text: "**Verdict:** READY_FOR_MERGE" }]),
      user([{ type: "tool_result", content: "ok" }]),
      user("<task-notification>done</task-notification>"),
      user("any gaps? fix all gaps"),
      assistant([
        { type: "tool_use", name: "Edit", input: {} },
        { type: "tool_use", name: "Bash", input: { command: "git commit -m fix" } },
        { type: "text", text: "Updated verdict: AC_NOT_MET" },
      ]),
    ]);
    expect(s.humanTurns).toBe(2);
    expect(s.firstGapTurn).toBe(1);
    expect(s.verdicts).toEqual([
      { turn: 0, verdict: "READY_FOR_MERGE" },
      { turn: 1, verdict: "AC_NOT_MET" },
    ]);
    expect([s.editsBeforeGap, s.editsAfterGap]).toEqual([0, 1]);
    expect([s.commitsBeforeGap, s.commitsAfterGap]).toEqual([0, 1]);
    expect(s.startedAt).toBe("2026-03-01T00:00:00Z");
    expect(s.orchestratorSet).toBe(false);
  });

  it("does not treat the opener as the gap turn, and flags an orchestrated session", () => {
    const s = mineLines([
      user("qa 12 — check gaps"),
      assistant([{ type: "tool_use", name: "Bash", input: { command: "SEQUANT_ORCHESTRATOR=sequant-run npx sequant run" } }]),
    ]);
    expect(s.firstGapTurn).toBeNull();
    expect(s.orchestratorSet).toBe(true);
  });
});
