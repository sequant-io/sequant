# Worktree Isolation

Sequant uses Git worktrees to isolate each issue's work, keeping your main branch clean.

## What Are Worktrees?

Git worktrees let you check out multiple branches simultaneously in different directories. Each worktree is an independent working copy of your repository.

```
project/                    # Main repo (stays on main)
├── .git/
├── src/
└── ...

../worktrees/
└── feature/
    └── 123-add-caching/   # Worktree for issue #123
        ├── .git           # Link to main .git
        ├── src/
        └── ...
```

## Why Worktrees?

### Problem: Branch Pollution

Without isolation, half-finished work pollutes your main branch:

```bash
# Traditional workflow
git checkout -b feature/123
# Work on feature...
# Urgent bug comes in!
git stash
git checkout main
git checkout -b hotfix/456
# Fix bug...
# Where was I with feature/123?
git checkout feature/123
git stash pop
# Conflicts? Lost context?
```

### Solution: Worktree Isolation

With Sequant, each issue gets its own directory:

```bash
# Issue #123 in progress
cd ../worktrees/feature/123-add-caching/
# Urgent bug comes in!
# Just switch directories
cd ../worktrees/feature/456-fix-auth/
# Work on bug...
# Return to #123 anytime
cd ../worktrees/feature/123-add-caching/
# Everything is exactly as you left it
```

## How Sequant Uses Worktrees

### Creation

When `/exec` runs, it creates a worktree:

```bash
# Automatically called by /exec
./scripts/dev/new-feature.sh 123
```

This:
1. Fetches issue details from GitHub
2. Creates branch: `feature/123-issue-title-slug`
3. Creates worktree in: `../worktrees/feature/123-issue-title-slug/`
4. Installs dependencies
5. Copies environment files

### Location

Worktrees are created as siblings to your main repo:

```
~/projects/
├── my-app/                    # Main repo
└── worktrees/
    └── feature/
        ├── 123-add-caching/   # Issue #123
        ├── 124-fix-auth/      # Issue #124
        └── 125-update-ui/     # Issue #125
```

### Cleanup

After merging a PR, clean up the worktree:

```bash
# Manual cleanup
./scripts/dev/cleanup-worktree.sh feature/123-add-caching

# Or let /clean handle it
/clean
```

## Working in Worktrees

### Navigate to Worktree

```bash
# Find worktrees
git worktree list

# Output:
# /Users/you/projects/my-app                    2d22744 [main]
# /Users/you/projects/worktrees/feature/123...  abc1234 [feature/123-...]

# Navigate
cd ../worktrees/feature/123-add-caching/
```

### Running Commands

Run all commands from within the worktree:

```bash
# In worktree directory
npm test
npm run build
git status
git commit -m "feat: add caching"
```

### Pushing Changes

Push from the worktree:

```bash
# In worktree
git push -u origin feature/123-add-caching

# Create PR
gh pr create --fill
```

## Benefits

### Clean Main Branch

Your main branch is never polluted with work-in-progress:

```bash
cd ~/projects/my-app
git status
# On branch main
# nothing to commit, working tree clean
```

### Parallel Work

Work on multiple issues simultaneously:

```bash
# Terminal 1: Issue #123
cd ../worktrees/feature/123-add-caching/
npm run dev

# Terminal 2: Issue #124
cd ../worktrees/feature/124-fix-auth/
npm test

# Both running independently
```

### Safe Experimentation

Experiment without fear:

```bash
# In worktree
# Try something crazy...
rm -rf src/
# Oops!

# Just delete the worktree and start over
cd ..
rm -rf feature/123-add-caching/
git worktree prune
/exec 123  # Fresh start
```

### Context Preservation

Return to any issue with full context:

- IDE state (if using workspace per worktree)
- Terminal history
- Uncommitted changes
- Development server state

## Safety Safeguards

Sequant includes automatic safeguards to prevent accidental work loss.

### Hard Reset Protection

The pre-tool hook blocks `git reset --hard` when unpushed commits exist on main:

```bash
# This will be blocked if you have unpushed commits on main
git reset --hard origin/main
# HOOK_BLOCKED: 3 unpushed commit(s) on main would be lost
#   Push first: git push origin main
#   Or stash: git stash
```

**Why this matters:** Work can be permanently lost when `git reset --hard` runs before changes are pushed. This safeguard prevents accidental data loss during sync operations.

**To bypass (if intentional):**
```bash
CLAUDE_HOOKS_DISABLED=true git reset --hard origin/main
```

### Main Branch Protection

The `/exec` skill refuses to implement directly on main/master branch:

```bash
# Check your branch before implementing
git rev-parse --abbrev-ref HEAD
# If on 'main' - create a worktree first!
./scripts/dev/new-feature.sh <issue-number>
```

**Why this matters:**
- Work on main is vulnerable to sync operations
- No branch means no recovery via reflog
- Worktrees provide isolated, recoverable work environments

### Hook Log

All blocked operations are logged for debugging:

```bash
# View blocked operations
cat /tmp/claude-hook.log

# View quality warnings
cat /tmp/claude-quality.log
```

## Common Operations

### List Worktrees

```bash
git worktree list
```

### Remove a Worktree

```bash
# Remove worktree directory
rm -rf ../worktrees/feature/123-add-caching/

# Prune the Git reference
git worktree prune

# Delete the branch (optional)
git branch -D feature/123-add-caching
```

### Clean Up Stale Worktrees

```bash
# Remove worktrees for merged branches
/clean
```

## Troubleshooting

### "fatal: is already checked out"

This happens when trying to check out a branch that's in a worktree:

```bash
# Find which worktree has the branch
git worktree list | grep branch-name

# Remove that worktree first
git worktree remove ../worktrees/feature/branch-name
```

### Disk Space

Worktrees share `.git` but duplicate working files. Monitor disk usage:

```bash
# Check size
du -sh ../worktrees/feature/*

# Clean up after merging
/clean
```

### Dependencies Out of Sync

If dependencies differ between worktrees:

```bash
# In each worktree
rm -rf node_modules
npm install
```
