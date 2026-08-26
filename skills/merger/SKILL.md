---
name: merger
description: "Multi-issue integration and merge skill - handles post-QA integration of completed worktrees"
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Bash(npx sequant worktree:*)
  - Bash(git:*)
  - Bash(gh pr:*)
  - Bash(gh issue:*)
  - Bash(npm test:*)
  - Bash(npm run build:*)
  - Read
  - Grep
  - Glob
---

<!-- sequant:local-override -->
> **Local overrides (read this first).** Before following any instruction below, check whether `.claude/.local/skills/merger/overrides.md` exists. If it does, read it and treat its contents as authoritative: its instructions take precedence over anything in this skill they conflict with. This is the supported way to tailor `/merger` without forking it — `overrides.md` lives under `.claude/.local/`, which `sequant update` and `sync` never overwrite.

# Merger Skill

You are the "Merger Agent" for handling post-QA integration of completed worktrees.

## Purpose

When invoked as `/merger <issue-numbers>`, you:
1. Capture baseline metrics on main (build errors, test counts)
2. Validate QA status for all specified issues
3. Detect file conflicts between worktrees
4. Generate integration branches for incompatible changes
5. Respect dependency ordering
6. Clean up worktrees after successful merge
7. Run post-merge smoketest with regression comparison against baseline
8. Provide detailed merge reports

### Recommended Pre-Merge Check

Before running `/merger`, use `sequant merge --check` to catch cross-issue gaps at zero AI cost:

```bash
sequant run 10 11 12          # implement
sequant merge --check         # verify (deterministic checks)
/merger 10 11 12              # merge (this command)
```

`sequant merge` detects merge conflicts, template mirroring gaps, file overlaps, and residual patterns before `/merger` attempts the actual merge. See `docs/reference/merge-command.md` for details.

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

# Skip post-merge smoketest
/merger 10 12 --skip-smoketest

# Force merge even if regression is detected (bypasses regression gate)
/merger 10 12 --force
```

## Agent Execution Mode

When processing multiple issues, determine the execution mode for validation checks:

1. **Check for CLI flag override:**
   - `--parallel` → Validate all issues in parallel (spawn agents simultaneously)
   - `--sequential` → Validate issues one at a time

2. **If no flag, read project settings:**
   Use the Read tool to check project settings:
   ```
   Read(file_path=".sequant/settings.json")
   # Parse JSON and extract agents.parallel (default: false)
   ```

3. **Default:** Sequential (cost-optimized)

| Mode | Token Usage | Speed | Best For |
|------|-------------|-------|----------|
| Sequential | 1x (baseline) | Slower | Limited API plans, 1-2 issues |
| Parallel | ~Nx (N=issues) | ~50% faster | Unlimited plans, batch merges |

## Workflow

### Acquire the Checkout Lock (REQUIRED)

`/merger` runs branch-mutating git **in the main checkout**: `git checkout main`
for the baseline in Step 0, then `git checkout -b integrate/…` and `git merge` on
the integration path (Step 5), plus the mid-workflow `git checkout main` in
Steps 6–7. Those verbs are global to the working tree, so before the first one
you must claim the checkout lock (#901), exactly as `/fullsolve` does in its
Phase 0.3. Without it a session on another issue can interleave a `git checkout`
and land a merge on the wrong HEAD; and because the guard refuses a *non-holder*,
an unparticipating `/merger` is itself refused when someone else holds the tree.

`/merger` operates on several issues, so identify the holder by the **first issue
number** passed to it and use that same `<first-issue>` on the acquire and on
*every* release below — acquire and release must name the same holder or the
release is refused against your own lock (#906). Substitute the literal number
(e.g. `--issue=10` for `/merger 10 12`); a shell variable is invisible to the
`pre-tool.sh` guard, which reads the command text before the shell expands it.

```bash
# Claim the shared working tree before the first branch-mutating verb.
npx sequant locks checkout acquire \
    --issue=<first-issue> \
    --command="/merger <issue-numbers>" \
    --skip-pid-check || true
