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
  - Agent(sequant-qa-checker)
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
  jq -r 'select(.phase == "exec" and .status == "completed")' 2>/dev/null || true)

if [[ -z "$exec_completed" ]]; then
  # Check if any exec marker exists at all
  exec_any=$(echo "$comments_json" | \
    grep -o '{[^}]*}' | grep '"phase"' | \
    jq -r 'select(.phase == "exec")' 2>/dev/null || true)

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

When posting the QA review comment to GitHub, append a phase marker at the end.

**IMPORTANT:** Always include the `commitSHA` field with the current HEAD SHA. This enables incremental re-runs by recording the baseline commit for future QA runs.

```bash
# Get current HEAD SHA for the phase marker
COMMIT_SHA=$(git rev-parse HEAD)
```

```markdown
<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"<ISO-8601>","commitSHA":"<HEAD-SHA>","verdict":"<READY_FOR_MERGE|AC_MET_BUT_NOT_A_PLUS|NEEDS_VERIFICATION>"} -->
```

**Note:** The `verdict` field is required on `status:"completed"` markers so the Phase 0a short-circuit can surface the prior verdict without re-reading the comment body. Older markers without this field are still accepted — Phase 0a falls back to `(see prior QA comment)`.

If QA determines AC_NOT_MET, emit:
```markdown
<!-- SEQUANT_PHASE: {"phase":"qa","status":"failed","timestamp":"<ISO-8601>","error":"AC_NOT_MET","commitSHA":"<HEAD-SHA>"} -->
```

Include this marker in every `gh issue comment` that represents QA completion.

## Behavior

Invocation:

- `/qa 123`: Treat `123` as the GitHub issue/PR identifier in context.
- `/qa 123 172`: Treat both as issue numbers — process each sequentially.
- `/qa <freeform description>`: Treat the text as context about the change to review.
- `/qa 123 --parallel`: Force parallel agent execution (faster, higher token usage).
- `/qa 123 --sequential`: Force sequential agent execution (slower, lower token usage).
- `/qa 123 --force`: Bypass prior-QA short-circuit and force a full re-run even if the last QA covers the current commit.

### Multi-Issue Invocation

When multiple issue numbers are provided (e.g., `/qa 167 172`):

1. **Parse all issue numbers** from args
2. **Process each issue sequentially** with inline code review — do NOT spawn ad-hoc background agents for the diff reading or AC verification portions
3. The built-in `sequant-qa-checker` sub-agents (type safety, scope, security) continue to run per the size gate rules for each issue
4. Each issue gets its own full QA cycle: context fetch → diff review → quality checks → verdict → comment
5. Post a **separate QA comment** to each issue's GitHub thread

**Why sequential with inline review:** Ad-hoc background agents for code review are unreliable — they hallucinate about file existence, misattribute API patterns, and hit permission issues on worktree reads. The narrowly-scoped `sequant-qa-checker` agents work well because they have specific, bounded tasks. The code review portion must stay inline for accuracy.

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

### Stale Branch Detection

**Skip this section if `SEQUANT_ORCHESTRATOR` is set** - the orchestrator handles branch freshness checks.

**Purpose:** Detect when the feature branch is significantly behind main, which can lead to:
- QA cycles wasted reviewing code that won't cleanly merge
- False `READY_FOR_MERGE` verdicts that fail at merge time
- Conflicts that require rework after QA approval

**Detection:**

```bash
# Ensure we have latest remote state
git fetch origin 2>/dev/null || true

# Count commits behind main
behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "0")
echo "Feature branch is $behind commits behind main"
```

**Threshold Configuration:**

The stale branch threshold is configurable in `.sequant/settings.json`:

```json
{
  "run": {
    "staleBranchThreshold": 5
  }
}
```

Default: 5 commits

**Behavior:**

| Commits Behind | Action |
|----------------|--------|
| 0 | ✅ Proceed normally |
| 1 to threshold | ⚠️ **Warning:** "Feature branch is N commits behind main. Consider rebasing before QA." |
| > threshold | ❌ **Block:** "STALE_BRANCH: Feature branch is N commits behind main (threshold: T). Rebase required before QA." |

**Implementation:**

```bash
# Read threshold from settings (default: 5)
threshold=$(jq -r '.run.staleBranchThreshold // 5' .sequant/settings.json 2>/dev/null || echo "5")

behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "0")

if [[ $behind -gt $threshold ]]; then
  echo "❌ STALE_BRANCH: Feature branch is $behind commits behind main (threshold: $threshold)"
  echo "   Rebase required before QA:"
  echo "   git fetch origin && git rebase origin/main"
  # Exit with error - QA should not proceed
  exit 1
elif [[ $behind -gt 0 ]]; then
  echo "⚠️ Warning: Feature branch is $behind commits behind main."
  echo "   Consider rebasing before QA: git fetch origin && git rebase origin/main"
  # Continue with warning
fi
```

**Output Format:**

Include in QA output when branch is stale:

```markdown
### Stale Branch Check

| Check | Value |
|-------|-------|
| Commits behind main | N |
| Threshold | T |
| Status | ✅ OK / ⚠️ Warning / ❌ Blocked |

[Warning/blocking message if applicable]
```

**Verdict Impact:**

| Status | Verdict Impact |
|--------|----------------|
| OK (0 behind) | No impact |
| Warning (1 to threshold) | Note in findings, recommend rebase |
| Blocked (> threshold) | **Cannot proceed** - rebase first |

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
worktree_path=$(git worktree list | grep -i "<issue-number>" | awk '{print $1}' | head -1 || true)

# 2. Check for commits on feature branch (vs main) — include ALL file types
commits_exist=$(git log --oneline main..HEAD 2>/dev/null | head -1)

# 3. Check for uncommitted changes
uncommitted_changes=$(git status --porcelain | head -1)

# 4. Check for open PR linked to this issue
pr_exists=$(gh pr list --search "<issue-number>" --state open --json number -q '.[0].number' 2>/dev/null)

# 5. Check for ANY file changes (including .md, prompt-only changes)
any_diff=$(git diff --name-only main..HEAD 2>/dev/null | head -1 || true)
```

**IMPORTANT: Prompt-only and markdown-only changes ARE valid implementations.** Many issues (e.g., skill improvements, documentation features) are implemented entirely via `.md` file changes. The detection logic must count these as real implementation, not skip them.

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

**False Negative Prevention (CRITICAL):**

Root cause analysis (#448) found that 33% of multi-attempt QA failures were caused by QA reporting "NOT FOUND" when implementation existed. Common causes:

| Cause | Example | Fix |
|-------|---------|-----|
| Prompt-only changes | Skill SKILL.md modifications (#413) | Check `git diff --name-only` for ANY file, not just .ts/.tsx |
| Cross-repo work | Landing page issue tracked in main repo (#393) | Check exec progress comments for cross-repo indicators |
| Worktree mismatch | QA runs in wrong directory | Verify `pwd` matches expected worktree path |

**If `git diff --name-only main..HEAD` shows files but standard detection says "NOT FOUND":**
1. The implementation exists — proceed with QA
2. Adapt review approach to the file types changed (e.g., review .md changes for content quality rather than TypeScript compilation)

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

**CRITICAL — Before early exit, double-check for false negatives:**
```bash
# Final safety check: are there ANY file changes vs main?
any_changes=$(git diff --name-only main..HEAD 2>/dev/null | wc -l | xargs || echo "0")
if [[ "$any_changes" -gt 0 ]]; then
  echo "WARNING: $any_changes files changed but detection said NOT FOUND"
  echo "Changed files:"
  git diff --name-only main..HEAD 2>/dev/null | head -20
  echo "Proceeding with QA instead of early exit."
  # DO NOT early exit — proceed with QA
