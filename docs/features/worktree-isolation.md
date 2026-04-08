# Worktree Isolation for Parallel Agents

When `/exec` runs parallel agent groups, each agent normally shares the same issue worktree. This works when agents touch different files, but causes silent overwrites or merge conflicts when two agents edit the same file (e.g., `index.ts` barrel exports, `package.json`).

Worktree isolation gives each parallel agent its own copy of the repository. After all agents finish, their changes are merged back automatically with conflict detection.

## Prerequisites

1. **sequant initialized** — `npx sequant doctor`
2. **Parallel groups in spec** — Your `/spec` output must include a `## Parallel Groups` section
3. **Git 2.20+** — `git --version` (nested worktrees require modern git)

## Setup

### Option A: Enable per-run (CLI flag)

```bash
sequant run 485 --isolate-parallel
```

### Option B: Enable permanently (settings)

In `.sequant/settings.json`:

```json
{
  "agents": {
    "isolateParallel": true
  }
}
```

The CLI flag overrides the setting. When neither is set, isolation is disabled (agents share the worktree, same as before).

## What to Expect

When isolation is enabled and `/exec` encounters a parallel group:

1. **Sub-worktrees are created** (~400ms each) inside the issue worktree at `.exec-agents/agent-0/`, `.exec-agents/agent-1/`, etc.
2. **Each agent works in its own copy.** `node_modules` is symlinked (not reinstalled), so setup is fast.
3. **After all agents finish**, changes are merged back one by one using `git merge --no-ff`.
4. **Conflicts are detected and reported** — conflicting agents' changes are skipped, non-conflicting agents' changes are preserved. The next `/exec` iteration can resolve conflicts.
5. **Sub-worktrees are cleaned up** automatically.

**Timing overhead:** ~550ms per agent (creation + cleanup). Negligible compared to agent execution time.

**When disabled:** Agents share the issue worktree exactly as before. No sub-worktrees are created.

## Environment Files

Sub-worktrees need the same environment files as the main worktree. The `.worktreeinclude` file at the repository root lists which files to copy:

```
# .worktreeinclude
.env
.env.local
.env.development
.claude/settings.local.json
```

Edit this file to add project-specific config files. If the file doesn't exist, a default list (the four files above) is used.

## Conflict Handling

| Scenario | What happens |
|----------|-------------|
| Agents create different new files | Merges cleanly, all files appear |
| Agents modify different existing files | Merges cleanly |
| Two agents modify the same file, different sections | Git auto-merges |
| Two agents modify the same lines | Conflict detected, merge aborted for that agent |

When a conflict occurs:
- The conflicting agent's changes are **not** merged
- Other agents' changes **are** preserved
- The conflict is logged with file paths
- The next `/exec` iteration can resolve it

## Cleanup

Sub-worktrees are removed automatically after merge-back. If a session is interrupted, orphaned sub-worktrees are cleaned up by:

```bash
# Manual cleanup of a specific issue's worktree (handles .exec-agents/ automatically)
./scripts/cleanup-worktree.sh feature/485-my-feature

# Or prune stale git worktree entries
git worktree prune
```

## Troubleshooting

### Sub-worktree creation fails

**Symptoms:** Error "Failed to create sub-worktree for agent N"

**Solution:** Check disk space and git status. Isolation falls back to shared mode automatically — agents will still run, just without isolation.

### Merge conflicts on every run

**Symptoms:** Same files conflict repeatedly across parallel groups.

**Solution:** The parallel group partition in `/spec` may need adjustment. Move conflicting tasks to the same group (sequential within group) or to separate groups with dependency ordering.

### Orphaned `.exec-agents/` directory

**Symptoms:** `.exec-agents/` directory remains in the worktree after a crash.

**Solution:** Run `git worktree prune` then `rm -rf .exec-agents/`. The cleanup script also handles this automatically when the issue worktree is removed.

---

*Generated for Issue #485 on 2026-04-07*
