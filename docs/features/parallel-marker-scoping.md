# Project-Scoped Parallel-Group Markers

When `/exec` runs a parallel agent group, it drops a marker file in the temp directory so the pre-tool and post-tool hooks know which worktree to enforce file operations against. As of #881, that marker is scoped per project — parallel groups in two different repos on the same machine can no longer interfere with each other's worktree enforcement.

## Prerequisites

Nothing to install or configure. The scheme is active automatically once the updated hooks and `/exec` skill are in place:

1. **Hooks present** — `ls .claude/hooks/parallel-marker.sh pre-tool.sh post-tool.sh` (paths relative to `.claude/hooks/`)
2. **Hooks in sync** — `npx tsx scripts/check-skill-sync.ts` (covers skill mirrors; hook mirrors are checked by `npm run lint:hook-sync` in CI)

## What Changed for You

Before this fix, the marker filename was a global constant (`/tmp/claude-parallel-group-1.marker`). If two projects ran parallel groups at the same time — routine on a machine where sequant is npm-linked into other repos — whichever session lost the race had its worktree guard pointed at the *other* project's worktree. You would see edits rejected with a worktree path from a repo you weren't working in:

```
HOOK_BLOCKED: File operation must be within worktree
  Worktree: /tmp/some-other-projects-worktree/...
  File:     /Users/you/Projects/worktrees/feature/123-your-actual-file.ts
```

It cleared on retry once the other run finished, so it looked like a transient glitch. Worse, the losing session's guard was pointed somewhere meaningless for the duration — the protection against editing the main repo instead of the worktree was silently off.

Now each marker carries a hash of its owning project root in the filename, and the hooks only read markers belonging to the current project. Concurrent parallel runs in different repos are fully independent.

## What to Expect

- **No behavior change in single-project use.** Parallel groups work exactly as before.
- **Concurrent runs in different repos no longer cross-talk.** Each session enforces only its own project's marker.
- **`SEQUANT_WORKTREE` still wins.** When the orchestrator sets it, the marker is never consulted — that precedence is unchanged.
- **Stale or hand-placed markers are ignored.** A marker whose stored project root doesn't match the current project is skipped, not enforced.

## How It Works (Reference)

The naming scheme lives in exactly one place — `parallel-marker.sh`, sourced by the `/exec` skill (the writer) and both hooks (the readers) — so the writer and readers cannot drift apart.

| Aspect | Value |
|--------|-------|
| Marker path | `${TMPDIR}/claude-parallel-<project-hash>-<group-id>.marker` |
| Project hash | md5 of the project root (`md5 -q` on macOS, `md5sum` fallback on Linux) |
| Project root | `$CLAUDE_PROJECT_DIR` if set (Claude Code sets it for both skill and hook shells), else `git rev-parse --show-toplevel`, else `$PWD` |
| Marker contents | line 1 = worktree path to enforce, line 2 = owning project root |
| Resolution order | `SEQUANT_WORKTREE` env var → first *project-scoped* marker whose stored root matches |

Helper functions (for skill/hook authors):

| Function | Returns |
|----------|---------|
| `parallel_marker_project_root` | Canonical project identity, derived identically in skill and hook contexts |
| `parallel_marker_hash` | Stable per-project hash used in the filename |
| `parallel_marker_prefix` | The project-scoped glob prefix both readers use |
| `parallel_marker_path <group-id>` | Full marker path for one group |

Defense-in-depth: even if a marker's *filename* collides (hand-crafted or stale), the enforcement reader compares the stored project root on line 2 against the current project and ignores any mismatch.

## Troubleshooting

### Edits blocked with a worktree path from another project

**Symptoms:** `HOOK_BLOCKED: File operation must be within worktree` naming a directory belonging to a different repo.

**Solution:** This was the #881 bug and should no longer occur with current hooks. If you still see it, your hook copies are stale — run `sequant update` (or `sequant sync` in the dev repo) to refresh `.claude/hooks/`, and verify `parallel-marker.sh` exists alongside `pre-tool.sh`.

### Marker file lingers after a parallel group finishes

**Symptoms:** `ls ${TMPDIR:-/tmp}/claude-parallel-*` shows an old `.marker` file from a completed run.

**Solution:** Harmless — a leftover marker only matches its own project, and the stored-root guard ignores anything stale that doesn't. Delete it by hand if you like: `rm -f ${TMPDIR:-/tmp}/claude-parallel-*.marker`. Markers are also cleared by the OS temp purge.

### Enforcement seems inactive during a parallel group

**Symptoms:** Edits outside the worktree are not being blocked while agents run.

**Solution:** Check the marker was actually written with the project-scoped name: `ls ${TMPDIR:-/tmp}/claude-parallel-*.marker` and confirm one exists whose second line (`sed -n 2p <marker>`) matches your project root. If the skill and hooks derive different roots (e.g. `CLAUDE_PROJECT_DIR` set in one context but not the other pointing at different directories), markers are written and read under different names — both contexts must agree.

---

*Generated for Issue #881 on 2026-08-03*
