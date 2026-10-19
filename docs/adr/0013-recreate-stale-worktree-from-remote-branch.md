# ADR-0013: Recreate a stale worktree from its remote branch, behind a containment guard

**Status:** Proposed
**Date:** 2026-10-10
**Issue:** #1380

## Context

`ensureWorktree` recreates a worktree that is more than 5 commits behind its base and has no uncommitted or unpushed work. It deletes the local branch (`removeStaleWorktree` runs `git branch -D`), and the creation step then checks only `refs/heads/<branch>`. That ref was just deleted, so the step cuts a new branch from the base with `git worktree add -b <branch> <baseRef>`. It never reads `origin/<branch>`.

Commits already pushed to a PR count as "not unpushed", so a pushed PR branch was recreated from the base, without any of the PR's commits. A qa re-run then reviewed the base tree, not the PR. Any later commit on that branch diverged from `origin/<branch>`. A branch with no upstream was exposed too: `git log @{u}..HEAD` fails, `hasUnpushedCommits` stays false, and that branch's local-only commits were lost the same way.

## Decision

Resolve one start ref before the stale worktree is removed: `origin/<branch>` if the remote has the branch (after a fetch), else the base ref. Recreate only if that ref contains the current HEAD (`git merge-base --is-ancestor HEAD <startRef>`). If it does not, print a yellow warning and keep the existing worktree. A recreate from `origin/<branch>` uses `git worktree add -B <branch> <path> origin/<branch>`. The recorded `sequantBaseRef` stays the run's base.

## Options

### Option A: Start ref from `origin/<branch>` plus a containment guard (chosen)

**Pros:** The recreated branch has every commit on `origin/<branch>`, including commits pushed from another machine. One guard covers the pushed-PR case, an offline fetch, and a local-only branch with its own commits. **Cons:** One extra `git fetch` on the recreate path.

### Option B: Keep the local branch when it is pushed

Skip `git branch -D` and reuse the local ref. **Pros:** Fewer moving parts. **Cons:** The local ref can lag `origin/<branch>` (for example, a merge of main pushed from elsewhere). Local-only branches are still lost.

### Option C: Never recreate when `origin/<branch>` exists

**Pros:** Simplest. **Cons:** Never picks up remote-only commits or reinstalls dependencies for a PR branch, and does not protect a local-only branch.

## Trade-offs

Option A is the only option that keeps every commit in all three cases. The fetch costs about as much as the base fetch `checkWorktreeFreshness` already does, with the same 30 s cap. The base is not merged into the recreated branch. The pre-PR `rebaseBeforePR` already does that for pushed branches (#1069).

## Consequences

- A qa re-run on a stale PR worktree reviews the PR's commits.
- A recreate that would drop commits is now visible as a warning, not silent.
- A recreated PR branch is still behind its base until the pre-PR rebase runs.
- Not changed: a fresh machine with no local branch but an existing `origin/<branch>` still cuts a new branch from the base. A non-default bare base is still counted against `origin/<base>` and cut from the local `<base>` (the #1234/#1386 class). Revisit both if they cause failures in practice.