fi
```

---

### Phase 0a: Prior QA Short-Circuit Check

**After confirming implementation exists** (Phase 0 passed), check whether a prior QA run already covers the current commit. This avoids re-running the full QA pipeline when nothing has changed.

**Skip this check if any of these are true:**
- `--force` flag is present in the invocation args
- `--no-cache` flag is present in the invocation args
- `SEQUANT_ORCHESTRATOR` is set and the orchestrator explicitly requests a fresh run

**Detection Logic:**

```bash
# 1. Get current HEAD SHA
current_sha=$(git rev-parse HEAD)

# 2. Fetch the latest qa:completed or qa:failed phase marker from issue comments
# NOTE: Use `.comments[].body` (NOT `[.comments[].body]`). The array form JSON-encodes
# each body, escaping internal quotes (`"phase":"qa"` → `\"phase\":\"qa\"`) and `<` →
# `\u003c`, which defeats the grep pattern below. The streaming form outputs raw bodies.
latest_qa_marker=$(gh issue view <issue-number> --json comments --jq '.comments[].body' | \
  grep -o '<!-- SEQUANT_PHASE: {[^}]*"phase":"qa"[^}]*} -->' | \
  tail -1 || true)

# 3. Extract status, commitSHA, verdict, and timestamp from the marker
if [[ -n "$latest_qa_marker" ]]; then
  marker_json=$(echo "$latest_qa_marker" | grep -o '{[^}]*}')
  marker_status=$(echo "$marker_json" | jq -r '.status // empty' 2>/dev/null || true)
  marker_sha=$(echo "$marker_json" | jq -r '.commitSHA // empty' 2>/dev/null || true)
  marker_timestamp=$(echo "$marker_json" | jq -r '.timestamp // empty' 2>/dev/null || true)
  marker_verdict=$(echo "$marker_json" | jq -r '.verdict // empty' 2>/dev/null || true)
fi
```

**Short-Circuit Decision Matrix:**

| marker_status | marker_sha == HEAD | Action |
|---------------|-------------------|--------|
| `completed` | Yes | **Short-circuit** — skip full QA |
| `completed` | No | Proceed with full QA (new commits since last run) |
| `failed` | Yes or No | Proceed with full QA (user likely wants re-run after fix) |
| (not found) | N/A | Proceed with full QA (no prior run) |

**When short-circuiting (status=completed, SHA matches):**

1. **Skip** sub-agent spawning
2. **Skip** code review and quality checks
3. **Output** the short-circuit summary (template below)
4. **Do NOT** post a new GitHub comment (the prior comment is still valid)

**Short-Circuit Output Template:**

Populate `**Prior Verdict:**` from `$marker_verdict` when non-empty. When empty (legacy marker without the field), substitute the literal string `(see prior QA comment)`.

```markdown
## QA Review for Issue #<N>

### Prior QA Still Valid

QA already completed at commit `<SHA>` on <timestamp> — no changes since last run.
Current HEAD (`<current_sha>`) matches the previously reviewed commit.

**Prior Verdict:** <$marker_verdict OR "(see prior QA comment)" if empty>

To force a full re-run, use: `/qa <N> --force` or `/qa <N> --no-cache`

---

*QA short-circuited: prior run at same SHA is still valid*
```

**Verdict field handling:**

| `$marker_verdict` | Action |
|-------------------|--------|
| Non-empty (new markers) | Emit literally: `**Prior Verdict:** READY_FOR_MERGE` (etc.) |
| Empty (legacy markers) | Emit: `**Prior Verdict:** (see prior QA comment)` — the prior comment body contains the full verdict |

The short-circuit itself still triggers in both cases — only the displayed verdict text differs.

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
     sort -u || true)

   # Count derived ACs
   derived_count=$(echo "$derived_acs" | grep -c "AC-" || true)
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
| `build (20.x)` | SUCCESS | pass | ✅ MET |
| `build (22.x)` | PENDING | pending | ⏳ PENDING |
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

### Small-Diff Fast Path (Size Gate)

**Purpose:** Skip sub-agent spawning for trivial diffs to save ~30s latency and reduce token cost.

**Evaluate the size gate BEFORE spawning any quality check sub-agents:**

```bash
# 1. Read threshold from settings (default: 100)
threshold=$(cat .sequant/settings.json 2>/dev/null | grep -o '"smallDiffThreshold"[[:space:]]*:[[:space:]]*[0-9]*' | grep -o '[0-9]*$' || echo "100")
if [ -z "$threshold" ]; then threshold=100; fi

# 2. Compute diff size (additions + deletions)
diff_stats=$(git diff origin/main...HEAD --stat | tail -1 || true)
additions=$(echo "$diff_stats" | grep -o '[0-9]* insertion' | grep -o '[0-9]*' || echo "0")
deletions=$(echo "$diff_stats" | grep -o '[0-9]* deletion' | grep -o '[0-9]*' || echo "0")
total_changes=$((${additions:-0} + ${deletions:-0}))

# 3. Check if package.json changed
pkg_changed=$(git diff origin/main...HEAD --name-only | grep -c '^package\.json$' || true)

# 4. Check security-sensitive paths (reuses existing heuristic from anti-pattern detection)
security_paths=$(git diff origin/main...HEAD --name-only | grep -iE 'auth|payment|security|server-action|middleware|admin' || true)
security_sensitive="false"
if [ -n "$security_paths" ]; then security_sensitive="true"; fi

echo "Size gate: $total_changes lines changed (threshold: $threshold), pkg_changed=$pkg_changed, security=$security_sensitive"
```

**Size gate decision:**

| Condition | Result |
|-----------|--------|
| `total_changes < threshold` AND `pkg_changed == 0` AND `security_sensitive == false` | `SMALL_DIFF=true` — use inline checks |
| Any condition fails | `SMALL_DIFF=false` — use sub-agents (standard pipeline) |
| Size gate evaluation errors (e.g., git fails) | `SMALL_DIFF=false` — fall back to full pipeline (AC-5) |

**Log the decision (AC-6):**

```markdown
### Size Gate

