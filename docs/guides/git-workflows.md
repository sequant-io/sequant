# Git Workflows

Git patterns and worktree strategies for Sequant development.

## Worktree Basics

### Creating Feature Worktrees

Standard pattern for new feature work:

```bash
# Create worktree with new branch
git worktree add ../worktrees/feature/<N>-<slug> -b feature/<N>-<slug>

# Or use the helper script
./scripts/dev/new-feature.sh <N>
```

### Worktree Locations

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

---

## Feature Branch Workflows

Use feature integration branches instead of branching directly from `main`.

### When to Use Custom Base Branches

Use the `--base` flag when:

- **Feature integration branches**: Working on multiple related issues that should integrate before merging to main
- **Release branches**: Preparing a release with multiple fixes/features
- **Team branches**: In monorepos where teams have dedicated integration branches
- **Epic development**: Building a large feature across multiple issues

### One-off Override (CLI Flag)

```bash
# Branch issue #117 from feature/dashboard instead of main
npx sequant run 117 --base feature/dashboard

# Multiple issues from the same base
npx sequant run 117 118 119 --base feature/dashboard

# Chain mode with custom base
npx sequant run 117 118 119 --sequential --chain --base feature/dashboard
```

### Project Configuration (Persistent)

Set a default base branch for all `sequant run` commands:

```json
// .sequant/settings.json
{
  "run": {
    "defaultBase": "feature/dashboard"
  }
}
```

Now all runs use `feature/dashboard` as base:

```bash
npx sequant run 117  # Branches from feature/dashboard
```

Override with CLI flag when needed:

```bash
npx sequant run 120 --base main  # Override back to main
```

### Resolution Priority

Base branch is resolved in this order (highest priority first):

1. **CLI flag**: `--base <branch>`
2. **Project config**: `.sequant/settings.json` → `run.defaultBase`
3. **Default**: `main`

### Visual Comparison

**Standard Workflow (no --base)**

```
origin/main
    ├── feature/117-add-login
    ├── feature/118-add-logout
    └── feature/119-add-profile
```

All issues branch independently from main.

**Feature Branch Workflow (--base)**

```
origin/main
    └── feature/dashboard  ← integration branch
            ├── feature/117-add-login
            ├── feature/118-add-logout
            └── feature/119-add-profile
```

All issues branch from the integration branch.

**Chain Mode with --base**

```
origin/main
    └── feature/dashboard
            └── feature/117-add-login
                    └── feature/118-add-logout
                            └── feature/119-add-profile
```

Each issue builds on the previous, starting from the integration branch.

### Chain Mode with --qa-gate

For critical chains where you want to ensure each issue passes QA before the next begins:

```bash
npx sequant run 117 118 119 --sequential --chain --qa-gate --base feature/dashboard
```

This prevents downstream issues from building on potentially broken code.

### Example: Dashboard Feature Development

You have a `feature/dashboard` integration branch and 5 related issues:

```bash
# Option 1: Run independently (parallel)
npx sequant run 117 118 119 120 121 --base feature/dashboard

# Option 2: Run as a chain (sequential dependencies)
npx sequant run 117 118 119 120 121 --sequential --chain --base feature/dashboard

# Option 3: Set config and run without flag
echo '{"run": {"defaultBase": "feature/dashboard"}}' > .sequant/settings.json
npx sequant run 117 118 119 120 121
```

### Script Usage

The `new-feature.sh` script also supports `--base`:

```bash
# Create worktree from feature branch
./scripts/dev/new-feature.sh 117 --base feature/dashboard

# With stash
./scripts/dev/new-feature.sh 117 --base feature/dashboard --stash
```

## Best Practices

1. **Keep integration branches fresh**: Regularly merge main into your integration branch
2. **Use chain mode for dependencies**: When issues must be implemented in order
3. **Limit chain length**: Recommended max 5 issues per chain
4. **Config for team branches**: Use `settings.json` when team consistently uses same base
5. **Override for exceptions**: Use `--base main` when an issue should bypass the integration branch

## Troubleshooting

### "Branch does not exist" Error

The base branch must exist on the remote:

```bash
# Check if branch exists
git branch -r | grep feature/dashboard

# If not, create and push it first
git checkout -b feature/dashboard
git push -u origin feature/dashboard
```

### Merge Conflicts

When working on an integration branch, conflicts may arise:

1. Update your integration branch: `git pull origin main` (on integration branch)
2. Rebase feature branches if needed
3. Re-run the failed issue

### Config Not Working

Verify your settings file:

```bash
cat .sequant/settings.json | jq '.run.defaultBase'
```

Ensure valid JSON syntax and correct field name (`defaultBase`, not `baseBranch`).
