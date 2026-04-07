# Worktree Isolation for Parallel Agent Groups

When `/exec` runs parallel agent groups, each agent can optionally get its own
isolated sub-worktree. This prevents file conflicts that occur when multiple
agents write to the same files simultaneously.

## Investigation Results

### Nested Worktrees

Git supports creating worktrees inside existing worktrees. The `.git` file in
the nested worktree correctly resolves to the main repository's
`.git/worktrees/` directory.

**Test result:** `git worktree add .exec-agents/agent-0 -b exec-agent-485-0`
succeeds inside an issue worktree. No path conflicts with sequant's conventions.

### Performance

| Operation | Time | Notes |
|-----------|------|-------|
| `git worktree add` | ~400ms | No npm install needed |
| `node_modules` symlink | ~13ms | Reuses issue worktree's node_modules |
| `git worktree remove` | ~130ms | Includes branch cleanup |
| **Total per agent** | **~550ms** | Negligible vs. agent execution time |

### Merge-Back Strategy

Selected: `git merge --no-ff` with temporary branches.

| Strategy | Pros | Cons | Verdict |
|----------|------|------|---------|
| `git merge --no-ff` | Built-in conflict detection, standard markers | Requires branch per agent | **Selected** |
| `git diff \| git apply` | Lightweight | No conflict markers, fails silently | Rejected |
| `cherry-pick` | Preserves individual commits | Complex with multiple commits | Rejected |
| `rsync + git add` | Simple file copy | No conflict detection | Rejected |

## How It Works

```
Issue worktree: ../worktrees/feature/485-eval/
├── .exec-agents/           ← sub-worktree directory
│   ├── agent-0/            ← agent 0's isolated copy
│   ├── agent-1/            ← agent 1's isolated copy
│   └── agent-2/            ← agent 2's isolated copy
├── src/                    ← issue worktree files
└── node_modules/           ← shared via symlink
```

### Lifecycle

1. **Create:** For each agent in a parallel group, `createSubWorktree()` creates
   a git worktree at `.exec-agents/agent-<N>/`, symlinks `node_modules`, and
   copies environment files.

2. **Execute:** Each agent works in its own sub-worktree. All changes are
   committed to a temporary branch (`exec-agent-<issue>-<N>`).

3. **Merge back:** After all agents complete, `mergeAllSubWorktrees()` merges
   each agent's branch into the issue branch using `git merge --no-ff`.

4. **Cleanup:** Sub-worktrees and temporary branches are removed.

### Conflict Handling

- **No conflict:** New files from different agents merge cleanly.
- **Conflict detected:** The merge is aborted, conflict files are reported, and
  the exec skill flags the conflict for the next iteration.
- **Partial merge:** If agent A conflicts but agent B doesn't, agent B's changes
  are still merged. Only agent A's changes are flagged.

## Configuration

### Settings

In `.sequant/settings.json`:

```json
{
  "agents": {
    "isolateParallel": true
  }
}
```

Default: `false` (opt-in for v1).

### CLI Flag

```bash
npx sequant run 485 --isolate-parallel
```

The CLI flag overrides the settings value.

### When Disabled

When `isolateParallel` is `false` (default), parallel agents share the issue
worktree exactly as before. No sub-worktrees are created.

## `.worktreeinclude` File

The `.worktreeinclude` file at the repository root lists files to copy into
sub-worktrees (one path per line, `#` for comments):

```
.env
.env.local
.env.development
.claude/settings.local.json
```

If the file doesn't exist, the module falls back to a hardcoded default list
matching the same files above.

## Cleanup

### Normal Cleanup

Sub-worktrees are automatically removed after merge-back (success or failure).

### Orphaned Sub-Worktrees

If a session is interrupted, orphaned sub-worktrees may remain. These are
cleaned up by:

- `scripts/cleanup-worktree.sh` — cleans `.exec-agents/` before removing the
  issue worktree
- `cleanupOrphanedSubWorktrees()` — programmatic cleanup via the
  `worktree-isolation` module
- `git worktree prune` — git's built-in stale worktree cleanup

## API Reference

### `createSubWorktree(issueWorktreePath, agentIndex)`

Creates a sub-worktree for a parallel agent.

- **Returns:** `SubWorktreeInfo | null` (null on failure)
- **Side effects:** Creates directory, symlinks node_modules, copies env files

### `mergeAllSubWorktrees(issueWorktreePath, subWorktrees)`

Merges all sub-worktree branches back into the issue branch.

- **Returns:** `MergeBackResult` with per-agent results
- **Conflict handling:** Aborts conflicting merges, continues with others

### `cleanupAllSubWorktrees(issueWorktreePath, subWorktrees?)`

Removes sub-worktrees, branches, and orphaned entries.

### `formatMergeResult(result)`

Formats merge results for human-readable logging.