| Check | Value |
|-------|-------|
| Diff size | N lines (threshold: T) |
| package.json changed | Yes/No |
| Security-sensitive paths | Yes/No [list if yes] |
| Decision | **Inline checks** / **Sub-agents** |
```

#### If `SMALL_DIFF=true`: Inline Quality Checks

Run these checks directly (no sub-agents needed):

**IMPORTANT:** Use the Grep tool (not bash `grep`) for pattern matching — bash grep uses BSD regex on macOS which is incompatible with some patterns below. The Grep tool uses ripgrep which works cross-platform.

```bash
# Deleted tests check
deleted_tests=$(git diff origin/main...HEAD --name-only --diff-filter=D | grep -cE '\.(test|spec)\.' || true)

# Scope: files changed count
files_changed=$(git diff origin/main...HEAD --name-only | wc -l | tr -d ' ')
```

For type safety and security scans, use the Grep tool instead of bash:
- **Type safety:** `Grep(pattern=":\\s*any[,;)\\]]|as any", path="<changed-files>")` on added lines
- **Security scan:** `Grep(pattern="eval\\(|innerHTML|dangerouslySetInnerHTML|password.*=.*[\"']|secret.*=.*[\"']", path="<changed-files>")` on added lines

Count results from the Grep tool output to get `any_count` and `security_issues`.

**After inline checks, skip to the output template** (the sub-agent section below is not executed).

#### If `SMALL_DIFF=false`: Use Sub-Agents (Standard Pipeline)

Proceed to the standard Quality Checks section below.

---

### Quality Checks (Multi-Agent) — REQUIRED

**When `SMALL_DIFF=false`**, you MUST spawn sub-agents for quality checks. Do NOT run these checks inline with bash commands. Sub-agents provide parallel execution, better context isolation, and consistent reporting.

**Execution mode:** Respect the agent execution mode determined above (see "Agent Execution Mode" section).

#### Documentation Issue Detection

Check if this is a documentation-only issue by reading the `SEQUANT_ISSUE_TYPE` environment variable:

```bash
issue_type="${SEQUANT_ISSUE_TYPE:-}"
```

**If `SEQUANT_ISSUE_TYPE=docs`**, use the lighter docs QA pipeline:

- **Skip** type safety sub-agent (no TypeScript changes expected)
- **Skip** security scan sub-agent (no runtime code changes)
- **Keep** scope/size check (still useful for docs)
- **Focus review on:** content accuracy, completeness, formatting, and link validity

**Docs QA sub-agents (1 agent instead of 3):**

1. `Agent(subagent_type="sequant-qa-checker", prompt="Run scope and size checks on the current branch vs main. Check for broken links in changed markdown files. Report: files count, diff size, broken links, size assessment.")`

**If `SEQUANT_ISSUE_TYPE` is not set or is not `docs`**, use the standard pipeline below.

#### If parallel mode enabled:

**Spawn ALL THREE agents in a SINGLE message (one Tool call per agent, all in same response):**

**IMPORTANT:** Background agents need `mode="bypassPermissions"` to execute Bash commands (`git diff`, `npm test`, etc.) without interactive approval. The default `acceptEdits` mode only auto-approves Edit/Write — Bash calls are silently denied. These quality check agents only read and analyze; they never write files or push code, so bypassing permissions is safe.

1. `Agent(subagent_type="sequant-qa-checker", prompt="Run type safety and deleted tests checks on the current branch vs main. Report: type issues count, deleted tests, verdict.")`

2. `Agent(subagent_type="sequant-qa-checker", prompt="Run scope and size checks on the current branch vs main. Report: files count, diff size, size assessment.")`

3. `Agent(subagent_type="sequant-qa-checker", prompt="Run security scan on changed files in current branch vs main. Report: critical/warning/info counts, verdict.")`

#### If sequential mode (default):

**Spawn each agent ONE AT A TIME, waiting for each to complete before the next:**

**Note:** Sequential agents run in the foreground where the user can approve Bash interactively. However, for consistency and to avoid approval fatigue, we still use `mode="bypassPermissions"` since these agents only perform read-only quality checks.

1. **First:** `Agent(subagent_type="sequant-qa-checker", prompt="Run type safety and deleted tests checks on the current branch vs main. Report: type issues count, deleted tests, verdict.")`

2. **After #1 completes:** `Agent(subagent_type="sequant-qa-checker", prompt="Run scope and size checks on the current branch vs main. Report: files count, diff size, size assessment.")`

3. **After #2 completes:** `Agent(subagent_type="sequant-qa-checker", prompt="Run security scan on changed files in current branch vs main. Report: critical/warning/info counts, verdict.")`

**Add RLS check if admin files modified:**
```bash
admin_modified=$(git diff main...HEAD --name-only | grep -E "^app/admin/" | head -1 || true)
```

**Add skill sync check if skill files modified:**
```bash
skill_modified=$(git diff main...HEAD --name-only | grep -E "^\.(claude/skills|skills|templates/skills)/" | head -1 || true)
```
If skill files are modified, the quality-checks.sh script automatically runs the three-directory sync check (section 12). If divergence is detected, this blocks `READY_FOR_MERGE` — verdict becomes `AC_MET_BUT_NOT_A_PLUS` with a note to run `npx tsx scripts/check-skill-sync.ts --fix`.

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
changed=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx)$' | grep -v -E '\.test\.|\.spec\.|__tests__' || true)

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
changed=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx)$' || true)
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
changed_files=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx)$' || true)
```

**Check for:**

| Category | Pattern | Risk |
|----------|---------|------|
| Performance | N+1 query (`await` in loop) | ⚠️ Medium |
| Error Handling | Empty catch block | ⚠️ Medium |
| Security | Hardcoded secrets | ❌ High |
| Security | SQL concatenation | ❌ High |
| Security | Server binds all interfaces (`0.0.0.0`) | ❌ High |
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

### 2f. Product Review (When New User-Facing Features Added)

**When to apply:** New CLI commands, MCP tools, configuration options, or other features that end users interact with directly.

**Detection:**
```bash
# Detect user-facing changes
cli_added=$(git diff main...HEAD -- bin/cli.ts | grep -E '^\+.*\.command\(' | wc -l | xargs || true)
new_commands=$(git diff main...HEAD --name-only | grep -E '^src/commands/' | wc -l | xargs || true)
mcp_added=$(git diff main...HEAD --name-only | grep -E '^src/mcp/' | wc -l | xargs || true)
config_changed=$(git diff main...HEAD --name-only | grep -E 'settings|config' | wc -l | xargs || true)

if [[ $((cli_added + new_commands + mcp_added + config_changed)) -gt 0 ]]; then
  echo "User-facing changes detected - running product review"
fi
```

**If user-facing changes detected, answer these questions:**

