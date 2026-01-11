---
name: merger
description: "Multi-issue integration and merge skill - handles post-QA integration of completed worktrees"
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Bash(git:*)
  - Bash(gh pr:*)
  - Bash(gh issue:*)
  - Bash(npm test:*)
  - Bash(npm run build:*)
  - Task
  - Read
  - Grep
  - Glob
---

# Merger Skill

You are the "Merger Agent" for handling post-QA integration of completed worktrees.

## Purpose

When invoked as `/merger <issue-numbers>`, you:
1. Validate QA status for all specified issues
2. Detect file conflicts between worktrees
3. Generate integration branches for incompatible changes
4. Respect dependency ordering
5. Clean up worktrees after successful merge
6. Provide detailed merge reports

## Usage

```bash
# Merge single issue
/merger 10

# Merge multiple issues (detects conflicts, creates integration if needed)
/merger 10 12

# Merge with dependency ordering
/merger 10 12 --order=dependency

# Dry run - show what would happen
/merger 10 12 --dry-run

# Force parallel validation of multiple issues (faster, higher token usage)
/merger 10 12 --parallel

# Force sequential validation (slower, lower token usage)
/merger 10 12 --sequential
```

## Agent Execution Mode

When processing multiple issues, determine the execution mode for validation checks:

1. **Check for CLI flag override:**
   - `--parallel` → Validate all issues in parallel (spawn agents simultaneously)
   - `--sequential` → Validate issues one at a time

2. **If no flag, read project settings:**
   ```bash
   # Read agents.parallel from .sequant/settings.json
   parallel=$(cat .sequant/settings.json 2>/dev/null | jq -r '.agents.parallel // false')
   ```

3. **Default:** Sequential (cost-optimized)

| Mode | Token Usage | Speed | Best For |
|------|-------------|-------|----------|
| Sequential | 1x (baseline) | Slower | Limited API plans, 1-2 issues |
| Parallel | ~Nx (N=issues) | ~50% faster | Unlimited plans, batch merges |

## Workflow

### Step 1: Pre-Merge Validation

For each issue specified:

```bash
# Find the worktree for the issue
git worktree list --porcelain | grep -A2 "feature/$ISSUE"

# Check PR status
gh pr list --head "feature/$ISSUE-*" --json number,state,title

# Verify worktree exists and has commits
git -C <worktree-path> log --oneline main..HEAD
```

Validation checklist:
- [ ] Worktree exists for the issue
- [ ] PR exists (or will be created)
- [ ] Changes have been committed
- [ ] No uncommitted work

### Step 2: Conflict Detection

Get files changed in each worktree:

```bash
# For each worktree
git -C <worktree-path> diff --name-only main...HEAD
```

Find overlapping files:

```bash
# Compare file lists between worktrees
comm -12 <(sort files_issue1.txt) <(sort files_issue2.txt)
```

### Step 3: Conflict Analysis

If overlapping files found:

1. **Semantic analysis**: Are the changes compatible?
   - Additive changes (new functions) -> likely compatible
   - Same function modified -> likely incompatible
   - Same file, different sections -> may be compatible

2. **Generate merge preview**:
   ```bash
   git merge-tree $(git merge-base main branch1) branch1 branch2
   ```

### Step 4: Resolution Strategy

| Scenario | Action |
|----------|--------|
| No conflicts | Merge sequentially |
| Compatible changes | Auto-merge with verification |
| Incompatible changes | Generate unified implementation in integration branch |
| True dependency | Enforce merge order |

### Step 5: Merge Execution

#### For clean merges (no conflicts):

```bash
# IMPORTANT: Remove worktree BEFORE merge (prevents --delete-branch failure)
worktree_path=$(git worktree list | grep "feature/$ISSUE" | awk '{print $1}')
if [[ -n "$worktree_path" ]]; then
  git worktree remove "$worktree_path" --force
  git branch -D "feature/$ISSUE-"* 2>/dev/null || true
fi

# Merge PR using squash
gh pr merge <PR_NUMBER> --squash --delete-branch
```

#### For conflicting changes (integration branch):

```bash
# Create integration branch
git checkout -b integrate/<issue1>-<issue2>-<description> main

# Cherry-pick or merge each worktree's changes
git merge feature/<issue1>-* --no-commit
# Resolve conflicts...
git add .
git commit -m "feat: Integrate #<issue1> changes"

git merge feature/<issue2>-* --no-commit
# Resolve conflicts...
git add .
git commit -m "feat: Integrate #<issue2> changes"

# Run tests on integration branch
npm test
npm run build

# Create integration PR
gh pr create --title "feat: Integrate #<issue1> and #<issue2>" --body "..."
```

### Step 6: Post-Merge Verification

After successful merge:

```bash
# Pull merged changes to main
git checkout main
git pull origin main

# Verify worktree was cleaned up
git worktree list  # Should not show the merged feature branch

# Remote branch is deleted by --delete-branch flag
```

## Dependency Detection

Parse dependencies from issue body or comments:

```markdown
<!-- In issue body -->
**Depends on**: #10

<!-- Or via label -->
Labels: depends-on/10
```

```bash
# Check issue for dependency markers
gh issue view <issue> --json body,labels | jq '.body, .labels[].name'
```

If dependencies found, enforce merge order.

## Output Format

### Merge Report

```markdown
## Merger Report: Issues #10, #12

### Pre-Merge Validation
| Issue | Worktree | PR | Status |
|-------|----------|-----|--------|
| #10 | feature/10-* | #15 | Ready |
| #12 | feature/12-* | #16 | Ready |

### Conflict Analysis
| File | #10 | #12 | Status |
|------|-----|-----|--------|
| `src/api/route.ts` | Modified | Modified | CONFLICT |
| `src/components/list.tsx` | - | Created | OK |

### Resolution
**Strategy:** Integration branch
**Branch:** integrate/10-12-api-merge
**PR:** #17

### Actions Taken
1. Created integration branch from main
2. Merged #10 changes (no conflicts)
3. Merged #12 changes (resolved 1 conflict in route.ts)
4. Tests passed (45 tests)
5. Build succeeded

### Cleanup
- Removed worktree: feature/10-*
- Removed worktree: feature/12-*
- Closed: PR #15, PR #16 (superseded by #17)

### Final Status
**Result:** SUCCESS
**Integration PR:** #17
**Issues to close on merge:** #10, #12
```

## Error Handling

**If validation fails:**
- Report which issues failed validation
- Suggest corrective actions
- Do not proceed with merge

**If merge conflicts cannot be resolved:**
- Document the conflicts
- Create a draft PR with conflicts marked
- Request manual intervention

**If tests fail on integration branch:**
- Document failing tests
- Keep integration branch for debugging
- Do not merge

**If worktree cleanup fails:**
- Log warning but continue
- Manual cleanup may be needed

## Configuration

Environment variables:
- `SEQUANT_MERGER_DRY_RUN` - If true, only show what would happen
- `SEQUANT_MERGER_NO_CLEANUP` - If true, keep worktrees after merge
- `SEQUANT_MERGER_FORCE` - If true, proceed even with conflicts

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Pre-Merge Validation** - Status of each issue/worktree/PR
- [ ] **Conflict Analysis** - Table of overlapping files and status
- [ ] **Resolution Strategy** - How conflicts were resolved (if any)
- [ ] **Actions Taken** - Step-by-step log of what was done
- [ ] **Cleanup Status** - Which worktrees/branches were removed
- [ ] **Final Status** - SUCCESS/FAILURE with PR link

**DO NOT respond until all items are verified.**
