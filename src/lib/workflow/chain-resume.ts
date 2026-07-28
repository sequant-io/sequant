/**
 * Chain resume planning (#760).
 *
 * When a `--chain` run fails mid-way, earlier links may already be complete
 * (see {@link COMPLETED_STATUSES}) with a checkpoint commit on their feature
 * branch (`createCheckpointCommit`, worktree-manager.ts). Re-running the same
 * chain should skip that completed prefix and resume at the first incomplete
 * link, rebased onto the last completed link's committed tip — NOT `main`
 * (which is the #748 wrong-base failure this reuses the #748 rebase path to
 * avoid).
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

/**
 * Persisted issue statuses that mark a chain link as done for prefix-peeling.
 *
 * `waiting_for_human_merge` is here because of #817's `--ready-gate` (#837): a
 * gated link deliberately terminates there rather than `ready_for_merge`, which
 * would read as auto-merge-ready and defeat the human merge gate. Without it,
 * resuming a `--chain --ready-gate` run re-executed every already-gated link
 * from phase 0 — a full spec/exec/qa pipeline plus another full-weight gate.
 *
 * `blocked` is deliberately NOT here, for two reasons:
 *
 * 1. It is a *generic* member of `IssueStatusSchema` ("waiting on external input
 *    or dependency"), not a ready-gate-exclusive terminal. Admitting it would
 *    silently apply to every other writer of that status, present and future.
 * 2. A guard halt IS the human-attention signal. Skipping it as a completed
 *    prefix would report the link as passed when it demonstrably did not.
 *
 * So a `blocked` link stays in `active` and is re-executed. That is the same
 * conservative rule already applied to links whose state lookup fails (see
 * {@link planChainResumeFromState}): re-running wastes tokens, but silently
 * dropping an issue the user must look at is the worse failure. Once the user
 * clears the blocker, the re-run is what lets the chain make progress.
 *
 * Single source of truth for both the runtime check and {@link CompletedStatus},
 * so the set and the type cannot drift apart.
 */
const COMPLETED_STATUSES = [
  "ready_for_merge",
  "merged",
  "waiting_for_human_merge",
] as const;

/** A persisted status that counts as a completed chain link. */
export type CompletedStatus = (typeof COMPLETED_STATUSES)[number];

const COMPLETED_STATUS_SET = new Set<string>(COMPLETED_STATUSES);

/** A completed link that will be skipped (not re-executed) on resume. */
export interface ChainResumeSkip {
  issueNumber: number;
  /** Why it was skipped — the terminal-ish status that made it complete. */
  status: CompletedStatus;
  /** The link's local feature branch (from state), if known. */
  branch?: string;
  /** The link's worktree path (from state), if known — used for the dirty check. */
  worktree?: string;
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
   * Set when resume cannot proceed safely (AC-3): an unmerged completed link's
   * (`ready_for_merge` or `waiting_for_human_merge`) branch/checkpoint is gone
   * and its tip is unreconstructable. The caller must abort rather than
   * silently execute the successor on the wrong base.
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
  /**
   * True iff the worktree has uncommitted changes (tracked or non-ignored
   * untracked). Used to detect a resume base whose checkpoint never landed —
   * see the dirty-tip fail-fast in {@link computeChainResumePlan}. Must return
   * false (not throw) when the worktree is gone or unreadable; branch-tip
   * resolution governs that case instead.
   */
  isWorktreeDirty(worktreePath: string): boolean;
}

/** An ordered chain link with its persisted state (status + branch + worktree). */
export interface ChainLinkState {
  issueNumber: number;
  status?: string;
  branch?: string;
  worktree?: string;
}

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
    if (link.status && COMPLETED_STATUS_SET.has(link.status)) {
      skipped.push({
        issueNumber: link.issueNumber,
        status: link.status as CompletedStatus,
        branch: link.branch,
        worktree: link.worktree,
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
    // ready_for_merge / waiting_for_human_merge: the checkpoint tip lives only
    // on the local feature branch. If that branch is gone (worktree/branch
    // destroyed mid-way), the tip is unreconstructable — fail fast instead of
    // wrong-basing the successor onto main (which would miss the completed
    // link's work).
    if (!last.branch) {
      return {
        skipped,
        active,
        resumeIssue: active[0],
        allComplete: false,
        failFast:
          `#${last.issueNumber} is ${last.status} but no branch is recorded in state — ` +
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
          `#${last.issueNumber} is ${last.status} but its branch "${last.branch}" no longer exists — ` +
          `the resume base is unreconstructable. Re-run with --force to redo the chain from scratch.`,
      };
    }
    // The branch exists, but a tip is only a valid resume base if it actually
    // contains the link's work. `createCheckpointCommit` sweeps trailing
    // uncommitted changes into a checkpoint commit; when it fails (commit hook,
    // staging error, or unrelated dirty files) a completed status was *already*
    // written — `ready_for_merge` on a plain run, or `waiting_for_human_merge`
    // when #817's `--ready-gate` owned the terminal status (#837) — so this link
    // still reads as a completed prefix while its tip is missing work. Both
    // statuses reach this branch, so the check covers gated links too. Rebasing
    // the successor onto such a tip would be exactly the silent wrong-base
    // execution AC-3 forbids — fail fast instead.
    if (last.worktree && resolver.isWorktreeDirty(last.worktree)) {
      return {
        skipped,
        active,
        resumeIssue: active[0],
        allComplete: false,
        failFast:
          `#${last.issueNumber} is ${last.status} but its worktree has uncommitted changes — ` +
          `its checkpoint commit never landed, so branch "${last.branch}" is missing that work and ` +
          `resuming #${active[0]} here would build on an incomplete base. Commit them in ${last.worktree}, ` +
          `or re-run with --force to redo the chain from scratch.`,
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

/** The subset of persisted issue state the resume planner reads. */
export interface PersistedLinkState {
  status?: string;
  branch?: string;
  worktree?: string;
}

/**
 * Read each link's persisted state and compute the resume plan.
 *
 * Split out of `run-orchestrator.ts` so the state-reading half of resume — in
 * particular "a state lookup failure must treat the link as *incomplete*", the
 * conservative choice that re-executes rather than skipping on bad data — is
 * testable without standing up an orchestrator.
 *
 * @param issueNumbers Chain issues in execution order.
 * @param baseBranch The run's base branch.
 * @param getIssueState Reads persisted state for one issue (may reject).
 * @param resolver Git-ref resolver.
 * @param onStateError Called when a lookup throws; the link is then treated as
 *   incomplete (no status), so it stays in `active`.
 */
export async function planChainResumeFromState(
  issueNumbers: number[],
  baseBranch: string,
  getIssueState: (
    issueNumber: number,
  ) => Promise<PersistedLinkState | null | undefined>,
  resolver: CompletedLinkResolver,
  onStateError?: (issueNumber: number, error: unknown) => void,
): Promise<ChainResumePlan> {
  const orderedLinks: ChainLinkState[] = [];
  for (const issueNumber of issueNumbers) {
    let status: string | undefined;
    let branch: string | undefined;
    let worktree: string | undefined;
    try {
      const issueState = await getIssueState(issueNumber);
      status = issueState?.status;
      branch = issueState?.branch;
      worktree = issueState?.worktree;
    } catch (error) {
      // Unknown state → treat as incomplete and re-execute. Skipping on a
      // failed lookup could silently drop an issue the user meant to run.
      onStateError?.(issueNumber, error);
    }
    orderedLinks.push({ issueNumber, status, branch, worktree });
  }
  return computeChainResumePlan(orderedLinks, baseBranch, resolver);
}