| Question | What to check |
|----------|---------------|
| **First-time setup:** Can a new user go from zero to working? | List every prerequisite. Try the setup path mentally. |
| **Per-environment differences:** Does this work the same everywhere? | macOS/Linux/Windows, different clients/tools, CI vs local |
| **What does the user see?** | Walk through the actual UX — wait times, output format, progress indicators |
| **What happens after?** | Where's the output? What does the user do next? |
| **Failure modes the user will hit:** | Not code edge cases — real scenarios (wrong directory, missing auth, timeout) |

**Output Format:**

```markdown
### Product Review

**User-facing changes:** [list new commands/tools/options]

| Question | Finding |
|----------|---------|
| First-time setup | [All prerequisites identified? Setup path clear?] |
| Per-environment | [Any client/platform differences?] |
| User sees | [Wait times, output format, progress] |
| After completion | [Where output goes, next steps] |
| Likely failure modes | [Real user scenarios] |

**Gaps found:** [list any gaps, or "None"]
```

**Verdict Impact:**

| Finding | Verdict Impact |
|---------|----------------|
| No gaps | No impact |
| Missing prerequisites in docs | `AC_MET_BUT_NOT_A_PLUS` |
| Feature silently fails in common environment | `AC_NOT_MET` (e.g., wrong cwd, missing auth) |
| Poor UX but functional | Note in findings |

### 2g. Call-Site Review (When New Functions Added)

**When to apply:** New exported functions are detected in the diff.

**Purpose:** Review not just the function implementation but **where** and **how** it's called. A function can be perfectly implemented but called incorrectly at the call site. (Origin: Issue #295 — `rebaseBeforePR()` had thorough unit tests but was called for every issue in a chain loop when the AC specified "only the final branch.")

**Detection:**
```bash
# Find new exported functions (added lines only)
# Catches: export function foo, export async function foo,
#          export const foo = () =>, export const foo = async () =>
fn_exports=$(git diff main...HEAD | grep -E '^\+export (async )?function \w+' | sed 's/^+//' | grep -oE 'function \w+' | awk '{print $2}' || true)
arrow_exports=$(git diff main...HEAD | grep -E '^\+export const \w+ = (async )?\(' | sed 's/^+//' | grep -oE 'const \w+' | awk '{print $2}' || true)
new_exports=$(echo -e "${fn_exports}\n${arrow_exports}" | sed '/^$/d' | sort -u)
export_count=$(echo "$new_exports" | grep -c . || echo 0)

if [[ $export_count -gt 0 ]]; then
  echo "New exported functions detected: $export_count"
  echo "$new_exports"
fi
```

**If new exported functions found:**

#### Step 1: Call-Site Inventory

For each new exported function, identify ALL call sites using the Grep tool:

```
# For each new function, find call sites
# Use the Grep tool for each function name:
Grep(pattern="${func}\\(", glob="*.{ts,tsx}", output_mode="content")
# Then exclude test files, __tests__ dirs, and the export definition itself
```

**Call site types:**
- Direct call: `functionName(args)`
- Method call: `this.functionName(args)` or `obj.functionName(args)`
- Callback: `.then(functionName)` or `array.map(functionName)`
- Conditional: `condition && functionName(args)`

#### Step 2: Condition Audit

For each call site, document the conditions that gate the call:

| Condition Type | Example | Check |
|----------------|---------|-------|
| Guard clause | `if (x) { fn() }` | Does condition match AC? |
| Logical AND | `x && fn()` | Is guard sufficient? |
| Ternary | `x ? fn() : null` | Correct branch? |
| Early return | `if (!x) return; fn()` | Correct logic? |

**Compare conditions against AC constraints:**
- AC says "only when X" → Call site should have `if (X)` guard
- AC says "not in Y mode" → Call site should have `if (!Y)` guard
- AC says "for Z items" → Call site should filter for Z condition

#### Step 3: Loop Awareness

**Detect if function is called inside a loop:**

```
# For each function, use the Grep tool with context to check surrounding lines:
Grep(pattern="${func}\\(", glob="*.{ts,tsx}", output_mode="content", -B=5)
# Then inspect the context lines for loop constructs:
# for, while, forEach, .map(, .filter(, .reduce(
# If a loop is found, flag: "function called inside loop - verify iteration scope"
```

**Loop iteration review questions:**
1. Should function run for ALL iterations? → OK if yes
2. Should function run for FIRST/LAST only? → Check for index guard
3. Should function run for SOME iterations? → Check for condition filter

**Red flags:**
- Function called unconditionally in loop when AC says "only once"
- No break/return after call when AC implies single execution
- Missing mode/flag guard when AC specifies conditions

#### Step 4: Mode Sensitivity

If the function accepts configuration or mode options:
- Is the correct mode passed at the call site?
- Are all mode-specific paths exercised appropriately?

**Output Format:**

```markdown
### Call-Site Review

**New exported functions detected:** N

| Function | Call Sites | Loop? | Conditions | AC Match |
|----------|-----------|-------|------------|----------|
| `newFunction()` | `file.ts:123` | No | `if (success)` | ✅ Matches AC-2 |
| `anotherFunc()` | `run.ts:456` | Yes | None | ⚠️ Missing guard (AC-3 says "final only") |
| `thirdFunc()` | Not called | - | - | ⚠️ Unused export |

**Findings:**
- [List any mismatches between call-site conditions and AC constraints]

**Recommendations:**
- [Specific fixes needed at call sites]
```

**Verdict Impact:**

| Finding | Verdict Impact |
|---------|----------------|
| All call sites match AC | No impact |
| Call site missing AC-required guard | `AC_NOT_MET` |
| Function not called anywhere | `AC_MET_BUT_NOT_A_PLUS` (dead export) |
| Call site in loop, AC unclear about iteration | `NEEDS_VERIFICATION` |

See [call-site-review.md](references/call-site-review.md) for detailed methodology and examples.

### 2h. CLI Registration Verification (When Option Interfaces Modified)

**When to apply:** `RunOptions` or similar CLI option interfaces are modified in the diff.

**Purpose:** Detect new option interface fields that have runtime usage (via `mergedOptions.X`) but lack corresponding CLI registration (via `.option()` in `bin/cli.ts`). This class of bug is invisible to TypeScript, build, and unit tests—caught only by manual review or this check.

**Origin:** Issue #305 — `force?: boolean` was added to `RunOptions`, checked at runtime with `mergedOptions.force`, and referenced in user-facing warnings ("use --force to re-run"), but `--force` was never registered in `bin/cli.ts`. The bug passed QA and was caught only by manual cross-reference.

**Detection:**

```bash
# Check if option interfaces or CLI file were modified
option_files=$(git diff main...HEAD --name-only | grep -E "batch-executor\.ts|run\.ts|cli\.ts" || true)
option_modified=$(echo "$option_files" | grep -v "^$" | wc -l | xargs || echo "0")

if [[ $option_modified -gt 0 ]]; then
  echo "Option interface or CLI file modified - running CLI registration verification"
fi
```

**Key File Map:**

