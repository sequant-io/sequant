/**
 * Chain resume planning (#760).
 *
 * When a `--chain` run fails mid-way, earlier links may already be complete
 * (`ready_for_merge`) with a checkpoint commit on their feature branch
 * (`createCheckpointCommit`, worktree-manager.ts). Re-running the same chain
 * should skip that completed prefix and resume at the first incomplete link,
 * rebased onto the last completed link's committed tip — NOT `main` (which is
 * the #748 wrong-base failure this reuses the #748 rebase path to avoid).
 *
 * The existing pre-flight guard (`run-orchestrator.ts`) already drops
 * `ready_for_merge`/`merged` issues from the run, but it is chain-unaware:
 * dropping the completed prefix leaves the first incomplete link at index 0,
 * where `executeSequential`'s successor-rebase never fires, so it silently
 * builds on `main`. This module computes a *chain-correct* resume plan that
 * preserves the completed prefix as the resume base.
 *
 * The planner is pure over an injected {@link CompletedLinkResolver} so the
 * skip/fail-fast state machine (AC-3) is unit-testable without real git; the
 * real-git rebase is covered by the integration test.
 */

/** A completed link that will be skipped (not re-executed) on resume. */
export interface ChainResumeSkip {
  issueNumber: number;
  /** Why it was skipped — the terminal-ish status that made it complete. */
  status: "ready_for_merge" | "merged";
  /** The link's local feature branch (from state), if known. */
  branch?: string;
}

/** The computed plan for resuming a partially-completed chain. */
export interface ChainResumePlan {
  /** Contiguous completed prefix that will be skipped (not re-executed). */
  skipped: ChainResumeSkip[];
  /** Issue numbers to actually execute (the incomplete tail). */
  active: number[];
  /**
   * Local branch (or base ref) the first active link must be provisioned from
   * and rebased onto. Undefined on a fresh run (no completed prefix).
   */
  resumeBase?: string;
  /** Commit the resume base resolves to — reported so the user sees the point. */
  resumeBaseCommit?: string;
  /** First incomplete issue number (the resume point), if any. */
  resumeIssue?: number;
  /**
   * Set when resume cannot proceed safely (AC-3): a `ready_for_merge` link's
   * branch/checkpoint is gone and its tip is unreconstructable. The caller must
   * abort rather than silently execute the successor on the wrong base.
   */
  failFast?: string;
  /** True when every link in the chain is already complete. */
  allComplete: boolean;
}

/** Resolves the git refs a resume base depends on. Injected for testability. */
export interface CompletedLinkResolver {
  /**
   * Resolve a local branch ref to its tip commit SHA, or undefined if the
   * branch does not exist (destroyed worktree/branch — the AC-3 fail-fast case).
   */
  resolveBranchTip(branch: string): string | undefined;
  /** Resolve the base branch tip (for merged-resume reporting). */
  resolveBaseTip(): string | undefined;
}

/** An ordered chain link with its persisted state (status + branch). */
export interface ChainLinkState {
  issueNumber: number;
  status?: string;
  branch?: string;
}

const COMPLETED_STATUSES = new Set(["ready_for_merge", "merged"]);

/**
 * Compute a chain-correct resume plan.
 *
 * Peels the *contiguous* completed prefix off the front of the chain (chain
 * mode breaks on the first failure, so completed links always form a prefix).
 * A completed link that appears *after* an incomplete one is left in `active`
 * and re-executed — the conservative choice, since automatic skipping must not
 * silently drop an issue the user intended to redo.
 *
 * @param orderedLinks Chain links in execution order, with persisted state.
 * @param baseBranch The run's base branch (resume base when the prefix merged).
 * @param resolver Git-ref resolver (injected for tests).
 */
export function computeChainResumePlan(
  orderedLinks: ChainLinkState[],
  baseBranch: string,
  resolver: CompletedLinkResolver,
): ChainResumePlan {
  const skipped: ChainResumeSkip[] = [];
  let firstIncomplete = 0;
  for (const link of orderedLinks) {
    if (link.status && COMPLETED_STATUSES.has(link.status)) {
      skipped.push({
        issueNumber: link.issueNumber,
        status: link.status as "ready_for_merge" | "merged",
        branch: link.branch,
      });
      firstIncomplete++;
    } else {
      break;
    }
  }

  const allNumbers = orderedLinks.map((l) => l.issueNumber);

  // No completed prefix → fresh run, nothing to resume.
  if (skipped.length === 0) {
    return { skipped: [], active: allNumbers, allComplete: false };
  }

  // Every link already complete → nothing to execute.
  if (firstIncomplete >= orderedLinks.length) {
    return { skipped, active: [], allComplete: true };
  }

  const active = allNumbers.slice(firstIncomplete);
  const last = skipped[skipped.length - 1];

  let resumeBase: string;
  let resumeBaseCommit: string | undefined;

  if (last.status === "merged") {
    // The completed prefix's work is in the merged base (origin/main). Provision
    // the first incomplete link from the base branch — the same base a fresh
    // first link would use — rather than a local tip that squash-merge may have
    // orphaned (never rebase a successor onto a stale post-merge local tip).
    resumeBase = baseBranch;
    resumeBaseCommit = resolver.resolveBaseTip();
  } else {
    // ready_for_merge: the checkpoint tip lives only on the local feature
    // branch. If that branch is gone (worktree/branch destroyed mid-way), the
    // tip is unreconstructable — fail fast instead of wrong-basing the
    // successor onto main (which would miss the completed link's work).
    if (!last.branch) {
      return {
        skipped,
        active,
        resumeIssue: active[0],
        allComplete: false,
        failFast:
          `#${last.issueNumber} is ready_for_merge but no branch is recorded in state — ` +
          `cannot reconstruct the resume base. Re-run with --force to redo the chain from scratch.`,
      };
    }
    const tip = resolver.resolveBranchTip(last.branch);
    if (!tip) {
      return {
        skipped,
        active,
        resumeIssue: active[0],
        allComplete: false,
        failFast:
          `#${last.issueNumber} is ready_for_merge but its branch "${last.branch}" no longer exists — ` +
          `the resume base is unreconstructable. Re-run with --force to redo the chain from scratch.`,
      };
    }
    resumeBase = last.branch;
    resumeBaseCommit = tip;
  }

  return {
    skipped,
    active,
    resumeBase,
    resumeBaseCommit,
    resumeIssue: active[0],
    allComplete: false,
  };
}
