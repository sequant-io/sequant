# Status Reconciliation

`sequant status` reconciles local workflow state with GitHub on every invocation, so what you see always reflects reality — not a stale cache.

## Prerequisites

1. **`gh` CLI** authenticated — `gh auth status`
2. **`.sequant/state.json`** exists — created automatically by `sequant run`

## What It Does

Every time you run `sequant status`, it:

1. Reads local state (`.sequant/state.json`)
2. Batch-queries GitHub for live issue/PR state (single GraphQL call)
3. Checks the filesystem for worktree existence
4. Auto-heals unambiguous drift (merged PRs, closed issues, missing worktrees)
5. Flags ambiguous drift for you to resolve
6. Displays results with next-action hints and relative timestamps

## What You See

```
Issue    Title                            Status              Phase      Next
#413     Spec skill: Design Review        ready_for_merge     qa         → gh pr merge 424
#404     Default execution mode           in_progress         exec       → sequant run 404
#422     AC parser: bold format           not_started         -          → sequant run 422

  ✓ Auto-healed: PR #424 merged on GitHub

  Last synced: just now
```

Each row shows:

| Column | Description |
|--------|-------------|
| Issue | GitHub issue number |
| Title | Live title from GitHub (updated automatically) |
| Status | Current workflow status |
| Phase | Current or last phase |
| Next | Suggested next action |

## Auto-Healing

The following drift is detected and fixed automatically:

| Drift | Action Taken |
|-------|-------------|
| PR merged on GitHub | Status updated to `merged` |
| Issue closed on GitHub (no merged PR) | Status updated to `abandoned` |
| Worktree directory deleted (issue closed or has PR) | Worktree field cleared |

## Ambiguous Drift Warnings

Some situations require your judgment. These are flagged, not auto-healed:

| Situation | Warning |
|-----------|---------|
| Worktree deleted, issue still open, no PR | "Worktree deleted but issue still open on GitHub with no PR" |
| Worktree deleted, GitHub unreachable | "Worktree deleted but GitHub state unknown (API unreachable)" |
| Marked abandoned locally, still open on GitHub | "Issue marked abandoned locally but still open on GitHub" |

## Offline Mode

Skip GitHub queries entirely with `--offline`. Useful when rate-limited or working without network access.

```bash
sequant status --offline
```

Output shows cached data with an `(offline)` indicator on the Last synced line.

## Existing Flags

All existing flags continue to work unchanged:

| Flag | Description |
|------|-------------|
| `--issues` | Show only issue tracking table |
| `--issue <N>` | Show details for a single issue |
| `--json` | Output as JSON (includes `nextAction`, `lastSynced`, `githubReachable`) |
| `--rebuild` | Rebuild state from run logs |
| `--cleanup` | Remove stale/orphaned entries |
| `--dry-run` | Preview cleanup without changes |
| `--max-age <days>` | Remove entries older than N days |
| `--all` | Remove all orphaned entries |
| `--offline` | Skip GitHub queries (pure local state) |

## Concurrent Access Safety

Reconciliation is safe to run during an active `sequant run`. The entire read-modify-write cycle (including GitHub API calls) is wrapped in a file lock, so it never overwrites phase updates from a running workflow.

This means you can call `sequant status` or `sequant_status` (MCP) while issues are executing without risking state regression.

## MCP Tool

The `sequant_status` MCP tool uses the same reconciliation pipeline. Every call reconciles with GitHub before returning data.

Response includes:

| Field | Description |
|-------|-------------|
| `nextAction` | Suggested next command |
| `lastSynced` | ISO timestamp of last reconciliation |
| `githubReachable` | Whether GitHub was reachable |
| `warnings` | Ambiguous drift warnings for the queried issue |

## Troubleshooting

### "GitHub unreachable — showing cached data"

**Symptoms:** Warning appears on every `sequant status` call.

**Solution:** Check `gh auth status`. If authenticated, check network connectivity. Use `--offline` to suppress the warning when working without network.

### Status stuck on `ready_for_merge` after merging

**Symptoms:** You merged the PR in the browser but status still shows `ready_for_merge`.

**Solution:** Run `sequant status` — reconciliation will detect the merged PR and auto-heal the status to `merged`. If GitHub is unreachable, the status won't update until the next successful sync.

### Ambiguous drift warning won't go away

**Symptoms:** Same warning appears on every `sequant status` call.

**Solution:** Ambiguous warnings persist until you resolve the underlying situation. For "worktree deleted but issue still open": either recreate the worktree with `sequant run <N>`, close the issue, or run `sequant status --cleanup` to remove the entry.

---

*Updated for Issue #458 on 2026-03-26 (concurrent access safety)*
*Generated for Issue #423 on 2026-03-25*
