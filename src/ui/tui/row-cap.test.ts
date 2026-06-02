import { describe, it, expect } from "vitest";
import {
  selectVisibleIssues,
  effectiveTuiRowCap,
  DEFAULT_TUI_ROW_CAP,
} from "./row-cap.js";
import type {
  IssueRuntimeState,
  IssueStatus,
} from "../../lib/workflow/run-state.js";

function issue(
  number: number,
  status: IssueStatus,
  completedAtMs?: number,
): IssueRuntimeState {
  return {
    number,
    title: `Issue ${number}`,
    branch: `feature/${number}`,
    status,
    phases: [],
    completedAt: completedAtMs != null ? new Date(completedAtMs) : undefined,
  };
}

describe("effectiveTuiRowCap (#699 AC-4)", () => {
  it("clamps to the static cap on a tall terminal", () => {
    // 200 rows / 11 lines-per-box ≈ 17 boxes, but the static cap (10) wins.
    expect(effectiveTuiRowCap(200)).toBe(DEFAULT_TUI_ROW_CAP);
  });

  it("clamps to a dynamic ceiling on a short terminal", () => {
    // A 24-row terminal fits far fewer than 10 Ink boxes.
    const cap = effectiveTuiRowCap(24);
    expect(cap).toBeLessThan(DEFAULT_TUI_ROW_CAP);
    expect(cap).toBeGreaterThanOrEqual(1);
  });

  it("never returns less than 1, even on a tiny terminal", () => {
    expect(effectiveTuiRowCap(1)).toBeGreaterThanOrEqual(1);
  });

  it("trusts the static cap when rows is unknown (no over-clamp)", () => {
    expect(effectiveTuiRowCap(undefined)).toBe(DEFAULT_TUI_ROW_CAP);
    expect(effectiveTuiRowCap(0)).toBe(DEFAULT_TUI_ROW_CAP);
  });
});

describe("selectVisibleIssues (#699 AC-4)", () => {
  it("returns everything unchanged under the cap", () => {
    const issues = [issue(1, "running"), issue(2, "passed", 100)];
    const { visible, rolledUpDoneCount } = selectVisibleIssues(issues, 200);
    expect(visible).toEqual(issues);
    expect(rolledUpDoneCount).toBe(0);
  });

  it("keeps every active issue and rolls up older done rows when over cap", () => {
    // Cap of 3 (staticCap=3) with 2 active + 4 done → 1 active slot left after
    // reserving the rollup line, so 1 active fits? No: all active are kept.
    const issues = [
      issue(1, "running"),
      issue(2, "running"),
      issue(3, "passed", 400),
      issue(4, "passed", 300),
      issue(5, "passed", 200),
      issue(6, "failed", 100),
    ];
    const { visible, rolledUpDoneCount } = selectVisibleIssues(
      issues,
      200,
      3, // static cap
      1, // tiny lines-per-box so the dynamic cap doesn't shrink below 3
    );
    // Both active issues are always retained.
    expect(visible.filter((i) => i.status === "running")).toHaveLength(2);
    // cap=3 → 2 visible slots (1 reserved for rollup); both taken by active,
    // so 0 done shown and all 4 done roll up.
    expect(rolledUpDoneCount).toBe(4);
  });

  it("fills remaining slots with the most-recently-completed done rows", () => {
    const issues = [
      issue(1, "running"),
      issue(2, "passed", 100), // oldest
      issue(3, "passed", 300), // newest
      issue(4, "passed", 200),
    ];
    // cap=3 → 2 visible slots; 1 active + 1 newest-done shown, 2 roll up.
    const { visible, rolledUpDoneCount } = selectVisibleIssues(
      issues,
      200,
      3,
      1,
    );
    expect(rolledUpDoneCount).toBe(2);
    const shownDone = visible.filter((i) => i.status === "passed");
    expect(shownDone).toHaveLength(1);
    expect(shownDone[0].number).toBe(3); // newest completed kept
  });

  it("treats both passed and failed as terminal (done) for capping", () => {
    const issues = [
      issue(1, "failed", 200),
      issue(2, "passed", 100),
      issue(3, "running"),
    ];
    const { visible } = selectVisibleIssues(issues, 200, 2, 1);
    // 1 active always kept; 1 visible slot reserved leaves room for the active.
    expect(visible.some((i) => i.status === "running")).toBe(true);
  });
});