| Interface | Location | CLI Registration |
|-----------|----------|------------------|
| `RunOptions` | `src/lib/workflow/batch-executor.ts` | `run` command in `bin/cli.ts` |

**Verification Logic:**

1. **Extract new interface fields from diff:**
   ```bash
   # Get new fields added to RunOptions (or similar interfaces)
   new_fields=$(git diff main...HEAD -- src/lib/workflow/batch-executor.ts | \
     grep -E '^\+\s+\w+\??: ' | \
     sed 's/.*+ *//' | \
     sed 's/\?.*//' | \
     sed 's/:.*//' | \
     tr -d ' ' || true)
   ```

2. **Check for runtime usage (mergedOptions.X):**
   ```bash
   # For each new field, check if it's used at runtime
   for field in $new_fields; do
     runtime_usage=$(git diff main...HEAD | grep -E "mergedOptions\.$field|options\.$field" || true)
     if [[ -n "$runtime_usage" ]]; then
       echo "Field '$field' has runtime usage - verify CLI registration"
     fi
   done
   ```

3. **Verify CLI registration exists:**
   ```bash
   # Extract registered CLI options from bin/cli.ts
   # Matches patterns like: --force, --dry-run, --timeout
   registered=$(grep -oE '"\-\-[a-z-]+"' bin/cli.ts | tr -d '"' | sed 's/^--//' || true)

   # Check if field has corresponding registration
   # Note: CLI flags use kebab-case, interface fields use camelCase
   # Example: fieldName → --field-name
   ```

4. **Internal-only field exclusion (AC-5):**

   Fields without runtime `mergedOptions.X` usage are internal-only and don't need CLI registration:
   - `autoDetectPhases` — set programmatically, not user-facing
   - `worktreeIsolation` — environment-controlled
   - Fields only used in type signatures without runtime access

   **Detection:** If `grep "mergedOptions.$field"` returns no matches, the field is internal-only.

**Output Format:**

```markdown
### CLI Registration Verification

**Option files modified:** Yes/No

| Interface Field | Runtime Usage | CLI Registered | Status |
|----------------|--------------|----------------|--------|
| `force` | `mergedOptions.force` (line 2447) | `--force` in bin/cli.ts | ✅ OK |
| `newField` | `mergedOptions.newField` (line 500) | NOT REGISTERED | ❌ FAIL |
| `internalOnly` | None (internal) | N/A | ⏭️ SKIP |

**Verification Status:** Passed / Failed / N/A
```

**Verdict Gating (AC-4):**

| Verification Status | Maximum Verdict |
|---------------------|-----------------|
| Passed | READY_FOR_MERGE |
| N/A (no option changes) | READY_FOR_MERGE |
| Failed | AC_NOT_MET |

**CRITICAL:** If CLI registration verification = **Failed**, verdict CANNOT be `READY_FOR_MERGE`. Missing CLI registrations mean users cannot access the feature via command line.

**If verification fails:**
1. Flag the specific fields missing CLI registration
2. Set verdict to `AC_NOT_MET`
3. Include remediation steps:
   ```markdown
   **Remediation:**
   1. Add to `bin/cli.ts` under the appropriate command:
      ```typescript
      .option("--field-name", "Description of what the flag does")
      ```
   2. Verify with `npx sequant <command> --help`
   ```

---

### 3. QA vs AC

For each AC item, mark as:
- `MET`
- `PARTIALLY_MET`
- `NOT_MET`

Provide a sentence or two explaining why.

#### AC Literal Verification (REQUIRED)

**Before marking any AC as MET**, verify the implementation matches the AC text literally, not just in spirit:

1. **Extract specific technical claims** from the AC text (commands, flags, function names, config keys, UI elements)
2. **Search the implementation** for each claim using Grep or Read — do not assume presence
3. **If the AC mentions a flag** (e.g., `--file <relevant-files>`), verify that flag appears in the code
4. **If the AC says "works end-to-end"**, trace the full call chain from entry point to execution

**Example:** If AC says *"shells out to `aider --yes --no-auto-commits --message '<prompt>' --file <relevant-files>`"*:
- Verify `--yes` is in args array ✅
- Verify `--no-auto-commits` is in args array ✅
- Verify `--message` is in args array ✅
- Verify `--file` is in args array — **if missing, AC is NOT MET** ❌

Do NOT mark MET based on "the general intent is satisfied." The AC text is the contract — verify it literally.

### 4. Failure Path & Edge Case Testing (REQUIRED)

Before any READY_FOR_MERGE verdict, complete the adversarial thinking checklist:

1. **"What would break this?"** - Identify and test at least 2 failure scenarios
2. **"What assumptions am I making?"** - List and validate key assumptions
3. **"What's the unhappy path?"** - Test invalid inputs, failed dependencies
4. **"Did I test the feature's PRIMARY PURPOSE?"** - If it handles errors, trigger an error

See [testing-requirements.md](references/testing-requirements.md) for edge case checklists.

### 5. Risk Assessment (REQUIRED unless SMALL_DIFF)

**Before issuing your verdict**, state the implementation risks in 2-3 sentences.

**Include this section in your output:**

```markdown
### Risk Assessment

- **Likely failure mode:** [How would this break in production? Be specific.]
- **Not tested:** [What gaps exist in test coverage for these changes?]
```

**If either field reveals significant concerns**, factor them into your verdict. A serious failure mode with no test coverage should downgrade to `AC_MET_BUT_NOT_A_PLUS` or `AC_NOT_MET`.

#### Skill Change Review (Conditional)

**When to apply:** `.claude/skills/**/*.md` files were modified.

**Detect skill changes:**
```bash
skills_changed=$(git diff main...HEAD --name-only | grep -E "^\.claude/skills/.*\.md$" | wc -l | xargs || true)
```

**If skills_changed > 0, add these verification prompts:**

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
scripts_changed=$(git diff main...HEAD --name-only | grep -E "^scripts/" | wc -l | xargs || true)
cli_changed=$(git diff main...HEAD --name-only | grep -E "(cli|commands?)" | wc -l | xargs || true)
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
skills_changed=$(git diff main...HEAD --name-only | grep -E "^\.claude/skills/.*\.md$" || true)
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
valid_fields=$(gh pr checks --help 2>/dev/null | grep -A 50 "JSON FIELDS" | grep -E "^\s+\w+" | awk '{print $1}' || true)

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

### 6b. Smoke Test (CONDITIONAL)

**When to apply:** Feature changes workflow behavior (skills, CLI commands, scripts).

**Detection:**
```bash
# Detect workflow-affecting changes
skills_changed=$(git diff main...HEAD --name-only | grep -E "^\.claude/skills/" | wc -l | xargs || true)
scripts_changed=$(git diff main...HEAD --name-only | grep -E "^scripts/" | wc -l | xargs || true)
cli_changed=$(git diff main...HEAD --name-only | grep -E "^(src/cli|bin)/" | wc -l | xargs || true)

if [[ $((skills_changed + scripts_changed + cli_changed)) -gt 0 ]]; then
  echo "Smoke test recommended for workflow changes"
fi
```

