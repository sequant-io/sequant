# Exec and QA Phase Guards

The orchestrator now treats two previously-silent failure modes as explicit phase failures: exec sessions that produce zero changes, and QA sessions that return without a parseable verdict. Empty-worktree runs now fail at the relevant phase instead of surfacing as a cryptic `No commits between main and feature/…` error at PR creation.

## Prerequisites

1. **Sequant CLI** — `npx sequant --version` (shipped in 2.1.3+ / Unreleased)
2. **Worktree branched from `origin/main`** — created via `./scripts/dev/new-feature.sh <issue>` (no action needed; this is the default)

## What Changed

Previously, `src/lib/workflow/phase-executor.ts` mapped agent-reported success to phase success too eagerly:

- **QA phase:** if the agent output contained no `Verdict:` line at all (empty output, malformed output, session that never reached the output template), the phase was still returned as `success: true`.
- **Exec phase:** no sanity check on whether exec actually produced any commits or uncommitted work. An agent session that returned success with no file changes was treated as a successful exec.

Combined, an empty worktree could progress `spec → exec (no changes) → qa (no verdict → pass) → PR creation`, where PR creation was the only thing that caught the failure via GitHub API.

Now both phases reject those results.

## What You'll See

### Exec produced nothing

When the exec phase returns success but `git rev-list --count origin/main..HEAD` is `0` and `git status --porcelain` is empty, the phase fails with:

```
exec produced no changes (no commits, no uncommitted work)
```

This appears in:

- `sequant run` stderr for that phase
- `.sequant/logs/<run-id>.jsonl` → `error` field of the exec phase result
- `sequant logs --failed` output

### QA returned without a verdict

When the QA phase returns success but the agent output is empty or does not contain a parseable verdict line (`Verdict: ...`, `### Verdict: ...`, `**Verdict:** ...`, etc.), the phase fails with:

```
QA completed without a parseable verdict
```

Same reporting surfaces as above. `sessionId` and stderr/stdout tails are preserved in the failure record, so `sequant logs --failed --verbose` still shows the captured context.

## How the Exec Guard Detects Zero-Progress Runs

The guard runs in the worktree directory (`cwd`) after the agent returns and does two checks:

1. `git rev-list --count origin/main..HEAD` — counts commits unique to `HEAD`.
2. `git status --porcelain` — checks for uncommitted changes.

If both report zero, exec is marked as failed. Either being non-empty is sufficient to pass.

### Why `rev-list --count` and not `diff`

The guard uses the count of unique commits, not `git diff --quiet origin/main..HEAD`. A two-dot diff fires in either direction: once `origin/main` has advanced past `HEAD` (stale feature branch — common after long-running work), the two-dot diff would exit `1` for the inverse change set and falsely report "has commits" even when the branch is zero-progress. `rev-list --count origin/main..HEAD` only counts commits reachable from `HEAD` but not from `origin/main`, which is what the guard actually needs.

### Fail-open on git errors

If either git command throws (e.g. `origin/main` isn't fetched yet), `hasExecChanges` returns `true`. A false phase failure on an unfetched origin is worse than preserving the original behavior for that narrow edge case. In the sequant-managed flow, `new-feature.sh` always fetches origin before creating the worktree, so this path is defensive.

## Troubleshooting

### My exec phase fails with "exec produced no changes" but the agent did real work

**Cause:** The agent edited files but didn't commit them, *and* the worktree's `cwd` at guard time was something other than the feature worktree (rare — only possible when calling `executePhase` without passing `worktreePath`, which the orchestrator always does for exec).

**Fix:** Verify the orchestrator was invoked normally (`sequant run <issue>` or `/fullsolve`). Direct `executePhase` calls without `worktreePath` fall back to `process.cwd()`, which will not reflect the agent's edits.

### My QA phase fails with "QA completed without a parseable verdict" on a run that looked fine

**Cause:** The QA skill's output didn't include a `Verdict:` line the parser recognizes. Usually means the agent session was cut short (timeout, SIGTERM, context exhaustion) before the QA skill's output template was written.

**Fix:** Check `sequant logs --failed --verbose` for the session's stderr tail. Common causes: phase timeout (`run.timeout` in `.sequant/settings.json`), context overflow, or hook blocks. Re-run with `sequant run <issue> --phase qa` after addressing the root cause.

### Zero-progress exec on a custom-base worktree (resolved in #537)

**Cause (pre-#537):** Worktrees created with `./scripts/new-feature.sh <issue> --base feature/<branch>` branch from a non-main ref. The original #534 guard compared HEAD against `origin/main`, so the parent branch's commits still counted — a zero-progress exec on top of a populated base was not detected.

**Fix ([#537](https://github.com/sequant-io/sequant/issues/537)):** `new-feature.sh` now records the `--base` value in `branch.<name>.sequantBase` (via `git config`) at worktree creation. The zero-diff guard reads that key via `resolveBaseRef(cwd)` and compares against `origin/<recorded-base>` instead of the hardcoded `origin/main`. Worktrees without a recorded base fall back to `origin/main` — pre-#534 behavior preserved for legacy and non-sequant-managed worktrees. Subprocess calls use `execFileSync` so the recorded value cannot trigger shell interpretation.

**If you still see zero-diff execs passing on a custom-base worktree:** the base wasn't recorded. Either the worktree predates #537, or it was created outside `new-feature.sh`. Set it manually:

```bash
git -C <worktree> config branch.<current-branch>.sequantBase feature/<parent>
```

---

*Generated for Issue #534 on 2026-04-19*
