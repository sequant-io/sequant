/**
 * Unit tests for the chain resume planner (#760).
 *
 * Pure state-machine coverage over an injected resolver — no real git. The
 * real-git rebase/ancestry behaviour is covered by
 * `chain-resume.integration.test.ts` (AC-1, AC-2, AC-5). These focus on AC-3:
 * distinguishing merged (resume from base) from ready_for_merge-but-destroyed
 * (fail fast), and the skip/prefix logic.
 */

import { describe, it, expect, vi } from "vitest";
import {
  computeChainResumePlan,
  planChainResumeFromState,
  type ChainLinkState,
  type CompletedLinkResolver,
  type PersistedLinkState,
} from "./chain-resume.js";

/**
 * Resolver where every branch resolves to a stable fake SHA and every worktree
 * is clean unless listed in `dirtyWorktrees`.
 */
function resolver(
  branchTips: Record<string, string | undefined> = {},
  baseTip: string | undefined = "basetip0000",
  dirtyWorktrees: string[] = [],
): CompletedLinkResolver {
  return {
    resolveBranchTip: (branch) =>
      branch in branchTips ? branchTips[branch] : `${branch}-tip`,
    resolveBaseTip: () => baseTip,
    isWorktreeDirty: (worktreePath) => dirtyWorktrees.includes(worktreePath),
  };
}

const link = (
  issueNumber: number,
  status?: string,
  branch?: string,
  worktree?: string,
): ChainLinkState => ({ issueNumber, status, branch, worktree });

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

  it("ready_for_merge but worktree is dirty → fails fast: the checkpoint never landed, so the tip is incomplete", () => {
    // The checkpoint commit failed (hook/staging/unrelated-dirt), but the
    // status was already written as ready_for_merge, so #1 still reads as a
    // completed prefix while its branch tip is missing the uncommitted work.
    const plan = computeChainResumePlan(
      [
        link(1, "ready_for_merge", "feature/1-a", "/wt/1"),
        link(2, "in_progress", "feature/2-b", "/wt/2"),
      ],
      "main",
      resolver({ "feature/1-a": "sha-link1" }, "basetip0000", ["/wt/1"]),
    );
    expect(plan.failFast).toBeDefined();
    expect(plan.failFast).toContain("#1");
    expect(plan.failFast).toContain("uncommitted changes");
    expect(plan.failFast).toContain("/wt/1");
    // Must not hand back a usable base — that would be the wrong-base execution.
    expect(plan.resumeBase).toBeUndefined();
    expect(plan.resumeIssue).toBe(2);
  });

  it("dirty worktree on a MERGED prefix link does not fail fast (base branch holds the work)", () => {
    // A merged link resumes from the base branch, so its local worktree state
    // is irrelevant — stray dirt there must not block the chain.
    const plan = computeChainResumePlan(
      [
        link(1, "merged", "feature/1-a", "/wt/1"),
        link(2, "in_progress", "feature/2-b", "/wt/2"),
      ],
      "main",
      resolver({}, "mainsha000", ["/wt/1"]),
    );
    expect(plan.failFast).toBeUndefined();
    expect(plan.resumeBase).toBe("main");
  });

  it("dirty worktree on an EARLIER prefix link is irrelevant — only the resume base is checked", () => {
    // #1 is dirty but #2 is the resume base; #1's tip is never rebased onto.
    const plan = computeChainResumePlan(
      [
        link(1, "ready_for_merge", "feature/1-a", "/wt/1"),
        link(2, "ready_for_merge", "feature/2-b", "/wt/2"),
        link(3, "in_progress", "feature/3-c", "/wt/3"),
      ],
      "main",
      resolver({ "feature/2-b": "sha-link2" }, "basetip0000", ["/wt/1"]),
    );
    expect(plan.failFast).toBeUndefined();
    expect(plan.resumeBase).toBe("feature/2-b");
  });

  it("ready_for_merge with no worktree recorded → dirty check skipped, resume proceeds on the tip", () => {
    const plan = computeChainResumePlan(
      [
        link(1, "ready_for_merge", "feature/1-a", undefined),
        link(2, "in_progress", "feature/2-b"),
      ],
      "main",
      resolver({ "feature/1-a": "sha-link1" }),
    );
    expect(plan.failFast).toBeUndefined();
    expect(plan.resumeBase).toBe("feature/1-a");
    expect(plan.resumeBaseCommit).toBe("sha-link1");
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

describe("planChainResumeFromState (#760)", () => {
  const stateSource =
    (states: Record<number, PersistedLinkState | undefined>) =>
    async (issueNumber: number) =>
      states[issueNumber];

  it("reads status/branch/worktree from state and peels the completed prefix", async () => {
    const plan = await planChainResumeFromState(
      [1, 2, 3],
      "main",
      stateSource({
        1: {
          status: "ready_for_merge",
          branch: "feature/1-a",
          worktree: "/wt/1",
        },
        2: { status: "in_progress", branch: "feature/2-b" },
        3: undefined,
      }),
      resolver({ "feature/1-a": "sha-link1" }),
    );

    expect(plan.skipped.map((s) => s.issueNumber)).toEqual([1]);
    // The handoff the orchestrator assigns to issueNumbers / chainBase.
    expect(plan.active).toEqual([2, 3]);
    expect(plan.resumeBase).toBe("feature/1-a");
    expect(plan.resumeBaseCommit).toBe("sha-link1");
  });

  it("threads the worktree through so a dirty resume base still fails fast", async () => {
    const plan = await planChainResumeFromState(
      [1, 2],
      "main",
      stateSource({
        1: {
          status: "ready_for_merge",
          branch: "feature/1-a",
          worktree: "/wt/1",
        },
        2: { status: "in_progress" },
      }),
      resolver({ "feature/1-a": "sha-link1" }, "basetip0000", ["/wt/1"]),
    );
    expect(plan.failFast).toContain("uncommitted changes");
  });

  it("a failed state lookup treats the link as incomplete rather than skipping it", async () => {
    // Conservative: unknown state must never silently drop an issue the user
    // asked to run, so #1 stays active and no resume base is invented.
    const onStateError = vi.fn();
    const plan = await planChainResumeFromState(
      [1, 2],
      "main",
      async (issueNumber) => {
        if (issueNumber === 1) throw new Error("state file corrupt");
        return { status: "in_progress" };
      },
      resolver(),
      onStateError,
    );

    expect(plan.skipped).toEqual([]);
    expect(plan.active).toEqual([1, 2]);
    expect(plan.resumeBase).toBeUndefined();
    expect(onStateError).toHaveBeenCalledTimes(1);
    expect(onStateError.mock.calls[0][0]).toBe(1);
  });

  it("no prior state at all (fresh chain) → every link active, no resume", async () => {
    const plan = await planChainResumeFromState(
      [1, 2, 3],
      "main",
      stateSource({}),
      resolver(),
    );
    expect(plan.active).toEqual([1, 2, 3]);
    expect(plan.skipped).toEqual([]);
    expect(plan.allComplete).toBe(false);
    expect(plan.failFast).toBeUndefined();
  });
});