**Smoke Test Checklist:**
1. **Happy path:** Execute the primary use case
2. **Edge cases:** Test graceful handling (missing deps, invalid input)
3. **Error detection:** Verify errors are caught and reported

**Output Format:**

| Test | Command | Result | Notes |
|------|---------|--------|-------|
| Happy path | `[command]` | ✅/❌ | [observation] |
| Edge case | `[command]` | ✅/❌ | [observation] |
| Error handling | `[command]` | ✅/❌ | [observation] |

**Smoke Test Status:**
- **Complete:** All applicable tests passed
- **Partial:** Some tests skipped or failed (document why)
- **Not Required:** No workflow-affecting changes

**Verdict Impact:**

| Smoke Test Status | Verdict Impact |
|-------------------|----------------|
| Complete | No impact (positive signal) |
| Partial | → `AC_MET_BUT_NOT_A_PLUS` (document gaps) |
| Not Required | No impact |

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
   - smoke_test_status = status from Section 6b (Complete/Partial/Not Required)

3. Browser testing enforcement check:
   - Check if any .tsx files were changed: git diff main...HEAD --name-only | grep '\.tsx$' || true
   - Check if /test phase ran: look for test phase marker in issue comments
   - Check if issue has 'no-browser-test' label
   - IF .tsx files changed AND /test did NOT run AND no 'no-browser-test' label:
       → Set browser_test_missing = true

3a. Manual test AC enforcement check:
   - Scan spec plan comment for ACs with **Verification:** Manual Test (or freeform: try X confirm Y, verify by, test that)
   - For each detected manual-test AC:
     - IF runtime test was executed → AC status from test result (MET/NOT_MET)
     - IF approved override documented → AC status = MET
     - ELSE → AC status = PENDING (this increments pending_count)
   - NOTE: No new verdict branch needed — PENDING manual-test ACs flow through
     the existing pending_count > 0 → NEEDS_VERIFICATION path in step 4

4. Determine verdict (in order):
   - IF not_met_count > 0 OR partial_count > 0:
       → AC_NOT_MET (block merge)
   - ELSE IF skill_verification == "Failed":
       → AC_MET_BUT_NOT_A_PLUS (skill commands have issues - cannot be READY_FOR_MERGE)
   - ELSE IF execution_evidence == "Incomplete":
       → AC_MET_BUT_NOT_A_PLUS (scripts not verified - cannot be READY_FOR_MERGE)
   - ELSE IF quality_plan_status == "Not Addressed" AND quality_plan_exists:
       → AC_MET_BUT_NOT_A_PLUS (quality dimensions not addressed - flag for review)
   - ELSE IF browser_test_missing (from step 3):
       → AC_MET_BUT_NOT_A_PLUS (browser testing recommended for .tsx changes)
         Note: "Browser testing recommended: .tsx files modified without /test phase.
               Add 'ui' label to enable, or 'no-browser-test' to opt out."
   - ELSE IF pending_count > 0:
       → NEEDS_VERIFICATION (wait for verification)
   - ELSE IF quality_plan_status == "Partial":
       → AC_MET_BUT_NOT_A_PLUS (some quality dimensions incomplete - can merge with notes)
   - ELSE IF smoke_test_status == "Partial":
       → AC_MET_BUT_NOT_A_PLUS (smoke tests incomplete - document gaps before merge)
   - ELSE IF improvement_suggestions.length > 0:
       → AC_MET_BUT_NOT_A_PLUS (can merge with notes)
   - ELSE:
       → READY_FOR_MERGE (A+ implementation)
```

**Browser Testing Enforcement:**

Before finalizing the verdict, check for missing browser test coverage:

```bash
# Check if .tsx files were changed
tsx_changed=$(git diff main...HEAD --name-only | grep '\.tsx$' || true)

# Check if /test phase ran (look for test phase marker in issue comments)
test_ran=$(gh issue view <issue-number> --json comments --jq '[.comments[].body]' | \
  grep -o '{"phase":"test"' || true)

# Check for no-browser-test label
no_browser_test=$(gh issue view <issue-number> --json labels --jq '.labels[].name' | \
  grep 'no-browser-test' || true)

if [[ -n "$tsx_changed" && -z "$test_ran" && -z "$no_browser_test" ]]; then
  echo "⚠️ Browser testing recommended: .tsx files modified without /test phase"
  # Force verdict to AC_MET_BUT_NOT_A_PLUS (cannot be READY_FOR_MERGE)
fi
```

| Condition | Verdict Effect |
|-----------|---------------|
| `.tsx` changed + `/test` ran | Normal verdict |
| `.tsx` changed + `no-browser-test` label | Normal verdict (explicit opt-out) |
| `.tsx` changed + no `/test` + no opt-out | Force `AC_MET_BUT_NOT_A_PLUS` |
| No `.tsx` changed | Normal verdict |

**Manual Test AC Enforcement:**

Before finalizing the verdict, check if any ACs require manual (runtime) verification that was specified in the `/spec` plan:

```bash
# 1. Extract spec plan comment from issue
spec_comment=$(gh issue view <issue-number> --json comments --jq \
  '[.comments[].body | select(contains("\"phase\":\"spec\""))] | last' || true)

# 2. Detect ACs with manual-test verification methods
# Matches: "**Verification:** Manual Test", "**Verify:** ...", "try X, confirm Y", "verify by", "test that"
manual_test_acs=$(echo "$spec_comment" | \
  grep -iE '(\*\*Verification:\*\*\s*Manual Test|\*\*Verify:\*\*\s*|try .*, confirm|verify by|test that|verify:?\s*manual)' || true)

# 3. Extract AC IDs associated with manual-test lines
# Scan backwards from each match to find the nearest ### AC-N header
manual_ac_ids=$(echo "$spec_comment" | \
  awk 'BEGIN{IGNORECASE=1} /^(#+ AC-[0-9]+|\*\*AC-[0-9]+)/{ac=$0} /Manual Test|\*\*Verify:\*\*|try .*, confirm|verify by|test that/{print ac}' | \
  grep -oE 'AC-[0-9]+' | sort -u || true)
```

**If manual-test ACs are detected**, include this section in QA output:

```markdown
### Manual Test ACs Detected

