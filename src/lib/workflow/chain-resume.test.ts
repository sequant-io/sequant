/**
 * Unit tests for the chain resume planner (#760).
 *
 * Pure state-machine coverage over an injected resolver — no real git. The
 * real-git rebase/ancestry behaviour is covered by
 * `chain-resume.integration.test.ts` (AC-1, AC-2, AC-5). These focus on AC-3:
 * distinguishing merged (resume from base) from ready_for_merge-but-destroyed
 * (fail fast), and the skip/prefix logic.
 */

import { describe, it, expect } from "vitest";
import {
  computeChainResumePlan,
  type ChainLinkState,
  type CompletedLinkResolver,
} from "./chain-resume.js";

/** Resolver where every branch resolves to a stable fake SHA. */
function resolver(
  branchTips: Record<string, string | undefined> = {},
  baseTip: string | undefined = "basetip0000",
): CompletedLinkResolver {
  return {
    resolveBranchTip: (branch) =>
      branch in branchTips ? branchTips[branch] : `${branch}-tip`,
    resolveBaseTip: () => baseTip,
  };
}

const link = (
  issueNumber: number,
  status?: string,
  branch?: string,
): ChainLinkState => ({ issueNumber, status, branch });

describe("computeChainResumePlan (#760)", () => {
  it("fresh run: no completed prefix → all links active, no resume base", () => {
    const plan = computeChainResumePlan(
      [link(1, "in_progress"), link(2), link(3)],
      "main",
      resolver(),
    );
    expect(plan.skipped).toEqual([]);
    expect(plan.active).toEqual([1, 2, 3]);
    expect(plan.resumeBase).toBeUndefined();
    expect(plan.allComplete).toBe(false);
    expect(plan.failFast).toBeUndefined();
  });

  it("resumes at first incomplete link, rebased onto last completed link's branch (AC-1)", () => {
    const plan = computeChainResumePlan(
      [
        link(1, "ready_for_merge", "feature/1-a"),
        link(2, "in_progress", "feature/2-b"),
        link(3, undefined, "feature/3-c"),
      ],
      "main",
      resolver({ "feature/1-a": "sha-link1" }),
    );
    expect(plan.skipped.map((s) => s.issueNumber)).toEqual([1]);
    expect(plan.active).toEqual([2, 3]);
    expect(plan.resumeIssue).toBe(2);
    expect(plan.resumeBase).toBe("feature/1-a");
    expect(plan.resumeBaseCommit).toBe("sha-link1");
    expect(plan.failFast).toBeUndefined();
  });

  it("skips a multi-link contiguous completed prefix, resumes from the last one", () => {
    const plan = computeChainResumePlan(
      [
        link(1, "ready_for_merge", "feature/1-a"),
        link(2, "ready_for_merge", "feature/2-b"),
        link(3, "in_progress", "feature/3-c"),
      ],
      "main",
      resolver({ "feature/2-b": "sha-link2" }),
    );
    expect(plan.skipped.map((s) => s.issueNumber)).toEqual([1, 2]);
    expect(plan.active).toEqual([3]);
    expect(plan.resumeBase).toBe("feature/2-b");
    expect(plan.resumeBaseCommit).toBe("sha-link2");
  });

  it("merged last prefix link → resumes from the base branch, not a stale local tip (AC-3 merged)", () => {
    const plan = computeChainResumePlan(
      [link(1, "merged", "feature/1-a"), link(2, "in_progress", "feature/2-b")],
      "main",
      resolver({}, "mainsha000"),
    );
    expect(plan.skipped.map((s) => s.status)).toEqual(["merged"]);
    expect(plan.resumeBase).toBe("main");
    expect(plan.resumeBaseCommit).toBe("mainsha000");
    expect(plan.failFast).toBeUndefined();
  });

  it("ready_for_merge but branch destroyed → fails fast, no wrong-base execution (AC-3)", () => {
    const plan = computeChainResumePlan(
      [
        link(1, "ready_for_merge", "feature/1-a"),
        link(2, "in_progress", "feature/2-b"),
      ],
      "main",
      // Branch resolves to undefined → destroyed.
      resolver({ "feature/1-a": undefined }),
    );
    expect(plan.failFast).toBeDefined();
    expect(plan.failFast).toContain("#1");
    expect(plan.failFast).toContain("feature/1-a");
    expect(plan.resumeBase).toBeUndefined();
    expect(plan.resumeIssue).toBe(2);
  });

  it("ready_for_merge with no branch recorded in state → fails fast (AC-3)", () => {
    const plan = computeChainResumePlan(
      [link(1, "ready_for_merge", undefined), link(2, "in_progress")],
      "main",
      resolver(),
    );
    expect(plan.failFast).toBeDefined();
    expect(plan.failFast).toContain("no branch is recorded");
    expect(plan.resumeBase).toBeUndefined();
  });

  it("all links already completed → allComplete, nothing active", () => {
    const plan = computeChainResumePlan(
      [
        link(1, "ready_for_merge", "feature/1-a"),
        link(2, "merged", "feature/2-b"),
      ],
      "main",
      resolver(),
    );
    expect(plan.allComplete).toBe(true);
    expect(plan.active).toEqual([]);
    expect(plan.skipped.map((s) => s.issueNumber)).toEqual([1, 2]);
  });

  it("only peels a CONTIGUOUS prefix: a completed link after an incomplete one is re-executed", () => {
    const plan = computeChainResumePlan(
      [
        link(1, "ready_for_merge", "feature/1-a"),
        link(2, "in_progress", "feature/2-b"),
        // #3 is ready_for_merge but sits after an incomplete link — a hole.
        link(3, "ready_for_merge", "feature/3-c"),
      ],
      "main",
      resolver({ "feature/1-a": "sha-link1" }),
    );
    expect(plan.skipped.map((s) => s.issueNumber)).toEqual([1]);
    // #3 stays active (re-executed) rather than being silently skipped.
    expect(plan.active).toEqual([2, 3]);
  });
});
