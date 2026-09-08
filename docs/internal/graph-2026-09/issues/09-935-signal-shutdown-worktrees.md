# 09 — #935 fix(run): signal shutdown preserves dirty worktrees; `abort` cites its real origin

**Epic:** M1   **Blocked by:** #933   **Tier:** mechanical   **Doc:** PLAN §7 D13, §8 (orchestrator region: cleanup registration), §9 OQ-2/OQ-3, Lab §1

## Why
`run-orchestrator.ts:1167-1181` registers `git worktree remove --force` for every
created worktree; `ShutdownManager` fires it on SIGINT/SIGTERM and hands each
cleanup a `ShutdownReason`. The #879 message then names a directory that no
longer exists. Option A (D13): keep dirty worktrees on signal-driven shutdown.
`bin/cli.ts:507` and `src/commands/abort.ts:3,7` cite #645, which never mentions
abort; `git log -S'Out-of-band abort'` names `af1ce78a` (PR #858, #853).

## Scope
- may touch: `src/lib/workflow/run-orchestrator.ts` (cleanup registration block only), `src/lib/workflow/phase-executor.ts` (`formatUncommittedExecError` text only), `bin/cli.ts:507` comment, `src/commands/abort.ts` header comment, `src/lib/shutdown.ts` **only if** the reason is not already reachable in the cleanup, tests beside them
- not in scope: the preflight call (node 05); clean-worktree removal; resume semantics.

## Acceptance criteria
- [ ] AC-1: on a signal-driven shutdown a worktree with uncommitted changes is not removed; a clean one still is — Verify: `npx vitest run src/lib/workflow/run-orchestrator.shutdown.test.ts -t "935"` → passes; the test creates two real worktrees in a temp repo, dirties one, invokes the registered cleanups with reason `SIGTERM`, and asserts on `git worktree list` afterwards.
- [ ] AC-2: the failure text matches the post-shutdown filesystem — Verify: same test: the message emitted for the dirty case contains a path that exists; for the path-removed case (non-signal completion) the message names the branch instead of a path.
- [ ] AC-3: `abort` cites its origin — Verify: `grep -n '#645' bin/cli.ts src/commands/abort.ts | wc -l` → `0`, and the replacement citation equals the PR of `git log --format=%s -S'Out-of-band abort' -- bin/cli.ts | tail -1`.

## Done when
An externally terminated run never deletes a worktree its own failure text points at, and the `abort` command's comment sends a reader to the issue that specified it.
