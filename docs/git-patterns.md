# Git Patterns

Common git workflows for Sequant development.

## Merging PRs with Active Worktrees

Worktrees lock their branches - you can't delete a branch that's checked out in a worktree.

### Option A: Remove worktrees first (recommended)

```bash
# 1. Remove the worktree
git worktree remove /path/to/worktree

# 2. Merge with branch cleanup
gh pr merge <N> --squash --delete-branch
```

### Option B: Merge first, clean up after

```bash
# 1. Merge WITHOUT --delete-branch
gh pr merge <N> --squash

# 2. Remove the worktree
git worktree remove /path/to/worktree

# 3. Delete local branch manually
git branch -D feature/<N>-*
```

### Batch cleanup

After merging multiple PRs with worktrees:

```bash
# List all worktrees
git worktree list

# Remove merged worktrees
git worktree remove /path/to/worktree1
git worktree remove /path/to/worktree2

# Clean up stale branches
git fetch --prune
git branch -vv | grep ': gone]' | awk '{print $1}' | xargs git branch -D
```

## Creating Feature Worktrees

Standard pattern for new feature work:

```bash
# Create worktree with new branch
git worktree add ../worktrees/feature/<N>-<slug> -b feature/<N>-<slug>

# Or use the helper script
./scripts/dev/new-feature.sh <N>
```

## Worktree Locations

By convention, worktrees live in a sibling directory:

```
~/Projects/
├── sequant/              # Main repo
└── worktrees/
    └── feature/
        ├── 10-windows-docs/
        ├── 29-phase-detection/
        └── ...
```

This keeps worktrees separate from the main repo while allowing easy access.
