# State Command

**Quick Start:** Manage workflow state for existing worktrees. Use `sequant state` to bootstrap state tracking for worktrees created before state management was enabled, rebuild corrupted state, or clean up orphaned entries.

## Access

- **Command:** `sequant state <subcommand>`
- **Subcommands:** `init`, `rebuild`, `clean`

## Overview

The `sequant state` command provides utilities for managing the `.sequant/state.json` file, which tracks workflow progress for each issue. This is useful when:

- You have existing worktrees that were created before state tracking was enabled
- The state file becomes corrupted or out of sync
- You want to clean up entries for deleted worktrees

## Subcommands

### `sequant state init`

Populate state for untracked worktrees. Scans all git worktrees, identifies those with issue-related branch names, and adds them to the state file.

```bash
sequant state init
```

**What it does:**
1. Runs `git worktree list` to find all worktrees
2. Parses branch names to extract issue numbers (supports `feature/123-*`, `issue-123`, `123-*` patterns)
3. Fetches issue titles from GitHub using `gh` CLI
4. Infers current phase from existing run logs (if available)
5. Adds entries to `.sequant/state.json`

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output results as JSON (for scripting) |
| `-v, --verbose` | Show detailed progress during discovery |

**Example output:**
```
🔍 Discovering untracked worktrees...

✓ Added #117: Add state bootstrapping for existing worktrees
  Branch: feature/117-state-bootstrapping
  Inferred phase: exec

✓ Added #119: Integrate state updates into all workflow skills
  Branch: feature/119-state-integration

Summary:
  Worktrees scanned: 6
  Already tracked: 2
  Newly added: 2
```

### `sequant state rebuild`

Recreate the entire state file from scratch by combining run logs and worktree discovery.

```bash
sequant state rebuild --force
```

**What it does:**
1. Scans `.sequant/logs/` for all run logs
2. Extracts issue information and phase history from logs
3. Discovers additional worktrees not in logs
4. Creates a fresh state file

**Options:**

| Option | Description |
|--------|-------------|
| `-f, --force` | Required. Confirms you want to replace the existing state file |
| `--json` | Output results as JSON |
| `-v, --verbose` | Show detailed progress |

**Example output:**
```
🔄 Rebuilding state from scratch...

Step 1: Rebuilding from run logs...
Step 2: Discovering untracked worktrees...

✓ State rebuilt successfully
  Logs processed: 15
  Issues from logs: 8
  Worktrees scanned: 6
  Worktrees added: 2

Run `sequant status --issues` to see the rebuilt state.
```

### `sequant state clean`

Remove entries for worktrees that no longer exist (orphaned entries).

```bash
sequant state clean --dry-run
```

**What it does:**
1. Checks each state entry against active git worktrees
2. Identifies orphaned entries (worktree path no longer exists)
3. Optionally removes old merged/abandoned issues by age
4. Updates or removes entries based on their status

**Options:**

| Option | Description |
|--------|-------------|
| `-d, --dry-run` | Preview what would be cleaned without making changes |
| `--max-age <days>` | Also remove merged/abandoned issues older than N days |
| `--json` | Output results as JSON |
| `-v, --verbose` | Show detailed progress |

**Example output:**
```
🧹 Cleanup preview (dry run)...

Preview (no changes made):
  Orphaned (worktree missing): #42, #55

Run without --dry-run to apply these changes.
```

## Common Workflows

### Bootstrap State for Existing Project

When you first enable state tracking on a project with existing worktrees:

```bash
# 1. Initialize state for all existing worktrees
sequant state init

# 2. Verify the state was populated correctly
sequant status --issues
```

### Recover from Corrupted State

If your state file becomes corrupted or inconsistent:

```bash
# 1. Rebuild state from logs and worktrees
sequant state rebuild --force

# 2. Verify the rebuilt state
sequant status --issues
```

### Clean Up After Deleting Worktrees

After removing old worktrees manually:

```bash
# 1. Preview what will be cleaned
sequant state clean --dry-run

# 2. If the preview looks correct, apply changes
sequant state clean
```

### Remove Old Completed Issues

To clean up issues that were merged more than 30 days ago:

```bash
sequant state clean --max-age 30
```

## JSON Output for Scripting

All subcommands support `--json` for integration with scripts:

```bash
# Get discovered worktrees as JSON
sequant state init --json | jq '.discovered[].issueNumber'

# Check for orphaned entries
sequant state clean --dry-run --json | jq '.orphaned'
```

## Troubleshooting

### Worktree not discovered

**Symptoms:** A worktree exists but `state init` doesn't find it.

**Solution:** Check that the branch name matches one of these patterns:
- `feature/<number>-<description>`
- `issue-<number>`
- `<number>-<description>`

Branches like `feature/dashboard` without an issue number won't be discovered.

### GitHub title fetch fails

**Symptoms:** Issue titles show as "(title unavailable for #123)".

**Solution:** Ensure `gh` CLI is installed and authenticated:
```bash
gh auth status
```

The state will still be created with a placeholder title, which you can update later.

### State rebuild requires --force

**Symptoms:** Running `sequant state rebuild` shows a warning and exits.

**Solution:** This is a safety feature. Add `--force` to confirm:
```bash
sequant state rebuild --force
```

---

*Generated for Issue #117 on 2026-01-20*