| AC | Verification Method | Runtime Test Status |
|----|--------------------|--------------------|
| AC-N | Manual Test | ✅ Executed / ⚠️ PENDING / 🔄 Overridden |
```

**Enforcement Rules:**

For each detected manual-test AC, QA must do ONE of:

1. **Execute the test** using available tools (chrome-devtools MCP, dev server, CLI invocation) and record pass/fail evidence → mark AC `MET` or `NOT_MET` based on result
2. **Mark AC `PENDING`** with note: `⚠️ Manual verification required — runtime test not executed` → flows through `pending_count > 0 → NEEDS_VERIFICATION` verdict path
3. **Override** with approved justification (see Manual Test Override below) → mark AC `MET`

**Key Rule:** A manual-test AC CANNOT be marked `MET` from static code review alone. QA must either execute the runtime test, provide an approved override, or mark `PENDING`.

| Scenario | AC Status | Verdict Impact |
|----------|-----------|----------------|
| Runtime test executed and passed | `MET` | Normal verdict |
| Runtime test executed and failed | `NOT_MET` | → `AC_NOT_MET` |
| Runtime test not executed, no override | `PENDING` | → `NEEDS_VERIFICATION` |
| Override with approved justification | `MET` | Normal verdict |
| Override with unapproved justification | `PENDING` | → `NEEDS_VERIFICATION` |

### Manual Test Override

In some cases, runtime verification can be safely skipped for manual-test ACs when the verification target has no runtime surface or is covered by equivalent automated tests. **Overrides require explicit justification and risk assessment.**

**Override Format (REQUIRED when skipping manual-test execution):**

```markdown
### Manual Test Override

**AC:** AC-N
**Requirement:** Runtime verification for manual-test AC
**Override:** Yes
**Justification:** [One of the approved categories below]
**Risk Assessment:** [None/Low]
```

**Approved Override Categories:**

| Category | Example | Risk |
|----------|---------|------|
| No runtime surface | Pure type definitions, config schema validation | None |
| Equivalent unit test coverage | Automated test covers the exact same code path the manual test would exercise | Low |
| Tested in sibling issue | Cross-reference to another issue where the same runtime behavior was verified | Low |

**NOT Approved for Override (always require runtime test):**

| Category | Example | Why |
|----------|---------|-----|
| Logic changes with UI surface | Modified form validation, new user flows | Runtime behavior may diverge from code review expectations |
| New user-facing features | Added pages, new interactions | Must verify actual user experience |
| Integration points | API calls, database writes, auth flows | Runtime dependencies may behave differently |
| Error handling with user feedback | Toast messages, error pages, redirects | Presentation layer needs runtime check |

**Risk Assessment Definitions:**

| Level | Meaning | Criteria |
|-------|---------|----------|
| **None** | Zero runtime impact | Change has no executable runtime surface (types, config) |
| **Low** | Negligible runtime impact | Automated tests cover the same path; manual test would be redundant |
| **Medium** | Possible runtime impact | **Should NOT be overridden** — run the manual test |

**Override Decision Flow:**

1. Check if change matches an approved category → If no, runtime test is required
2. Assess risk level → If Medium or higher, runtime test is required
3. Document override using the format above in the QA output
4. Include override in the GitHub issue comment for audit trail

**CRITICAL:** When in doubt, execute the manual test. Overrides are for clear-cut cases only. The motivation for this gate (issue #529) was a real bug that passed QA because `minRows: 1` appeared correct in code review but did not work at runtime.

**CRITICAL:** `PARTIALLY_MET` is NOT sufficient for merge. It MUST be treated as `NOT_MET` for verdict purposes.

**CRITICAL:** If skill command verification = "Failed", verdict CANNOT be `READY_FOR_MERGE`. This prevents shipping skills with broken commands (like issue #178's `conclusion` field).

See [quality-gates.md](references/quality-gates.md) for detailed verdict criteria.

---

## Automated Quality Checks (Reference)

**Note:** These commands are what the sub-agents execute internally. You do NOT run these directly — the sub-agents spawned above handle this. This section is reference documentation only.

```bash
# Type safety
type_issues=$(git diff main...HEAD | grep -E ":\s*any[,)]|as any" | wc -l | xargs || true)

# Deleted tests
deleted_tests=$(git diff main...HEAD --diff-filter=D --name-only | grep -E "\\.test\\.|\\spec\\." | wc -l | xargs || true)

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

### 10a. CHANGELOG Quality Gate (REQUIRED)

**Purpose:** Verify user-facing changes have corresponding CHANGELOG entries before `READY_FOR_MERGE`.

**Detection:**

```bash
# Check if CHANGELOG.md exists
if [ ! -f "CHANGELOG.md" ]; then
  echo "No CHANGELOG.md found - skip CHANGELOG check"
  exit 0
fi

# Check if [Unreleased] section has entries
unreleased_entries=$(sed -n '/^## \[Unreleased\]/,/^## \[/p' CHANGELOG.md | grep -E '^\s*-' | wc -l | xargs || true)

# Determine if change is user-facing (new features, bug fixes, etc.)
# Look at commit messages or file changes
user_facing=$(git log main..HEAD --oneline | grep -iE '^[a-f0-9]+ (feat|fix|perf|refactor|docs):' | wc -l | xargs || true)
```

**Verification Logic:**

| Condition | CHANGELOG Entry Required? | Action |
|-----------|---------------------------|--------|
| User-facing changes detected + CHANGELOG exists | ✅ Yes | Check for `[Unreleased]` entry |
| User-facing changes + no entry | ⚠️ Block | Flag as missing CHANGELOG |
| Non-user-facing changes (test, ci, chore) | ❌ No | Skip check |
| No CHANGELOG.md in repo | ❌ No | Skip check |

**If CHANGELOG entry is missing:**

