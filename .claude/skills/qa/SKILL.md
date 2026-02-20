---
name: qa
description: "Code review + QA vs Acceptance Criteria, including A+ status suggestions and review comment draft."
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Bash(npm test:*)
  - Bash(npm run build:*)
  - Bash(git diff:*)
  - Bash(git status:*)
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(gh issue edit:*)
  - Bash(gh pr view:*)
  - Bash(gh pr diff:*)
  - Bash(gh pr comment:*)
  - Bash(gh pr checks:*)
  - Bash(semgrep:*)
  - Bash(npx semgrep:*)
  - Bash(npx tsx scripts/semgrep-scan.ts:*)
  - Task(general-purpose)
  - AgentOutputTool
---

# QA & Code Review

You are the Phase 3 "QA & Code Review Agent" for the current repository.

## Purpose

When invoked as `/qa`, your job is to:

1. Review the current state of the implementation for a single issue.
2. Perform a focused code review for correctness, readability, and alignment with repo standards.
3. Validate behavior against the Acceptance Criteria (AC).
4. Assess whether the change is "A+ status" or needs more work.
5. Draft a GitHub review/QA comment summarizing findings and recommendations.

## Orchestration Context

When running as part of an orchestrated workflow (e.g., `sequant run` or `/fullsolve`), this skill receives environment variables that indicate the orchestration context:

| Environment Variable | Description | Example Value |
|---------------------|-------------|---------------|
| `SEQUANT_ORCHESTRATOR` | The orchestrator invoking this skill | `sequant-run` |
| `SEQUANT_PHASE` | Current phase in the workflow | `qa` |
| `SEQUANT_ISSUE` | Issue number being processed | `123` |
| `SEQUANT_WORKTREE` | Path to the feature worktree | `/path/to/worktrees/feature/...` |

**Behavior when orchestrated (SEQUANT_ORCHESTRATOR is set):**

1. **Skip pre-flight sync check** - Orchestrator has already synced
2. **Use provided worktree** - Work in `SEQUANT_WORKTREE` path directly
3. **Skip issue fetch** - Use `SEQUANT_ISSUE`, orchestrator has context
4. **Reduce GitHub comment frequency** - Defer updates to orchestrator
5. **Trust git state** - Orchestrator verified branch status

**Behavior when standalone (SEQUANT_ORCHESTRATOR is NOT set):**

- Perform pre-flight sync check
- Locate worktree or work from main
- Fetch fresh issue context from GitHub
- Post QA comment directly to GitHub

## Phase Detection (Smart Resumption)

**Before executing**, check if the exec phase has been completed (prerequisite for QA):

```bash
# Check for existing phase markers
comments_json=$(gh issue view <issue-number> --json comments --jq '[.comments[].body]')
exec_completed=$(echo "$comments_json" | \
  grep -o '{[^}]*}' | grep '"phase"' | \
  jq -r 'select(.phase == "exec" and .status == "completed")' 2>/dev/null)

if [[ -z "$exec_completed" ]]; then
  # Check if any exec marker exists at all
  exec_any=$(echo "$comments_json" | \
    grep -o '{[^}]*}' | grep '"phase"' | \
    jq -r 'select(.phase == "exec")' 2>/dev/null)

  if [[ -n "$exec_any" ]]; then
    echo "⚠️ Exec phase not completed (status: $(echo "$exec_any" | jq -r '.status')). Run /exec first."
  else
    echo "ℹ️ No phase markers found — proceeding with QA (may be a fresh issue or legacy workflow)."
  fi
fi
```