# Belt-and-suspenders for a parent that launched us with it; the guard's real
# binding comes from watching the acquire command above (#906).
export SEQUANT_ISSUE=<first-issue>
```

**`--issue` is mandatory** (#906): it is what proves you are the holder on
release, since the acquiring shell's PID is gone by the next block
(`--skip-pid-check`). Stale recovery is therefore age-based only (the 6h
`SEQUANT_SKILL_LOCK_TTL_MS` and the 24h `SEQUANT_MAX_LOCK_AGE_MS` ceiling), not
same-host dead-PID recovery.

**Release contract:** release the checkout lock —
`npx sequant locks checkout release --issue=<first-issue> || true` — on **every**
path that exits `/merger`: happy-path completion (Step 8), the regression-gate
halt (Step 7), and any error/abort in "Error Handling". Do **NOT** release on a
branch that *continues* to a later branch-mutating verb (the #906 distinction):
the integration `git merge` in Step 5 and the `git checkout main` in Steps 6–7
run under the lock and must stay protected until the run ends.

**Orchestrator/MCP mode:** when `SEQUANT_ORCHESTRATOR` is set, every `locks
checkout` action is a no-op (exit 0, no file touched) and the `pre-tool.sh`
checkout guard stands down, so the acquire/release calls are safe to run
unconditionally.

### Step 0: Baseline Capture (REQUIRED)

**Purpose:** Capture build error count and test pass/fail counts on main **before** any merge, so post-merge results can be compared to detect regressions.

**Skip if:** `--skip-smoketest` flag is set (no comparison needed if smoketest is skipped).

**Session caching:** If baseline has already been captured in this `/merger` invocation (e.g., when merging multiple issues), reuse the cached values instead of re-running build and tests.

```bash
# Check if baseline is already cached (multi-issue merge scenario)
if [[ -n "$BASELINE_BUILD_ERRORS" && -n "$BASELINE_TEST_FAILURES" ]]; then
  echo "♻️ Using cached baseline metrics (captured earlier in this session)"
  echo "  Build errors: $BASELINE_BUILD_ERRORS"
  echo "  Test failures: $BASELINE_TEST_FAILURES"
  echo "  Test passes: $BASELINE_TEST_PASSES"
else
  echo "📊 Capturing baseline metrics on main..."

  # Ensure we're on main with latest changes
  git checkout main
  git pull origin main

  # 1. Capture build error count
  build_output=$(npm run build 2>&1 || true)
  BASELINE_BUILD_ERRORS=$(echo "$build_output" | grep -c "error TS" || true)
  echo "  Baseline build errors: $BASELINE_BUILD_ERRORS"

  # 2. Capture test pass/fail counts
  test_output=$(npm test 2>&1 || true)

  # Parse vitest output format: "Tests  X passed | Y failed" or "Tests  X passed"
  # Use tail -1 to get the Tests line (not Test Files line) from vitest output
  BASELINE_TEST_PASSES=$(echo "$test_output" | grep -oE '[0-9]+ passed' | tail -1 | grep -oE '[0-9]+' || echo "0")
  BASELINE_TEST_FAILURES=$(echo "$test_output" | grep -oE '[0-9]+ failed' | tail -1 | grep -oE '[0-9]+' || echo "0")
  echo "  Baseline test passes: $BASELINE_TEST_PASSES"
  echo "  Baseline test failures: $BASELINE_TEST_FAILURES"

  echo "✅ Baseline captured"
fi
```

**Output format (include in merge report):**

```markdown
### Baseline Metrics (main before merge)

| Metric | Count |
|--------|-------|
| Build errors (TS) | $BASELINE_BUILD_ERRORS |
| Test passes | $BASELINE_TEST_PASSES |
| Test failures | $BASELINE_TEST_FAILURES |
```

### Step 1: Pre-Merge Validation

For each issue specified:

```bash
# Find the worktree for the issue. Resolve by branch (#899/#904) — grepping
# for "feature/$ISSUE" is a prefix match, so ISSUE=89 also hits feature/899-*.
worktree_path=$(npx sequant worktree resolve "$ISSUE") || echo "No worktree for #$ISSUE"