1. Do NOT give `READY_FOR_MERGE` verdict
2. Set verdict to `AC_MET_BUT_NOT_A_PLUS` with note:
   ```markdown
   **CHANGELOG:** Missing entry for user-facing changes. Add entry to `## [Unreleased]` section before merging.
   ```
3. Include this in the draft review comment

**CHANGELOG Entry Validation:**

When an entry exists, verify it follows the format:
- Starts with action verb (Add, Fix, Update, Remove, Improve)
- Includes issue number `(#123)`
- Is under the correct section (Added, Fixed, Changed, etc.)

**Example validation:**

```markdown
### CHANGELOG Verification

| Check | Status |
|-------|--------|
| CHANGELOG.md exists | ✅ Found |
| User-facing changes | ✅ Yes (feat: commit detected) |
| [Unreleased] entry | ✅ Present |
| Entry format | ✅ Valid (includes issue number) |

**Result:** CHANGELOG requirements met
```

**If CHANGELOG is not required:**

```markdown
### CHANGELOG Verification

**Result:** N/A (non-user-facing changes only)
```

---

### 11. Script/CLI Execution Verification

**REQUIRED for CLI/script features:** When `scripts/` files are modified, execution verification is required before `READY_FOR_MERGE`.

**Detection:**
```bash
scripts_changed=$(git diff main...HEAD --name-only | grep -E "^(scripts/|templates/scripts/)" | wc -l | xargs || true)
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

## Output Verification

**Before responding, verify your output includes ALL of these:**

### Simple Fix Mode (`SMALL_DIFF=true`)

When the size gate determined `SMALL_DIFF=true`, use the **simplified output template**. The following sections are **omitted** (not marked N/A — completely absent):

- Quality Plan Verification
- Call-Site Review
- Product Review
- Smoke Test
- CLI Registration Verification
- Skill Command Verification
- Script Verification Override
- Skill Change Review

**Required sections for simple fix mode:**

- [ ] **Size Gate** - Size gate decision table with threshold, diff size, and decision
- [ ] **AC Coverage** - Each AC item marked as MET, PARTIALLY_MET, NOT_MET, PENDING, or N/A
- [ ] **Quality Metrics** - Type issues, deleted tests, files changed, additions/deletions (from inline checks)
- [ ] **Code Review Findings** - Strengths, issues, suggestions
- [ ] **Test Coverage Analysis** - Changed files with/without tests, critical paths flagged
- [ ] **Anti-Pattern Detection** - Code patterns check (lightweight)
- [ ] **Risk Assessment** - Likely failure mode and coverage gaps stated
- [ ] **Verdict** - One of: READY_FOR_MERGE, AC_MET_BUT_NOT_A_PLUS, NEEDS_VERIFICATION, AC_NOT_MET
- [ ] **Documentation Check** - README/docs updated if feature adds new functionality
- [ ] **Next Steps** - Clear, actionable recommendations

### Standard QA (Implementation Exists, `SMALL_DIFF=false`)

- [ ] **Risk Assessment** - Likely failure mode and coverage gaps stated in output
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
- [ ] **Call-Site Review** - Included if new exported functions detected (or marked N/A)
- [ ] **Execution Evidence** - Included if scripts/CLI modified (or marked N/A)
- [ ] **Script Verification Override** - Included if scripts/CLI modified AND /verify was skipped (with justification and risk assessment)
- [ ] **Skill Command Verification** - Included if `.claude/skills/**/*.md` modified (or marked N/A)
- [ ] **Skill Change Review** - Skill-specific verification prompts included if skills changed
- [ ] **Smoke Test** - Included if workflow-affecting changes (skills, scripts, CLI), or marked "Not Required"
- [ ] **Manual Test AC Enforcement** - Included if spec plan has Manual Test ACs (or marked N/A if no manual-test ACs detected)
- [ ] **CHANGELOG Verification** - User-facing changes have `[Unreleased]` entry (or marked N/A)
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

### Simple Fix Template (`SMALL_DIFF=true`)

When the size gate triggers simple fix mode, use this shorter template:

```markdown
## QA Review for Issue #<N> (Simple Fix)

### Size Gate

| Check | Value |
|-------|-------|
| Diff size | N lines (threshold: T) |
| package.json changed | No |
| Security-sensitive paths | No |
| Decision | **Inline checks** |

### AC Coverage

| AC | Description | Status | Notes |
|----|-------------|--------|-------|
| AC-1 | [description] | MET/NOT_MET | [explanation] |

**Coverage:** X/Y AC items fully met

---

### Quality Metrics

| Metric | Value | Status |
|--------|-------|--------|
| Type issues (`any`) | X | OK/WARN |
| Deleted tests | X | OK/WARN |
| Files changed | X | OK/WARN |
| Lines added | +X | - |
| Lines deleted | -X | - |
| Security patterns | X | OK/WARN |

---

### Code Review

**Strengths:**
- [Positive findings]

**Issues:**
- [Problems found]

**Suggestions:**
- [Improvements recommended]

---

### Test Coverage Analysis

| Changed File | Tier | Has Tests? | Test File |
|--------------|------|------------|-----------|
| `[file]` | Critical/Standard/Optional | Yes/No | `[test file or -]` |

**Coverage:** X/Y changed source files have corresponding tests

---

### Anti-Pattern Detection

| File:Line | Category | Pattern | Suggestion |
|-----------|----------|---------|------------|
| [location] | [category] | [pattern] | [fix] |

---

### Risk Assessment

- **Likely failure mode:** [How would this break in production?]
- **Not tested:** [What gaps exist in test coverage?]

---

### Verdict: [READY_FOR_MERGE | AC_MET_BUT_NOT_A_PLUS | NEEDS_VERIFICATION | AC_NOT_MET]

[Explanation of verdict]

### Documentation

- [ ] N/A - Simple fix, no documentation needed
- [ ] README/docs updated

### Next Steps

1. [Action item]
```

---

### Standard Template (`SMALL_DIFF=false`)

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

### Call-Site Review

[Include if new exported functions detected, otherwise: "N/A - No new exported functions"]

**New exported functions detected:** N

| Function | Call Sites | Loop? | Conditions | AC Match |
|----------|-----------|-------|------------|----------|
| `[function]` | `[file:line]` | Yes/No | `[condition]` | ✅ Matches AC-N / ⚠️ [issue] |

**Findings:**
- [List any mismatches between call-site conditions and AC constraints]

**Recommendations:**
- [Specific fixes needed at call sites]

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

### CLI Registration Verification

[Include if option interfaces or CLI file modified, otherwise: "N/A - No option interface changes"]

**Option files modified:** Yes/No

| Interface Field | Runtime Usage | CLI Registered | Status |
|----------------|--------------|----------------|--------|
| `[field]` | `[usage location]` | `--[flag]` in bin/cli.ts / NOT REGISTERED | ✅ OK / ❌ FAIL / ⏭️ SKIP |

**Verification Status:** Passed / Failed / N/A

**Remediation (if failed):**
- Add `.option("--field-name", "description")` to bin/cli.ts

---

### Skill Change Review

[Include if skill files changed, otherwise omit]

- [ ] **Command verified:** Did you execute at least one referenced command?
- [ ] **Fields verified:** For JSON commands, do field names match actual output?
- [ ] **Patterns complete:** What variations might users write that aren't covered?
- [ ] **Dependencies explicit:** What CLIs/tools does this skill assume are installed?

---

### Smoke Test

[Include if workflow-affecting changes (skills, scripts, CLI), otherwise: "Not Required - No workflow-affecting changes"]

| Test | Command | Result | Notes |
|------|---------|--------|-------|
| Happy path | `[command]` | ✅/❌ | [observation] |
| Edge case | `[command]` | ✅/❌ | [observation] |
| Error handling | `[command]` | ✅/❌ | [observation] |

**Smoke Test Status:** Complete / Partial (document gaps) / Not Required

---

### Manual Test ACs

[Include if spec plan has ACs with **Verification:** Manual Test, otherwise: "N/A - No manual-test ACs detected"]

| AC | Verification Method | Runtime Test Status | Evidence |
|----|--------------------|--------------------|----------|
| AC-N | Manual Test | ✅ Executed / ⚠️ PENDING / 🔄 Overridden | [result or override justification] |

**Manual Test Enforcement:** X/Y manual-test ACs verified at runtime

[If any overrides applied, include Manual Test Override block per Section 7]

---

### Risk Assessment

- **Likely failure mode:** [How would this break in production? Be specific.]
- **Not tested:** [What gaps exist in test coverage for these changes?]

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
