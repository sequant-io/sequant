# ADR-0014: Start every worktree from an unmerged `origin/<branch>`, and keep one already at it

**Status:** Proposed
**Date:** 2026-10-16
**Issue:** #1405

## Context

ADR-0013 (#1380) made a stale-worktree recreate start from `origin/<branch>`. It left two gaps, listed under its "Not changed" and "still behind" consequences:

1. **First creation on a fresh machine.** With no local branch but an existing `origin/<branch>` (a PR opened from another machine, or a cloud session), `ensureWorktree` checked only `refs/heads/<branch>` and cut a new branch from the base. A qa re-run there reviewed the base, and a later push diverged from the PR.
2. **Repeat recreate.** A worktree recreated from `origin/<branch>` keeps the PR's commits but is still more than 5 commits behind the base. Every later `ensureWorktree` call recreated it again (delete, re-add, dependency reinstall) until the pre-PR rebase or a merge of the base landed.

The start ref was resolved separately on each path, and #1234 and #1380 had both patched this path within three weeks. A fix to one path alone would leave the other path with the same class of bug.

Design constraint (#1322): no `gh` call on the reuse path. Per-worktree `gh` calls on the hot path made run time scale with load.

## Decision

One resolver, `resolveBranchStartRef`, serves both the first-creation path (no local branch, not chain mode) and the recreate path. It returns `origin/<branch>` only when the remote still has the branch and the branch is not already merged into the base. Otherwise it returns the base ref. A stale worktree whose HEAD already equals `origin/<branch>` is kept, not recreated.

- "Remote still has it": `git fetch origin <branch>`. A `couldn't find remote ref` reply makes a leftover tracking ref count as absent. Any other fetch failure (offline) falls back to the tracking ref that is present, as in ADR-0013.
- "Merged": `origin/<branch>` is an ancestor of the base (merge commit), or `git merge-tree --write-tree <base> origin/<branch>` gives the base's own tree (squash merge, which this repo uses). If `merge-tree` fails (git < 2.38), only the ancestor test applies.
- The check is local `git` only and runs only on the first-creation and recreate paths, never on reuse.

## Options

### Option A: Skip the recreate when HEAD equals `origin/<branch>` (chosen)

**Pros:** A recreate from `origin/<branch>` at the same commit rebuilds the same tree and lockfile, so it gains nothing. Skipping it adds no commits and no conflict handling to provisioning. **Cons:** The worktree stays behind the base until `rebaseBeforePR` (#1069) runs. That was already true after an ADR-0013 recreate.

### Option B: Merge the base in at recreate time

**Pros:** The worktree is no longer stale. **Cons:** Provisioning writes a commit nobody asked for, which then must be pushed. It adds merge-conflict handling to `ensureWorktree` and repeats what `rebaseBeforePR` already does.

### Option C: Ask `gh` whether the PR was merged or closed

**Pros:** Also detects a PR closed unmerged. **Cons:** It adds a network call to the path the #1322 constraint keeps it off. A PR closed unmerged is out of scope for #1405.

## Trade-offs

Option A narrows the recreate to the case where it changes something: `origin/<branch>` is ahead of the local HEAD (for example, commits pushed from another machine). A false "merged" result (every change on the branch is already in the base) starts from the base. On the recreate path the containment guard then keeps the existing worktree. A false "not merged" result gives the behaviour from before this change.

## Consequences

- On a fresh machine, the first worktree for a pushed PR branch contains every commit of `origin/<branch>` and tracks it.
- A remote branch already merged into the base (merge commit or squash), or deleted from the remote, is not used as a start ref.
- A clean, stale worktree already at `origin/<branch>` is reused. Its dependencies are not reinstalled, because its lockfile has not changed.
- First creation adds one `git fetch origin <branch>`, capped at 30 s. For a new issue this fails fast with `couldn't find remote ref`.
- Supersedes ADR-0013's "Not changed: a fresh machine with no local branch …" consequence and its "still behind its base" repeat-recreate consequence. Chain mode still cuts a new branch from its predecessor.
- Not changed: a remote branch whose PR was closed unmerged is still used as a start ref.