# Check PR status
gh pr list --head "feature/$ISSUE-*" --json number,state,title

# Verify worktree exists and has commits
git -C <worktree-path> log --oneline origin/main..HEAD
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
git -C <worktree-path> diff --name-only origin/main...HEAD
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
# Merge PR first (without --delete-branch to avoid worktree lock conflicts)
gh pr merge <PR_NUMBER> --squash

# Only clean up worktree AFTER merge succeeds
# If merge fails, the worktree is preserved so work isn't lost
#
# Resolve by BRANCH, never by grepping the printed path (#899/#904): the path
# line contains the directory slug, so `grep "feature/$ISSUE"` with ISSUE=89
# also matches `feature/899-...` — and the next line force-removes whatever it
# matched. `worktree resolve` matches the branch's issue number exactly, and
# exits non-zero rather than guessing when nothing (or more than one) matches.
if worktree_path=$(npx sequant worktree resolve "$ISSUE"); then
  branch=$(git -C "$worktree_path" rev-parse --abbrev-ref HEAD)
  git worktree remove "$worktree_path" --force
  git branch -D "$branch" 2>/dev/null || true
fi

# Delete remote branch (previously handled by --delete-branch)
gh api repos/{owner}/{repo}/git/refs/heads/$(gh pr view <PR_NUMBER> --json headRefName --jq '.headRefName') -X DELETE 2>/dev/null || true

# State is tracked by the orchestrator runtime when available
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

# Remote branch is deleted explicitly after merge (see Step 5)

# REQUIRED: Verify state was updated (#305)
# The state should show status="merged" for the issue
# Use the Read tool to check state, then parse JSON
Read(file_path=".sequant/state.json")
# Verify the issue status shows "merged"
```

### Step 6a: Worktree Cleanup After Merge (REQUIRED - #305)

**After each successful merge, ensure the worktree is removed:**

```bash
# Find and remove worktree for the issue.
# Resolve by branch, not by grepping the printed path — see the note in the
# clean-merge block above. This one force-removes, so a slug collision here
# destroys an unrelated issue's worktree.
if worktree_path=$(npx sequant worktree resolve "$ISSUE"); then
  echo "Removing worktree: $worktree_path"
  git worktree remove "$worktree_path" --force
else
  echo "No worktree found for #$ISSUE (already cleaned up)"
fi

# Verify worktree removal — resolve must now fail for this issue.
if npx sequant worktree resolve "$ISSUE" >/dev/null 2>&1; then
  echo "WARNING: Worktree still exists"
else
  echo "✅ Worktree removed"
fi
```

**Why this matters:** Leftover worktrees waste disk space and can cause confusion when re-running `sequant run` on the same issues. The state guard (#305) prevents re-execution, but the worktree should still be cleaned up.

### Step 7: Post-Merge Smoketest with Regression Comparison

**Skip if:** `--skip-smoketest` flag is set or `SEQUANT_MERGER_SKIP_SMOKETEST` environment variable is true.

```bash
# Check skip flag
if [[ "$SKIP_SMOKETEST" == "true" ]]; then
  echo "⏭️ Smoketest skipped (--skip-smoketest flag set)"
  # Continue to output report
fi
```

**After all merges complete and worktrees are cleaned up**, verify main is healthy and compare against baseline:

```bash
# 1. Ensure we're on main with latest changes
git checkout main
git pull origin main

# 2. Build verification — capture post-merge error count
echo "Running build..."
post_build_output=$(npm run build 2>&1); build_exit=$?
POST_BUILD_ERRORS=$(echo "$post_build_output" | grep -c "error TS" || true)

# 3. Test suite — capture post-merge test counts
echo "Running tests..."
post_test_output=$(npm test 2>&1); test_exit=$?
POST_TEST_PASSES=$(echo "$post_test_output" | grep -oE '[0-9]+ passed' | tail -1 | grep -oE '[0-9]+' || echo "0")
POST_TEST_FAILURES=$(echo "$post_test_output" | grep -oE '[0-9]+ failed' | tail -1 | grep -oE '[0-9]+' || echo "0")