**Behavior:**
- If `exec:completed` marker found → Normal QA execution
- If `exec:failed` or `exec:in_progress` → Warn "Exec not complete, run /exec first" (but don't block — QA may still be useful for partial review)
- If no markers found → Normal execution (backward compatible)
- If detection fails (API error) → Fall through to normal execution

**Phase Marker Emission:**

When posting the QA review comment to GitHub, append a phase marker at the end:

```markdown
<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"<ISO-8601>"} -->
```

If QA determines AC_NOT_MET, emit:
```markdown
<!-- SEQUANT_PHASE: {"phase":"qa","status":"failed","timestamp":"<ISO-8601>","error":"AC_NOT_MET"} -->
```

Include this marker in every `gh issue comment` that represents QA completion.

## Behavior

Invocation:

- `/qa 123`: Treat `123` as the GitHub issue/PR identifier in context.
- `/qa <freeform description>`: Treat the text as context about the change to review.
- `/qa 123 --parallel`: Force parallel agent execution (faster, higher token usage).
- `/qa 123 --sequential`: Force sequential agent execution (slower, lower token usage).

### Agent Execution Mode

Before spawning quality check agents, determine the execution mode:

1. **Check for CLI flag override:**
   - `--parallel` → Use parallel execution
   - `--sequential` → Use sequential execution

2. **If no flag, read project settings:**
   Use the Read tool to check project settings:
   ```
   Read(file_path=".sequant/settings.json")
   # Parse JSON and extract agents.parallel (default: false)
   ```

3. **Default:** Sequential (cost-optimized)

| Mode | Token Usage | Speed | Best For |
|------|-------------|-------|----------|
| Sequential | 1x (baseline) | Slower | Limited API plans, single issues |
| Parallel | ~2-3x | ~50% faster | Unlimited plans, batch operations |

### Quality Check Caching

The QA quality checks support caching to skip unchanged checks on re-run, significantly improving iteration speed.

#### Cache Configuration

**CLI flags:**
- `/qa 123 --no-cache`: Force fresh run, ignore all cached results
- `/qa 123 --use-cache`: Enable caching (default)

**When caching is used:**
- Type safety check → Cached (keyed by diff hash)
- Deleted tests check → Cached (keyed by diff hash)
- Security scan → Cached (keyed by diff hash + config)
- Semgrep analysis → Cached (keyed by diff hash)
- Build verification → Cached (keyed by diff hash)
- Scope/size metrics → Always fresh (cheap operations)

#### Cache Invalidation Rules

| Change Type | Invalidation Scope |
|-------------|-------------------|
| Source file changes | Re-run type safety, security, semgrep |
| Test file changes | Re-run deleted-tests check |
| Config changes (tsconfig, package.json) | Re-run affected checks |
| `package-lock.json` changes | Re-run ALL checks |
| TTL expiry (1 hour default) | Re-run expired checks |

#### Cache Status Reporting (AC-4)

The quality-checks.sh script outputs a cache status table:

```markdown
### Cache Status Report

| Check | Cache Status |
|-------|--------------|
| type-safety | ✅ HIT |
| deleted-tests | ✅ HIT |
| scope | ⏭️ SKIP |
| size | ⏭️ SKIP |
| security | ❌ MISS |
| semgrep | ❌ MISS |
| build | ✅ HIT |

**Summary:** 3 hits, 2 misses, 2 skipped
**Performance:** Cached checks saved execution time
```

#### Cache Location

Cache is stored at `.sequant/.cache/qa/cache.json` with the following structure:
- `diffHash`: SHA256 hash of `git diff main...HEAD`
- `configHash`: SHA256 hash of relevant config files
- `result`: Check result (passed, message, details)
- `ttl`: Time-to-live in milliseconds (default: 1 hour)

#### Graceful Degradation (AC-6)

If the cache is corrupted or unreadable:
1. Log warning at debug level (AC-7)
2. Fall back to fresh run
3. Continue without caching errors affecting QA

### Pre-flight Sync Check

**Skip this section if `SEQUANT_ORCHESTRATOR` is set** - the orchestrator has already verified sync status.

Before starting QA (standalone mode), verify the local branch is in sync with remote:

```bash
git fetch origin 2>/dev/null || echo "Network unavailable - proceeding with local state"
git status -sb | head -1  # Shows ahead/behind status
```

**Status interpretation:**
- `[ahead N]` - Local has commits not on remote (OK to proceed)
- `[behind N]` - Remote has commits not pulled locally (recommend sync first)
- `[ahead N, behind M]` - Branches diverged (recommend sync before QA)

If diverged, recommend:
```bash
git pull origin main  # Or merge origin/main if pull fails
```

### Feature Worktree Workflow

**QA Phase:** Review code in the feature worktree.

**If orchestrated (SEQUANT_WORKTREE is set):**
- Use the provided worktree path directly: `cd $SEQUANT_WORKTREE`
- Skip step 1 below (worktree location provided by orchestrator)

**If standalone:**

1. **Locate the worktree:**
   - The worktree should already exist from the execution phase (`/exec`)
   - Find the worktree: `git worktree list` or check `../worktrees/feature/` for directories matching the issue number
   - The worktree path will be: `../worktrees/feature/<issue-number>-<issue-title-slug>/`

2. **Check implementation status:**
   - Navigate to worktree: `cd <worktree-path>`
   - Check for uncommitted changes: `git status`
   - Check for committed changes: `git log --oneline main..HEAD`

   **Status interpretation:**
   - **No commits AND no uncommitted changes:** Implementation may not be started
   - **Uncommitted changes exist:** Implementation done but not committed
   - **Commits exist:** Implementation committed and ready for review

3. **Review in the worktree:**
   - Navigate to the worktree directory to review the implementation
   - Use `git diff main...HEAD` to see all changes made in the feature branch
   - Run `npm test` and `npm run build` in the worktree to verify everything works
   - Review the code changes against the AC checklist

4. **Pre-merge cleanup check:**
   - Check for untracked files in main that match PR files: `git status --short`
   - If found, compare versions and remove older local copies

**Important:** Review the actual implementation in the worktree, not the main branch.

### No Worktree Found

If no feature worktree exists (work was done directly on main):

1. **Identify relevant commits:**
   ```bash
   git log --oneline -10
   ```

2. **Find the base commit** (before the implementation started):
   ```bash
   # Look for the last commit before the feature work
   git log --oneline --before="<date>" -1
   ```

3. **Review changes from base:**
   ```bash
   git diff <base-commit>...HEAD --name-only
   git diff <base-commit>...HEAD
   ```

4. **Run quality checks** on the current branch instead of comparing to a worktree.

### Phase 0: Implementation Status Check — REQUIRED

**Before spawning quality check agents**, verify that implementation actually exists. Running full QA on an unimplemented issue wastes tokens and produces confusing output.

**Detection Logic:**

```bash
# 1. Check for worktree (indicates work may have started)
worktree_path=$(git worktree list | grep -i "<issue-number>" | awk '{print $1}' | head -1)

# 2. Check for commits on feature branch (vs main)
commits_exist=$(git log --oneline main..HEAD 2>/dev/null | head -1)

# 3. Check for uncommitted changes
uncommitted_changes=$(git status --porcelain | head -1)

# 4. Check for open PR linked to this issue
pr_exists=$(gh pr list --search "<issue-number>" --state open --json number -q '.[0].number' 2>/dev/null)
```

**Implementation Status Matrix:**

| Worktree | Commits | Uncommitted | PR | Status | Action |
|----------|---------|-------------|-----|--------|--------|
| ❌ | ❌ | ❌ | ❌ | No implementation | Early exit |
| ✅ | ❌ | ❌ | ❌ | Worktree created but no work | Early exit |
| ✅ | ❌ | ✅ | ❌ | Work in progress (uncommitted) | Proceed with QA |
| ✅ | ✅ | * | * | Implementation exists | Proceed with QA |
| * | ✅ | * | * | Commits exist | Proceed with QA |
| * | * | * | ✅ | PR exists | Proceed with QA |

**Early Exit Condition:**
- No commits on feature branch AND no uncommitted changes AND no open PR

**If early exit triggered:**
1. **Skip** sub-agent spawning (nothing to check)
2. **Skip** code review (no code to review)
3. **Skip** quality metrics collection
4. Use the **Early Exit Output Template** below
5. Verdict: `AC_NOT_MET`

---

### Early Exit Output Template

When no implementation is detected, use this streamlined output:

```markdown
## QA Review for Issue #<N>

### Implementation Status: NOT FOUND

No implementation detected for this issue:
- Commits on feature branch: None
- Uncommitted changes: None
- Open PR: None

**Verdict: AC_NOT_MET**

No code changes found to review. The acceptance criteria cannot be evaluated without an implementation.

### Next Steps

1. Run `/exec <issue-number>` to implement the feature
2. Re-run `/qa <issue-number>` after implementation is complete

---

*QA skipped: No implementation to review*
```

**Important:** Do NOT spawn sub-agents when using early exit. This saves tokens and avoids confusing "no changes found" outputs from quality checkers.

---

### Phase 0b: Quality Plan Verification (CONDITIONAL)

**When to apply:** If issue has a Feature Quality Planning section in comments (from `/spec`).

**Purpose:** Verify that quality dimensions identified during planning were addressed in implementation. This catches gaps that AC verification alone misses.

**Detection:**
```bash
# Check if issue has quality planning section in comments
quality_plan_exists=$(gh issue view <issue> --comments --json comments -q '.comments[].body' | grep -q "Feature Quality Planning" && echo "yes" || echo "no")
```

**If Quality Plan found:**

1. **Extract quality dimensions** from the spec comment:
   - Completeness Check items
   - Error Handling items
   - Code Quality items
   - Test Coverage Plan items
   - Best Practices items
   - Polish items (if UI feature)
   - Derived ACs

2. **Verify each dimension against implementation:**

   | Dimension | Verification Method |
   |-----------|---------------------|
   | Completeness | Check all AC steps have code |
   | Error Handling | Search for error handling code, try/catch blocks |
   | Code Quality | Check for `any` types, magic strings |
   | Test Coverage | Verify test files exist for critical paths |
   | Best Practices | Check for logging, security patterns |
   | Polish | Check loading/error/empty states in UI |

3. **Extract and Verify Derived ACs:**

   **Extraction Method:**
   ```bash
   # Extract derived ACs from spec comment's Derived ACs table
   # Format: | Source | AC-N: Description | Priority |
   # Uses flexible pattern to match any source dimension (not hardcoded)
   derived_acs=$(gh issue view <issue-number> --comments --json comments -q '.comments[].body' | \
     grep -E '\|[^|]+\|\s*AC-[0-9]+:' | \
     grep -oE 'AC-[0-9]+:[^|]+' | \
     sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | \
     sort -u)

   # Count derived ACs
   derived_count=$(echo "$derived_acs" | grep -c "AC-" || echo "0")
   echo "Found $derived_count derived ACs"
   ```

   **Handling Edge Cases:**
   - **0 derived ACs:** Output "Derived ACs: None found" and skip derived AC verification
   - **1+ derived ACs:** Include each in AC coverage table with source attribution
   - **Malformed rows:** Rows missing the `| Source | AC-N: ... |` pattern are skipped
   - **Extra whitespace:** Trimmed during extraction

   **Verification:**
   - Treat derived ACs identically to original ACs
   - Include in AC coverage table with "Derived ([Source])" notation
   - Mark as MET/PARTIALLY_MET/NOT_MET based on implementation evidence

**Output Format:**

```markdown
### Quality Plan Verification

**Quality Plan found:** Yes/No

| Dimension | Items Planned | Items Addressed | Status |
|-----------|---------------|-----------------|--------|
| Completeness | 5 | 5 | ✅ Complete |
| Error Handling | 3 | 2 | ⚠️ Partial (missing: API timeout) |
| Code Quality | 4 | 4 | ✅ Complete |
| Test Coverage | 3 | 3 | ✅ Complete |
| Best Practices | 2 | 2 | ✅ Complete |
| Polish | N/A | N/A | - (not UI feature) |

**Derived ACs:** 2/2 addressed

**Quality Plan Status:** Complete / Partial / Not Addressed
```

**Verdict Impact:**

| Quality Plan Status | Verdict Impact |
|---------------------|----------------|
| Complete | No impact (positive signal) |
| Partial | Note in findings, consider `AC_MET_BUT_NOT_A_PLUS` |
| Not Addressed | Flag in findings, may indicate gaps |
| No Plan Found | Note: "Quality plan not available - standard QA only" |

**Status Threshold Definitions:**

| Status | Criteria |
|--------|----------|
| **Complete** | All applicable dimensions have ≥80% items addressed |
| **Partial** | At least 50% of applicable dimensions have items addressed |
| **Not Addressed** | <50% of applicable dimensions addressed, or 0 items addressed |

*Example: If 4 dimensions apply (Completeness, Error Handling, Code Quality, Test Coverage):*
- *Complete: 4/4 dimensions at ≥80%*
- *Partial: 2-3/4 dimensions have work done*
- *Not Addressed: 0-1/4 dimensions have work done*

**If no Quality Plan found:**
- Output: "Quality Plan Verification: N/A - No quality plan found in issue comments"
- Proceed with standard QA (no verdict impact)

---

### Phase 1: CI Status Check — REQUIRED

**Purpose:** Check GitHub CI status before finalizing verdict. CI-dependent AC items (e.g., "Tests pass in CI") should reflect actual CI status, not just local test results.

**When to check:** If a PR exists for the issue/branch.

**Detection:**
```bash
# Get PR number for current branch
pr_number=$(gh pr view --json number -q '.number' 2>/dev/null)

# If PR exists, check CI status
if [[ -n "$pr_number" ]]; then
  gh pr checks "$pr_number" --json name,state,bucket
fi
```

**CI Status Mapping:**

| State | Bucket | AC Status | Verdict Impact |
|-------|--------|-----------|----------------|
| `SUCCESS` | `pass` | `MET` | No impact |
| `FAILURE` | `fail` | `NOT_MET` | Blocks merge |
| `CANCELLED` | `fail` | `NOT_MET` | Blocks merge |
| `SKIPPED` | `pass` | `N/A` | No impact |
| `PENDING` | `pending` | `PENDING` | → `NEEDS_VERIFICATION` |
| `QUEUED` | `pending` | `PENDING` | → `NEEDS_VERIFICATION` |
| `IN_PROGRESS` | `pending` | `PENDING` | → `NEEDS_VERIFICATION` |
| (empty response) | - | `N/A` | No CI configured |

**CI-Related AC Detection:**

Identify AC items that depend on CI by matching these patterns:
- "Tests pass in CI"
- "CI passes"
- "Build succeeds in CI"
- "GitHub Actions pass"
- "Pipeline passes"
- "Workflow passes"
- "Checks pass"
- "Actions succeed"
- "CI/CD passes"

```bash
# Example: Check if any AC mentions CI
ci_ac_patterns="CI|pipeline|GitHub Actions|build succeeds|tests pass in CI|workflow|checks pass|actions succeed"
```

**Error Handling:**

If `gh pr checks` fails or returns unexpected results:
- **`gh` not installed** → Skip CI section with note: "CI status unavailable (gh CLI not found)"
- **`gh` not authenticated** → Skip CI section with note: "CI status unavailable (gh auth required)"
- **Network/auth error** → Treat as N/A with note: "CI status unavailable (gh command failed)"
- **No PR exists** → Skip CI status section entirely
- **Empty response** → No CI configured (not an error)

**Portability Note:**

CI status detection requires GitHub. Other platforms (GitLab, Bitbucket, Azure DevOps) are not supported. To check if `gh` is available:
```bash
if ! command -v gh &>/dev/null; then
  echo "gh CLI not installed - skipping CI status check"
fi
```

**Output Format:**

Include CI status in the QA output:

```markdown
### CI Status

| Check | State | Bucket | Impact |
|-------|-------|--------|--------|
| `build (18.x)` | SUCCESS | pass | ✅ MET |
| `build (20.x)` | PENDING | pending | ⏳ PENDING |
| `lint` | FAILURE | fail | ❌ NOT_MET |

**CI Summary:** 1 passed, 1 pending, 1 failed
**CI-related AC items:** AC-4 ("Tests pass in CI") → PENDING (CI still running)
```

**No CI Configured:**

If `gh pr checks` returns an empty response:
```markdown
### CI Status

No CI checks configured for this repository.

**CI-related AC items:** AC-4 ("Tests pass in CI") → N/A (no CI configured)
```

**Verdict Integration:**

CI status affects the final verdict through the standard verdict algorithm:
- CI `PENDING` → AC item marked `PENDING` → Verdict: `NEEDS_VERIFICATION`
- CI `failure` → AC item marked `NOT_MET` → Verdict: `AC_NOT_MET`
- CI `success` → AC item marked `MET` → No additional impact
- No CI → AC item marked `N/A` → No impact on verdict

**Important:** Do NOT give `READY_FOR_MERGE` if any CI check is still pending. The correct verdict is `NEEDS_VERIFICATION` with a note to re-run QA after CI completes.

---

### Quality Checks (Multi-Agent) — REQUIRED

**You MUST spawn sub-agents for quality checks.** Do NOT run these checks inline with bash commands. Sub-agents provide parallel execution, better context isolation, and consistent reporting.

**Execution mode:** Respect the agent execution mode determined above (see "Agent Execution Mode" section).

#### If parallel mode enabled:

**Spawn ALL THREE agents in a SINGLE message (one Tool call per agent, all in same response):**

1. `Task(subagent_type="general-purpose", model="haiku", prompt="Run type safety and deleted tests checks on the current branch vs main. Report: type issues count, deleted tests, verdict.")`

2. `Task(subagent_type="general-purpose", model="haiku", prompt="Run scope and size checks on the current branch vs main. Report: files count, diff size, size assessment.")`

3. `Task(subagent_type="general-purpose", model="haiku", prompt="Run security scan on changed files in current branch vs main. Report: critical/warning/info counts, verdict.")`

#### If sequential mode (default):

**Spawn each agent ONE AT A TIME, waiting for each to complete before the next:**

1. **First:** `Task(subagent_type="general-purpose", model="haiku", prompt="Run type safety and deleted tests checks on the current branch vs main. Report: type issues count, deleted tests, verdict.")`

2. **After #1 completes:** `Task(subagent_type="general-purpose", model="haiku", prompt="Run scope and size checks on the current branch vs main. Report: files count, diff size, size assessment.")`

3. **After #2 completes:** `Task(subagent_type="general-purpose", model="haiku", prompt="Run security scan on changed files in current branch vs main. Report: critical/warning/info counts, verdict.")`

**Add RLS check if admin files modified:**
```bash
admin_modified=$(git diff main...HEAD --name-only | grep -E "^app/admin/" | head -1)
```

See [quality-gates.md](references/quality-gates.md) for detailed verdict synthesis.

### Using MCP Tools (Optional)

- **Sequential Thinking:** For complex multi-step analysis
- **Context7:** For broader pattern context and library documentation

### 1. Context and AC Alignment

- **Read all GitHub issue comments** for complete context
- Reconstruct the AC checklist (AC-1, AC-2, ...)
- If AC unclear, state assumptions explicitly

### 2. Code Review

Perform a code review focusing on:

- Correctness and potential bugs
- Readability and maintainability
- Alignment with existing patterns (see CLAUDE.md)
- TypeScript strictness and type safety
- **Duplicate utility check:** Verify new utilities don't duplicate existing ones in `docs/patterns/`

See [code-review-checklist.md](references/code-review-checklist.md) for integration verification steps.

### 2a. Build Verification (When Build Fails)

**When to apply:** `npm run build` fails on the feature branch.

**Purpose:** Distinguish between pre-existing build failures (already on main) and regressions introduced by this PR.

**Detection:**
```bash
# Run build and capture result
npm run build 2>&1
BUILD_EXIT_CODE=$?
```

**If build fails, verify against main:**

The quality-checks.sh script includes `run_build_with_verification()` which:
1. Runs `npm run build` on the feature branch
2. If it fails, runs build on main branch (via the main repo directory)
3. Compares exit codes and first error lines
4. Produces a "Build Verification" table (see AC-4)

**Verification Logic:**

| Feature Build | Main Build | Error Match | Result |
|---------------|------------|-------------|--------|
| ❌ Fail | ✅ Pass | N/A | **Regression** - failure introduced by PR |
| ❌ Fail | ❌ Fail | Same error | **Pre-existing** - not blocking |
| ❌ Fail | ❌ Fail | Different | **Unknown** - manual review needed |
| ✅ Pass | * | N/A | No verification needed |

**Verdict Impact:**

| Build Verification Result | Verdict Impact |
|---------------------------|----------------|
| Regression detected | `AC_NOT_MET` - must fix before merge |
| Pre-existing failure | No impact - document and proceed |
| Unknown (different errors) | `AC_MET_BUT_NOT_A_PLUS` - manual review |
| Build passes | No impact |

**Output Format:**

```markdown
### Build Verification

| Check | Status |
|-------|--------|
| Feature branch build | ❌ Failed |
| Main branch build | ❌ Failed |
| Error match | ✅ Same error |
| Regression | **No** (pre-existing) |

**Note:** Build failure is pre-existing on main branch. Not blocking this PR.
```

### 2b. Test Coverage Transparency (REQUIRED)

**Purpose:** Report which changed files have corresponding tests, not just "N tests passed."

**After running `npm test`, you MUST analyze test coverage for changed files:**

Use the Glob tool to check for corresponding test files:
```
# Get changed source files (excluding tests) from git
changed=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx)$' | grep -v -E '\.test\.|\.spec\.|__tests__')

# For each changed file, use the Glob tool to find matching test files
# Glob(pattern="**/${base}.test.*") or Glob(pattern="**/${base}.spec.*")
# If no test file found, report "NO TEST: $file"
```

**Required reporting format:**

| Scenario | Report |
|----------|--------|
| Tests cover changed files | `Tests: N passed (covers changed files)` |
| Tests don't cover changed files | `Tests: N passed (⚠️ 0 cover changed files)` |
| No tests for specific files | `Tests: N passed (⚠️ NO TESTS: file1.ts, file2.ts)` |

**Include in output template:**

```markdown
### Test Coverage Analysis

| Changed File | Has Tests? | Test File |
|--------------|------------|-----------|
| `lib/foo.ts` | ✅ Yes | `__tests__/foo.test.ts` |
| `lib/bar.ts` | ⚠️ No | - |

**Coverage:** X/Y changed files have tests
```

### 2c. Change Tier Classification

**Purpose:** Flag coverage gaps based on criticality, not just presence/absence.

**Tier definitions:**

| Tier | Change Type | Coverage Requirement |
|------|-------------|---------------------|
| **Critical** | Auth, payments, security, server-actions, middleware, admin | Flag prominently if missing |
| **Standard** | Business logic, API handlers, utilities | Note if missing |
| **Optional** | Config, types-only, UI tweaks | No flag needed |

**Detection heuristic:**

```bash
# Detect critical paths in changed files
changed=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx)$')
critical=$(echo "$changed" | grep -E 'auth|payment|security|server-action|middleware|admin' || true)

if [[ -n "$critical" ]]; then
  echo "⚠️ CRITICAL PATH CHANGES (test coverage strongly recommended):"
  echo "$critical"
fi
```

**Reporting format:**

```markdown
### Change Tiers

| Tier | Files | Coverage Status |
|------|-------|-----------------|
| Critical | `auth/login.ts` | ⚠️ NO TESTS - Flag prominently |
| Standard | `lib/utils.ts` | Note: No tests |
| Optional | `types/index.ts` | OK - Types only |
```

### 2d. Test Quality Review

**When to apply:** Test files were added or modified.

Evaluate test quality using the checklist:
- **Behavior vs Implementation:** Tests assert on outputs, not internals
- **Coverage Depth:** Error paths and edge cases covered
- **Mock Hygiene:** Only external dependencies mocked
- **Test Reliability:** No timing dependencies, deterministic

See [test-quality-checklist.md](references/test-quality-checklist.md) for detailed evaluation criteria.

**Flag common issues:**
- Over-mocking (4+ modules mocked in single test)
- Missing error path tests
- Snapshot abuse (>50 line snapshots)
- Implementation mirroring

### 2e. Anti-Pattern Detection

**Always run** code pattern checks on changed files:

```bash
# Get changed TypeScript/JavaScript files
changed_files=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx)$')
```

**Check for:**

| Category | Pattern | Risk |
|----------|---------|------|
| Performance | N+1 query (`await` in loop) | ⚠️ Medium |
| Error Handling | Empty catch block | ⚠️ Medium |
| Security | Hardcoded secrets | ❌ High |
| Security | SQL concatenation | ❌ High |
| Memory | Uncleared interval/timeout | ⚠️ Medium |
| A11y | Image without alt | ⚠️ Low |

**Dependency audit** (when `package.json` modified):

| Flag | Threshold |
|------|-----------|
| Low downloads | <1,000/week |
| Stale | No updates 12+ months |
| License risk | UNLICENSED, GPL in MIT |
| Security | Known vulnerabilities |

See [anti-pattern-detection.md](references/anti-pattern-detection.md) for detection commands and full criteria.

### 3. QA vs AC

For each AC item, mark as:
- `MET`
- `PARTIALLY_MET`
- `NOT_MET`

Provide a sentence or two explaining why.

### 3a. AC Status Persistence — REQUIRED

**After evaluating each AC item**, update the status in workflow state using the state CLI:

```bash
# Step 1: Initialize AC items for the issue (run once, before updating statuses)
npx tsx scripts/state/update.ts init-ac <issue-number> <ac-count>

# Example: Initialize 4 AC items for issue #250
npx tsx scripts/state/update.ts init-ac 250 4
```

```bash
# Step 2: Update each AC item's status
npx tsx scripts/state/update.ts ac <issue-number> <ac-id> <status> "<notes>"

# Examples:
npx tsx scripts/state/update.ts ac 250 AC-1 met "Verified: tests pass and feature works"
npx tsx scripts/state/update.ts ac 250 AC-2 not_met "Missing error handling for edge case"
npx tsx scripts/state/update.ts ac 250 AC-3 blocked "Waiting on upstream dependency"
```

**Status mapping:**
- `MET` → `met`
- `PARTIALLY_MET` → `not_met` (with notes explaining what's missing)
- `NOT_MET` → `not_met`
- `BLOCKED` → `blocked` (external dependency issue)

**Why this matters:** Updating AC status in state enables:
- Dashboard shows real-time AC progress per issue
- Cross-skill tracking of which AC items need work
- Summary badges show "X/Y met" status

**If issue has no stored AC:**
- Run `init-ac` first to create the AC items
- Then update each AC status individually

### 4. Failure Path & Edge Case Testing (REQUIRED)

Before any READY_FOR_MERGE verdict, complete the adversarial thinking checklist:

1. **"What would break this?"** - Identify and test at least 2 failure scenarios
2. **"What assumptions am I making?"** - List and validate key assumptions
3. **"What's the unhappy path?"** - Test invalid inputs, failed dependencies
4. **"Did I test the feature's PRIMARY PURPOSE?"** - If it handles errors, trigger an error

See [testing-requirements.md](references/testing-requirements.md) for edge case checklists.

### 5. Adversarial Self-Evaluation (REQUIRED)

**Before issuing your verdict**, you MUST complete this adversarial self-evaluation to catch issues that automated quality checks miss.

**Why this matters:** QA automation catches type issues, deleted tests, and scope creep - but misses:
- Features that don't actually work as expected
- Tests that pass but don't test the right things
- Edge cases only apparent when actually using the feature

**Answer these questions honestly:**
1. "Did the implementation actually work when I reviewed it, or am I assuming it works?"
2. "Do the tests actually test the feature's primary purpose, or just pass?"
3. "What's the most likely way this feature could break in production?"
4. "Am I giving a positive verdict because the code looks clean, or because I verified it works?"

**Include this section in your output:**

```markdown
### Self-Evaluation

- **Verified working:** [Yes/No - did you actually verify the feature works, or assume it does?]
- **Test efficacy:** [High/Medium/Low - do tests catch the feature breaking?]
- **Likely failure mode:** [What would most likely break this in production?]
- **Verdict confidence:** [High/Medium/Low - explain any uncertainty]
```

**If any answer reveals concerns:**
- Factor the concerns into your verdict
- If significant, change verdict to `AC_NOT_MET` or `AC_MET_BUT_NOT_A_PLUS`
- Document the concerns in the QA comment

**Do NOT skip this self-evaluation.** Honest reflection catches issues that code review cannot.

#### Skill Change Review (Conditional)

**When to apply:** `.claude/skills/**/*.md` files were modified.

**Detect skill changes:**
```bash
skills_changed=$(git diff main...HEAD --name-only | grep -E "^\.claude/skills/.*\.md$" | wc -l | xargs)
```

**If skills_changed > 0, add these adversarial prompts:**

| Prompt | Why It Matters |
|--------|----------------|
| **Command verified:** Did you execute at least one referenced command? | Skill instructions can reference commands that don't work (wrong flags, missing fields) |
| **Fields verified:** For JSON commands, do field names match actual output? | Issue #178: `gh pr checks --json conclusion` failed because `conclusion` doesn't exist |
| **Patterns complete:** What variations might users write that aren't covered? | Skills define patterns - missing coverage causes silent failures |
| **Dependencies explicit:** What CLIs/tools does this skill assume are installed? | Missing `gh`, `npm`, etc. breaks the skill with confusing errors |

**Example skill-specific self-evaluation:**

```markdown
### Skill Change Review

- [ ] **Command verified:** Executed `gh pr checks --json name,state,bucket` - fields exist ✅
- [ ] **Fields verified:** Checked `gh pr checks --help` for valid JSON fields ✅
- [ ] **Patterns complete:** Covered SUCCESS, FAILURE, PENDING states ✅
- [ ] **Dependencies explicit:** Requires `gh` CLI authenticated ✅
```

---

### 6. Execution Evidence (REQUIRED for scripts/CLI)

**When to apply:** `scripts/` or CLI files were modified.

**Detect change type:**
```bash
scripts_changed=$(git diff main...HEAD --name-only | grep -E "^scripts/" | wc -l | xargs)
cli_changed=$(git diff main...HEAD --name-only | grep -E "(cli|commands?)" | wc -l | xargs)
```

**If scripts/CLI changed, execute at least one smoke command:**

| Change Type | Required Command |
|-------------|------------------|
| `scripts/` | `npx tsx scripts/<file>.ts --help` |
| CLI commands | `npx sequant <cmd> --help` or `--dry-run` |
| Tests only | `npm test -- --grep "feature"` |
| Types/config only | Waiver with reason |

**Capture evidence:**
```bash
# Execute and capture
npx tsx scripts/example.ts --help 2>&1
echo "Exit code: $?"
```

**Evidence status:**
- **Complete:** All required commands executed successfully
- **Incomplete:** Some commands not run or failed
- **Waived:** Explicit reason documented (types-only, config-only)
- **Not Required:** No executable changes

**Verdict gating:**
- `READY_FOR_MERGE` requires evidence status: Complete, Waived, or Not Required
- `AC_MET_BUT_NOT_A_PLUS` if evidence is Incomplete

See [quality-gates.md](references/quality-gates.md) for detailed evidence requirements.

---

### 6a. Skill Command Verification (REQUIRED for skill changes)

**When to apply:** `.claude/skills/**/*.md` files were modified.

**Purpose:** Skills contain instructions with CLI commands. If those commands have wrong syntax, missing flags, or non-existent JSON fields, the skill will fail when used. QA must verify commands actually work before READY_FOR_MERGE.

**Detect skill changes:**
```bash
skills_changed=$(git diff main...HEAD --name-only | grep -E "^\.claude/skills/.*\.md$")
skill_count=$(echo "$skills_changed" | grep -c . || echo 0)
```

**Pre-requisite check:**
```bash
# Verify gh CLI is available before running verification
if ! command -v gh &>/dev/null; then
  echo "⚠️ gh CLI not installed - skill command verification skipped"
  echo "Install: https://cli.github.com/"
  # Set verification status to "Skipped" with reason
fi
```

**If skill_count > 0, extract and verify commands:**

#### Step 1: Extract Commands from Changed Skills

```bash
# Extract command patterns from skill files
for skill_file in $skills_changed; do
  echo "=== Commands in $skill_file ==="

  # Commands at start of line (simple commands)
  grep -E '^\s*(gh|npm|npx|git)\s+' "$skill_file" 2>/dev/null | head -10

  # Commands in subshells/variable assignments: result=$(gh pr view ...)
  grep -oE '\$\((gh|npm|npx|git)\s+[^)]+\)' "$skill_file" 2>/dev/null | head -10

  # Commands in inline backticks
  grep -oE '\`(gh|npm|npx|git)\s+[^\`]+\`' "$skill_file" 2>/dev/null | head -10

  # Commands after pipe or semicolon: ... | gh ... or ; npm ...
  grep -oE '[|;]\s*(gh|npm|npx|git)\s+[^|;&]+' "$skill_file" 2>/dev/null | head -10
done
```

**Note:** Multi-line commands (using `\` continuation) require manual review. The extraction patterns above capture single-line commands only.

#### Step 2: Verify Command Syntax

For each extracted command type:

| Command Type | Verification Method | Example |
|--------------|---------------------|---------|
| `gh pr checks --json X` | Check `gh pr checks --help` for valid JSON fields | `gh pr checks --help \| grep -A 30 "JSON FIELDS"` |
| `gh issue view --json X` | Check `gh issue view --help` for valid JSON fields | `gh issue view --help \| grep -A 30 "JSON FIELDS"` |
| `gh api ...` | Verify endpoint format matches GitHub API | Check endpoint structure |
| `npm run <script>` | Verify script exists in package.json | `jq '.scripts["<script>"]' package.json` |
| `npx tsx <file>` | Verify file exists | `test -f <file>` |
| `git <cmd>` | Verify against `git <cmd> --help` | Check valid flags |

**JSON Field Validation Example:**

```bash
# For commands like: gh pr checks --json name,state,conclusion
# Verify each field exists

# Get valid fields
valid_fields=$(gh pr checks --help 2>/dev/null | grep -A 50 "JSON FIELDS" | grep -E "^\s+\w+" | awk '{print $1}')

# Check if "conclusion" is valid (spoiler: it's not)
echo "$valid_fields" | grep -qw "conclusion" && echo "✅ conclusion exists" || echo "❌ conclusion NOT a valid field"
```

#### Step 3: Handle Placeholders

Commands with placeholders (`<issue-number>`, `$PR_NUMBER`, `${VAR}`) cannot be executed directly.

**Handling:**
- **Skip execution** for commands with placeholders
- **Mark as "Syntax verified, execution skipped"**
- **Still verify JSON fields** by extracting field names

```bash
# Example: gh pr checks $pr_number --json name,state,bucket
# Can't execute (no $pr_number), but can verify fields
echo "name,state,bucket" | tr ',' '\n' | while read field; do
  gh pr checks --help | grep -qw "$field" && echo "✅ $field" || echo "❌ $field"
done
```

#### Step 4: Command Verification Status

| Status | Meaning |
|--------|---------|
| **Passed** | All commands verified, fields exist |
| **Failed** | At least one command has invalid syntax or non-existent fields |
| **Skipped** | Commands have placeholders; syntax looks valid but not executed |
| **Not Required** | No skill files changed |

#### Verdict Gating

**CRITICAL:** If skill command verification = **Failed**, verdict CANNOT be `READY_FOR_MERGE`.

| Verification Status | Maximum Verdict |
|---------------------|-----------------|
| Passed | READY_FOR_MERGE |
| Skipped | READY_FOR_MERGE (with note about unverified placeholders) |
| Failed | AC_MET_BUT_NOT_A_PLUS (blocks merge until fixed) |
| Not Required | READY_FOR_MERGE |

**Output Format:**

```markdown
### Skill Command Verification

**Skill files changed:** 2

| File | Commands Found | Verification Status |
|------|----------------|---------------------|
| `.claude/skills/qa/SKILL.md` | 5 | ✅ Passed |
| `.claude/skills/exec/SKILL.md` | 3 | ⚠️ Skipped (placeholders) |

**Commands Verified:**
- `gh pr checks --json name,state,bucket` → ✅ All fields exist
- `gh issue view --json title,body` → ✅ All fields exist

**Commands with Issues:**
- `gh pr checks --json conclusion` → ❌ Field "conclusion" does not exist

**Verification Status:** Failed
```

---

### 7. A+ Status Verdict

Provide an overall verdict:

- `READY_FOR_MERGE` — ALL ACs are `MET` and code quality is high ("A+")
- `AC_MET_BUT_NOT_A_PLUS` — ALL ACs are `MET`, but meaningful improvements recommended
- `NEEDS_VERIFICATION` — ALL ACs are `MET` or `PENDING`, at least one requires external verification
- `AC_NOT_MET` — One or more ACs are `NOT_MET` or `PARTIALLY_MET`

**Verdict Determination Algorithm (REQUIRED):**

```text
1. Count AC statuses (INCLUDES both original AND derived ACs):
   - met_count = ACs with status MET (original + derived)
   - partial_count = ACs with status PARTIALLY_MET (original + derived)
   - pending_count = ACs with status PENDING (original + derived)
   - not_met_count = ACs with status NOT_MET (original + derived)

   NOTE: Derived ACs are treated IDENTICALLY to original ACs.
   A derived AC marked NOT_MET will block merge just like an original AC.

2. Check verification gates:
   - skill_verification = status from Section 6a (Passed/Failed/Skipped/Not Required)
   - execution_evidence = status from Section 6 (Complete/Incomplete/Waived/Not Required)
   - quality_plan_status = status from Phase 0b (Complete/Partial/Not Addressed/N/A)

3. Determine verdict (in order):
   - IF not_met_count > 0 OR partial_count > 0:
       → AC_NOT_MET (block merge)
   - ELSE IF skill_verification == "Failed":
       → AC_MET_BUT_NOT_A_PLUS (skill commands have issues - cannot be READY_FOR_MERGE)
   - ELSE IF execution_evidence == "Incomplete":
       → AC_MET_BUT_NOT_A_PLUS (scripts not verified - cannot be READY_FOR_MERGE)
   - ELSE IF quality_plan_status == "Not Addressed" AND quality_plan_exists:
       → AC_MET_BUT_NOT_A_PLUS (quality dimensions not addressed - flag for review)
   - ELSE IF pending_count > 0:
       → NEEDS_VERIFICATION (wait for verification)
   - ELSE IF quality_plan_status == "Partial":
       → AC_MET_BUT_NOT_A_PLUS (some quality dimensions incomplete - can merge with notes)
   - ELSE IF improvement_suggestions.length > 0:
       → AC_MET_BUT_NOT_A_PLUS (can merge with notes)
   - ELSE:
       → READY_FOR_MERGE (A+ implementation)
```

**CRITICAL:** `PARTIALLY_MET` is NOT sufficient for merge. It MUST be treated as `NOT_MET` for verdict purposes.

**CRITICAL:** If skill command verification = "Failed", verdict CANNOT be `READY_FOR_MERGE`. This prevents shipping skills with broken commands (like issue #178's `conclusion` field).

See [quality-gates.md](references/quality-gates.md) for detailed verdict criteria.

---

## Automated Quality Checks (Reference)

**Note:** These commands are what the sub-agents execute internally. You do NOT run these directly — the sub-agents spawned above handle this. This section is reference documentation only.

```bash
# Type safety
type_issues=$(git diff main...HEAD | grep -E ":\s*any[,)]|as any" | wc -l | xargs)

# Deleted tests
deleted_tests=$(git diff main...HEAD --diff-filter=D --name-only | grep -E "\\.test\\.|\\spec\\." | wc -l | xargs)

# Scope check
files_changed=$(git diff main...HEAD --name-only | wc -l | xargs)

# Size check
additions=$(git diff main...HEAD --numstat | awk '{sum+=$1} END {print sum+0}')
deletions=$(git diff main...HEAD --numstat | awk '{sum+=$2} END {print sum+0}')

# Security scan
npx tsx scripts/lib/__tests__/run-security-scan.ts 2>/dev/null
```

See [scripts/quality-checks.sh](scripts/quality-checks.sh) for the complete automation script.

### 8. Draft Review/QA Comment

Produce a Markdown snippet for the PR/issue:
- Short summary of the change
- AC coverage status (bullet list)
- Key strengths and issues
- Clear, actionable next steps

### 9. Update GitHub Issue

**If orchestrated (SEQUANT_ORCHESTRATOR is set):**
- Skip posting GitHub comment (orchestrator handles aggregated summary)
- Include verdict and AC coverage in output for orchestrator to capture
- Let orchestrator update labels based on final workflow status

**If standalone:**

Post the draft comment to GitHub and update labels:

- `AC_NOT_MET`: add `needs-work` label
- `READY_FOR_MERGE`: add `ready-for-review` label
- `AC_MET_BUT_NOT_A_PLUS`: add `needs-improvement` label
- `NEEDS_VERIFICATION`: add `needs-verification` label

### 10. Documentation Reminder

If verdict is `READY_FOR_MERGE` or `AC_MET_BUT_NOT_A_PLUS`:

```md
**Documentation:** Before merging, run `/docs <issue>` to generate feature documentation.
```

### 11. Script/CLI Execution Verification

**REQUIRED for CLI/script features:** When `scripts/` files are modified, execution verification is required before `READY_FOR_MERGE`.

**Detection:**
```bash
scripts_changed=$(git diff main...HEAD --name-only | grep -E "^(scripts/|templates/scripts/)" | wc -l | xargs)
if [[ $scripts_changed -gt 0 ]]; then
  echo "Script changes detected. Run /verify before READY_FOR_MERGE"
fi
```

**Verification evidence:** Look for "Execution Verification" section in issue comments. This section is posted by the `/verify` skill and includes:
- Command executed
- Exit code and duration
- Output sample (truncated)
- Human confirmation of expected behavior

**If no verification evidence exists:**
1. Prompt: "Script changes detected but no execution verification found. Run `/verify <issue> --command \"<test command>\"` before READY_FOR_MERGE verdict."
2. Do NOT give `READY_FOR_MERGE` verdict until verification is complete (unless an approved override applies — see Section 11a)
3. Verdict should be `AC_MET_BUT_NOT_A_PLUS` with note about missing verification

**Why this matters:**
- Code review + unit tests miss integration issues
- CLI features must be executed at least once to verify end-to-end behavior

**Example workflow:**
```bash
# QA detects scripts/ or templates/scripts/ changes
# -> Prompt: "Run /verify before READY_FOR_MERGE"

/verify 558 --command "npx tsx scripts/migrate.ts --dry-run"

# Human confirms output looks correct
# -> /verify posts evidence to issue

/qa 558  # Re-run, now sees verification, can give READY_FOR_MERGE
```

### 11a. Script Verification Override

In some cases, `/verify` execution can be safely skipped when script changes are purely cosmetic or have no runtime impact. **Overrides require explicit justification and risk assessment.**

**Override Format (REQUIRED when skipping /verify):**

```markdown
### Script Verification Override

**Requirement:** `/verify` before READY_FOR_MERGE
**Override:** Yes
**Justification:** [One of the approved categories below]
**Risk Assessment:** [None/Low/Medium]
```

**Approved Override Categories:**

| Category | Example | Risk |
|----------|---------|------|
| Syntax-only refactor | `catch (error)` → `catch` | None |
| Comment/documentation changes | Adding JSDoc, updating comments | None |
| Type annotation additions | Adding `: string`, `: number` | None |
| Import reorganization | Sorting imports, removing unused | None |
| Variable rename (no logic change) | `foo` → `bar` with no behavioral change | Low |
| Dead code removal | Removing unreachable branches | Low |

**NOT Approved for Override (always require /verify):**

| Category | Example | Why |
|----------|---------|-----|
| Logic changes | Modified conditionals, new branches | Runtime behavior changes |
| New functionality | Added functions, new exports | Must verify execution |
| Dependency changes | Updated imports from new packages | May affect runtime |
| Error handling changes | Modified catch blocks, new try/catch | Failure paths change |
| Configuration changes | Modified env vars, config parsing | Environment-dependent |

**Risk Assessment Definitions:**

| Level | Meaning | Criteria |
|-------|---------|----------|
| **None** | Zero runtime impact | Change is invisible at runtime (comments, types, syntax) |
| **Low** | Negligible runtime impact | Change is cosmetic (rename, dead code) with no logical effect |
| **Medium** | Possible runtime impact | Change touches executable code but appears safe — **should NOT be overridden** |

**Override Decision Flow:**

1. Check if change matches an approved category → If no, `/verify` is required
2. Assess risk level → If Medium or higher, `/verify` is required
3. Document override using the format above in the QA output
4. Include override in the GitHub issue comment for audit trail

**CRITICAL:** When in doubt, run `/verify`. Overrides are for clear-cut cases only. If you need to argue that a change is safe, it probably needs verification.

---

## State Tracking

**IMPORTANT:** Update workflow state when running standalone (not orchestrated).

### State Updates (Standalone Only)

When NOT orchestrated (`SEQUANT_ORCHESTRATOR` is not set):

**At skill start:**
```bash
npx tsx scripts/state/update.ts start <issue-number> qa
```

**On successful completion (READY_FOR_MERGE or AC_MET_BUT_NOT_A_PLUS):**
```bash
npx tsx scripts/state/update.ts complete <issue-number> qa
npx tsx scripts/state/update.ts status <issue-number> ready_for_merge
```

**On failure (AC_NOT_MET):**
```bash
npx tsx scripts/state/update.ts fail <issue-number> qa "AC not met"
```

**Why this matters:** State tracking enables dashboard visibility, resume capability, and workflow orchestration. Skills update state when standalone; orchestrators handle state when running workflows.

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

### Standard QA (Implementation Exists)

- [ ] **Self-Evaluation Completed** - Adversarial self-evaluation section included in output
- [ ] **AC Coverage** - Each AC item marked as MET, PARTIALLY_MET, NOT_MET, PENDING, or N/A
- [ ] **Quality Plan Verification** - Included if quality plan exists (or marked N/A if no quality plan)
- [ ] **CI Status** - Included if PR exists (or marked "No PR" / "No CI configured")
- [ ] **Verdict** - One of: READY_FOR_MERGE, AC_MET_BUT_NOT_A_PLUS, NEEDS_VERIFICATION, AC_NOT_MET
- [ ] **Quality Metrics** - Type issues, deleted tests, files changed, additions/deletions
- [ ] **Cache Status** - Included if caching enabled (or marked N/A if --no-cache)
- [ ] **Build Verification** - Included if build failed (or marked N/A if build passed)
- [ ] **Test Coverage Analysis** - Changed files with/without tests, critical paths flagged
- [ ] **Code Review Findings** - Strengths, issues, suggestions
- [ ] **Test Quality Review** - Included if test files modified (or marked N/A)
- [ ] **Anti-Pattern Detection** - Dependency audit (if package.json changed) + code patterns
- [ ] **Execution Evidence** - Included if scripts/CLI modified (or marked N/A)
- [ ] **Script Verification Override** - Included if scripts/CLI modified AND /verify was skipped (with justification and risk assessment)
- [ ] **Skill Command Verification** - Included if `.claude/skills/**/*.md` modified (or marked N/A)
- [ ] **Skill Change Review** - Skill-specific adversarial prompts included if skills changed
- [ ] **Documentation Check** - README/docs updated if feature adds new functionality
- [ ] **Next Steps** - Clear, actionable recommendations

### Early Exit (No Implementation)

When early exit is triggered (no commits, no uncommitted changes, no PR):

- [ ] **Implementation Status** - Clearly states "NOT FOUND"
- [ ] **Verdict** - Must be `AC_NOT_MET`
- [ ] **Next Steps** - Directs user to run `/exec` first
- [ ] **Sub-agents NOT spawned** - Quality check agents were skipped

**DO NOT respond until all applicable items are verified.**

## Output Template

You MUST include these sections:

```markdown
## QA Review for Issue #<N>

### AC Coverage

| AC | Source | Description | Status | Notes |
|----|--------|-------------|--------|-------|
| AC-1 | Original | [description] | MET/PARTIALLY_MET/NOT_MET/PENDING/N/A | [explanation] |
| AC-2 | Original | [description] | MET/PARTIALLY_MET/NOT_MET/PENDING/N/A | [explanation] |
| **Derived ACs** | | | | |
| AC-6 | Derived (Error Handling) | [description from quality plan] | MET/PARTIALLY_MET/NOT_MET | [explanation] |
| AC-7 | Derived (Test Coverage) | [description from quality plan] | MET/PARTIALLY_MET/NOT_MET | [explanation] |

**Coverage:** X/Y AC items fully met (includes derived ACs)
**Original ACs:** X/Y met
**Derived ACs:** X/Y met

---

### Quality Plan Verification

[Include if quality plan exists in issue comments, otherwise: "N/A - No quality plan found"]

| Dimension | Items Planned | Items Addressed | Status |
|-----------|---------------|-----------------|--------|
| Completeness | X | X | ✅ Complete / ⚠️ Partial / ❌ Not addressed |
| Error Handling | X | X | ✅ Complete / ⚠️ Partial / ❌ Not addressed |
| Code Quality | X | X | ✅ Complete / ⚠️ Partial / ❌ Not addressed |
| Test Coverage | X | X | ✅ Complete / ⚠️ Partial / ❌ Not addressed |
| Best Practices | X | X | ✅ Complete / ⚠️ Partial / ❌ Not addressed |
| Polish | X | X | ✅ Complete / ⚠️ Partial / N/A (not UI) |

**Derived ACs:** X/Y addressed
**Quality Plan Status:** Complete / Partial / Not Addressed

---

### CI Status

[Include if PR exists, otherwise: "No PR exists yet" or "No CI configured"]

| Check | State | Conclusion | Impact |
|-------|-------|------------|--------|
| `[check name]` | completed/in_progress/queued/pending | success/failure/cancelled/skipped/- | ✅ MET / ❌ NOT_MET / ⏳ PENDING |

**CI Summary:** X passed, Y pending, Z failed
**CI-related AC items:** [list affected AC items and their status based on CI]

---

### Quality Metrics

| Metric | Value | Status |
|--------|-------|--------|
| Type issues (`any`) | X | OK/WARN |
| Deleted tests | X | OK/WARN |
| Files changed | X | OK/WARN |
| Lines added | +X | - |
| Lines deleted | -X | - |

---

### Cache Status

[Include if caching enabled, otherwise: "N/A - Caching disabled (--no-cache)"]

| Check | Cache Status |
|-------|--------------|
| type-safety | ✅ HIT / ❌ MISS / ⏭️ SKIP |
| deleted-tests | ✅ HIT / ❌ MISS / ⏭️ SKIP |
| scope | ⏭️ SKIP (always fresh) |
| size | ⏭️ SKIP (always fresh) |
| security | ✅ HIT / ❌ MISS / ⏭️ SKIP |
| semgrep | ✅ HIT / ❌ MISS / ⏭️ SKIP |
| build | ✅ HIT / ❌ MISS / ⏭️ SKIP |

**Summary:** X hits, Y misses, Z skipped
**Performance:** [Note if cached checks saved time]

---

### Build Verification

[Include if `npm run build` failed, otherwise: "N/A - Build passed"]

| Check | Status |
|-------|--------|
| Feature branch build | ✅ Passed / ❌ Failed |
| Main branch build | ✅ Passed / ❌ Failed |
| Error match | ✅ Same error / ❌ Different errors / N/A |
| Regression | **Yes** (new) / **No** (pre-existing) / **Unknown** |

**Note:** [Explanation of build verification result]

**Verdict impact:** [None / Blocking / Needs review]

---

### Test Coverage Analysis

| Changed File | Tier | Has Tests? | Test File |
|--------------|------|------------|-----------|
| `[file]` | Critical/Standard/Optional | ✅ Yes / ⚠️ No | `[test file or -]` |

**Coverage:** X/Y changed source files have corresponding tests
**Critical paths without tests:** [list or "None"]

---

### Code Review

**Strengths:**
- [Positive findings]

**Issues:**
- [Problems found]

**Suggestions:**
- [Improvements recommended]

---

### Test Quality Review

[Include if test files were added/modified, otherwise: "N/A - No test files modified"]

| Category | Status | Notes |
|----------|--------|-------|
| Behavior vs Implementation | ✅ OK / ⚠️ WARN | [notes] |
| Coverage Depth | ✅ OK / ⚠️ WARN | [notes] |
| Mock Hygiene | ✅ OK / ⚠️ WARN | [notes] |
| Test Reliability | ✅ OK / ⚠️ WARN | [notes] |

**Issues Found:**
- [file:line - description]

---

### Anti-Pattern Detection

#### Dependency Audit
[Include if package.json modified, otherwise: "N/A - No dependency changes"]

| Package | Downloads/wk | Last Update | Flags |
|---------|--------------|-------------|-------|
| [pkg] | [count] | [date] | [flags] |

#### Code Patterns

| File:Line | Category | Pattern | Suggestion |
|-----------|----------|---------|------------|
| [location] | [category] | [pattern] | [fix] |

**Critical Issues:** X
**Warnings:** Y

---

### Execution Evidence

[Include if scripts/CLI modified, otherwise: "N/A - No executable changes"]

| Test Type | Command | Exit Code | Result |
|-----------|---------|-----------|--------|
| Smoke test | `[command]` | [code] | [result] |

**Evidence status:** Complete / Incomplete / Waived (reason) / Not Required

---

### Script Verification Override

[Include if scripts/CLI modified AND /verify was skipped, otherwise omit this section]

**Requirement:** `/verify` before READY_FOR_MERGE
**Override:** Yes
**Justification:** [Approved category from Section 11a]
**Risk Assessment:** [None/Low/Medium]

---

### Skill Command Verification

[Include if `.claude/skills/**/*.md` modified, otherwise: "N/A - No skill files changed"]

**Skill files changed:** X

| File | Commands Found | Verification Status |
|------|----------------|---------------------|
| `[skill file]` | [count] | ✅ Passed / ❌ Failed / ⚠️ Skipped |

**Commands Verified:**
- `[command]` → ✅ [result]

**Commands with Issues:**
- `[command]` → ❌ [issue description]

**Verification Status:** Passed / Failed / Skipped / Not Required

---

### Skill Change Review

[Include if skill files changed, otherwise omit]

- [ ] **Command verified:** Did you execute at least one referenced command?
- [ ] **Fields verified:** For JSON commands, do field names match actual output?
- [ ] **Patterns complete:** What variations might users write that aren't covered?
- [ ] **Dependencies explicit:** What CLIs/tools does this skill assume are installed?

---

### Self-Evaluation

- **Verified working:** [Yes/No - did you actually verify the feature works?]
- **Test efficacy:** [High/Medium/Low - do tests catch the feature breaking?]
- **Likely failure mode:** [What would most likely break this in production?]
- **Verdict confidence:** [High/Medium/Low - explain any uncertainty]

---

### Verdict: [READY_FOR_MERGE | AC_MET_BUT_NOT_A_PLUS | NEEDS_VERIFICATION | AC_NOT_MET]

[Explanation of verdict]

### Documentation

- [ ] README updated (if new feature/flag)
- [ ] docs/ updated (if behavior changed)
- [ ] CHANGELOG entry added (for user-facing changes)
- [ ] N/A - No documentation needed (bug fix, internal refactor)

### Next Steps

1. [Action item 1]
2. [Action item 2]
```