# 4. CLI health check (if sequant CLI is available)
echo "Running CLI health check..."
npx sequant doctor 2>&1 || true
doctor_exit=$?

# 5. Regression comparison against baseline
REGRESSION_DETECTED=false

BUILD_DELTA=$((POST_BUILD_ERRORS - BASELINE_BUILD_ERRORS))
TEST_FAIL_DELTA=$((POST_TEST_FAILURES - BASELINE_TEST_FAILURES))
TEST_PASS_DELTA=$((POST_TEST_PASSES - BASELINE_TEST_PASSES))

if [[ $BUILD_DELTA -gt 0 ]]; then
  echo "❌ REGRESSION: $BUILD_DELTA new build error(s) introduced"
  REGRESSION_DETECTED=true
fi

if [[ $TEST_FAIL_DELTA -gt 0 ]]; then
  echo "❌ REGRESSION: $TEST_FAIL_DELTA new test failure(s) introduced"
  REGRESSION_DETECTED=true
fi
```

#### Smoketest & Regression Output

Report results including regression comparison:

```markdown
### Post-Merge Smoketest

| Check | Command | Result | Details |
|-------|---------|--------|---------|
| Build | `npm run build` | ✅ PASS / ❌ FAIL | [build output summary] |
| Tests | `npm test` | ✅ PASS (N/N) / ❌ FAIL | [test count or failure summary] |
| CLI Health | `npx sequant doctor` | ✅ PASS / ❌ FAIL / ⏭️ SKIP | [health check output] |

### Regression Check

| Metric | Baseline (main) | Post-merge | Delta | Status |
|--------|----------------|------------|-------|--------|
| Build errors | $BASELINE_BUILD_ERRORS | $POST_BUILD_ERRORS | +$BUILD_DELTA / 0 | ✅ No regression / ❌ REGRESSION |
| Test failures | $BASELINE_TEST_FAILURES | $POST_TEST_FAILURES | +$TEST_FAIL_DELTA / 0 | ✅ No regression / ❌ REGRESSION |
| Test passes | $BASELINE_TEST_PASSES | $POST_TEST_PASSES | +$TEST_PASS_DELTA | ✅ Tests added / ⚠️ Tests removed |

**Regression Result:** ✅ NO REGRESSIONS / ❌ REGRESSIONS DETECTED
```

#### Regression Gate

**If regressions are detected:**

```bash
if [[ "$REGRESSION_DETECTED" == "true" ]]; then
  if [[ "$FORCE_MERGE" == "true" ]]; then
    echo "⚠️ REGRESSION DETECTED but --force flag set. Proceeding with merge."
    echo "⚠️ Acknowledgment: Merging despite $BUILD_DELTA new build error(s) and $TEST_FAIL_DELTA new test failure(s)."
  else
    # Terminal halt — release the checkout lock before stopping (#901/#906).
    # This branch does NOT continue to Step 8, so the release lives here.
    npx sequant locks checkout release --issue=<first-issue> || true
    echo "❌ REGRESSION DETECTED — merge is blocked."
    echo ""
    echo "New build errors: $BUILD_DELTA"
    echo "New test failures: $TEST_FAIL_DELTA"
    echo ""
    echo "To override this gate, re-run with --force:"
    echo "  /merger <issues> --force"
    echo ""
    echo "To investigate:"
    echo "  npm run build 2>&1 | grep 'error TS'"
    echo "  npm test -- --verbose 2>&1"
    # Do NOT proceed — report regression and halt
  fi
fi
```

**Regression gate behavior:**

| Scenario | `--force` not set | `--force` set |
|----------|-------------------|---------------|
| No regressions | ✅ Proceed | ✅ Proceed |
| New build errors | ❌ Block merge, report | ⚠️ Warn, proceed |
| New test failures | ❌ Block merge, report | ⚠️ Warn, proceed |
| Both | ❌ Block merge, report | ⚠️ Warn, proceed |

**Important:** The regression gate does NOT trigger automatic rollback. It blocks further action and reports for human decision-making. Use `--force` only when you've confirmed the regressions are acceptable (e.g., known flaky tests).

#### Failure Handling (Non-Regression)

If smoketest checks fail but are NOT regressions (same count as baseline), report as pre-existing:

```markdown
### ℹ️ Pre-existing Failures (not regressions)

| Check | Status | Notes |
|-------|--------|-------|
| Build | ⚠️ $BASELINE_BUILD_ERRORS errors | Same as baseline — pre-existing |
| Tests | ⚠️ $BASELINE_TEST_FAILURES failures | Same as baseline — pre-existing |

These failures existed on main before this merge. They are not caused by the merged PR(s).
```

If smoketest checks fail AND are regressions, report with diagnostic commands:

```markdown
### ❌ Regressions Detected

| Check | Baseline | Post-merge | New Failures |
|-------|----------|------------|--------------|
| Build errors | $BASELINE_BUILD_ERRORS | $POST_BUILD_ERRORS | +$BUILD_DELTA |
| Test failures | $BASELINE_TEST_FAILURES | $POST_TEST_FAILURES | +$TEST_FAIL_DELTA |

**⚠️ Action Required:**
- Investigate new failures introduced by this merge
- Consider reverting the merge if regressions are critical
- Use `--force` to override if regressions are acceptable

**Diagnostic commands:**
\`\`\`bash
# Investigate new build errors
npm run build 2>&1 | grep "error TS"

# Run failing tests with verbose output
npm test -- --verbose 2>&1

# Check what the merge changed
git log --oneline -3
git diff HEAD~1 --stat
\`\`\`
```

**Important:** Regression detection does NOT trigger automatic rollback. It reports for human decision-making.

### Step 8: Release the Checkout Lock (REQUIRED)

The merge is complete. Release the working-tree lock so other sessions can run
branch-mutating git again (#901). Run this on the happy path — a successful merge
and smoketest, or the `--force` proceed past a regression. It is the counterpart
to the acquire in "Acquire the Checkout Lock" above.

```bash
npx sequant locks checkout release --issue=<first-issue> || true
```

On a *failure* exit instead, the release is done at the halt site — the
regression gate (Step 7) or "Error Handling" — never both, so exactly one release
runs per invocation.

<!-- BEGIN: named-set-boundary (#961) -->
## Named-Set Boundary (REQUIRED)

`/merger <issue-numbers>` is the user's consent to merge **exactly those
issues** — invoking it is the explicit authorization, the same way `sequant
merge`/`sequant merge --watch` are explicit and human-triggered (#958's
Non-Goals). That consent does not extend past the named set: never let
Dependency Detection or Stacked PR Detection below pull an**other** issue's PR
into `gh pr merge` just because it happens to unblock or precede a named one.

**Rule:** if merge ordering requires a PR whose issue number is **not** in the
invocation's arg list, halt before merging anything and report it — do not
widen the merge silently, and do not treat the stacked-PR "Continue anyway?
(y/N)" confirmation as license to include an unnamed predecessor. Offer the
widened command for the user to re-run:

```text
❌ Out-of-named-set dependency
   #101 depends on #100, but #100 was not in your /merger invocation.
   Halting before any merge.
   To include it: /merger 100 101
```

This rule governs both sections below.
<!-- END: named-set-boundary (#961) -->

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

If dependencies found, enforce merge order **among the named set**. If a
dependency's issue number falls outside the named set, apply the Named-Set
Boundary rule above: halt and report instead of merging it.

### Stacked PR Detection (#605)

PRs created with `sequant run --stacked` have a non-`main` base and a manifest
line in the body (`Part of stack: #N1 → #N2 → ...`). They **must merge in
order** — predecessor first. Merging out of order re-bases the dependent PR's
diff against an unexpected commit and inflates the visible change set.

**Detect stacked PRs:**

```bash
# A PR with a non-main base + manifest is part of a stack
gh pr view <PR_NUMBER> --json baseRefName,body | \
  jq -r 'if (.baseRefName != "main" and (.body | contains("Part of stack:"))) then "STACKED" else "STANDALONE" end'
```

**Enforce stack order before merging:**

1. Extract the stack manifest from each PR's body (`Part of stack: #100 → #101 (this) → #102`).
2. Treat the order in the manifest as the merge order — earlier entries land first.
3. If **every** predecessor is in the named set but requested out of order (e.g. `/merger 102 100 101` for the stack above), **warn before proceeding** and recommend the manifest order.
4. If a predecessor is **not** in the named set at all (e.g. `/merger 102` alone for that stack), the Named-Set Boundary rule applies: halt and report — do not fall through to the "Continue anyway? (y/N)" prompt, since that prompt is for reordering named issues, not for merging an unnamed one.
5. GitHub auto-updates the dependent PR's base when its predecessor merges, so once the order is correct no manual rebasing is needed.

**Warning template:**

```text
⚠️  Stack order violation detected
   PR #102 is part of stack: #100 → #101 → #102
   You requested merge order: #102, #100, #101
   Recommended: merge in manifest order to preserve incremental diffs.
   Continue anyway? (y/N)
```

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
1. Captured baseline metrics on main
2. Created integration branch from main
3. Merged #10 changes (no conflicts)
4. Merged #12 changes (resolved 1 conflict in route.ts)
5. Tests passed (45 tests)
6. Build succeeded

### Cleanup
- Removed worktree: feature/10-*
- Removed worktree: feature/12-*
- Closed: PR #15, PR #16 (superseded by #17)

### Baseline Metrics (main before merge)
| Metric | Count |
|--------|-------|
| Build errors (TS) | 0 |
| Test passes | 42 |
| Test failures | 0 |

### Post-Merge Smoketest
| Check | Command | Result | Details |
|-------|---------|--------|---------|
| Build | `npm run build` | ✅ PASS | Compiled successfully |
| Tests | `npm test` | ✅ PASS (45/45) | All tests passing |
| CLI Health | `npx sequant doctor` | ✅ PASS | No issues detected |

### Regression Check
| Metric | Baseline (main) | Post-merge | Delta | Status |
|--------|----------------|------------|-------|--------|
| Build errors | 0 | 0 | 0 | ✅ No regression |
| Test failures | 0 | 0 | 0 | ✅ No regression |
| Test passes | 42 | 45 | +3 | ✅ Tests added |

**Regression Result:** ✅ NO REGRESSIONS

### Final Status
**Result:** SUCCESS
**Integration PR:** #17
**Issues to close on merge:** #10, #12
```

## Error Handling

**Before halting on any failure below, release the checkout lock** (#901/#906) —
the acquire in "Acquire the Checkout Lock" claimed the tree, and every failure
here is a terminal exit that must hand it back before stopping:

```bash
npx sequant locks checkout release --issue=<first-issue> || true
```

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
- `SEQUANT_MERGER_FORCE` - If true, proceed even with conflicts or regressions (bypasses regression gate)
- `SEQUANT_MERGER_SKIP_SMOKETEST` - If true, skip post-merge smoketest (also skips baseline capture)

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Baseline Metrics** - Build errors, test passes/failures on main before merge (or "Skipped" if `--skip-smoketest`)
- [ ] **Pre-Merge Validation** - Status of each issue/worktree/PR
- [ ] **Conflict Analysis** - Table of overlapping files and status
- [ ] **Resolution Strategy** - How conflicts were resolved (if any)
- [ ] **Actions Taken** - Step-by-step log of what was done
- [ ] **Cleanup Status** - Which worktrees/branches were removed
- [ ] **Post-Merge Smoketest** - Build, test, and CLI health results (or "Skipped" if `--skip-smoketest`)
- [ ] **Regression Check** - Baseline vs post-merge comparison table (or "Skipped" if `--skip-smoketest`)
- [ ] **Regression Gate** - Whether regressions were detected and what action was taken
- [ ] **Final Status** - SUCCESS/FAILURE with PR link

**DO NOT respond until all items are verified.**
