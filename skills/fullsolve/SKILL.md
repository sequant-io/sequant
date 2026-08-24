---
name: fullsolve
description: "Complete issue resolution with integrated quality loops - spec → exec → test → qa with auto-fix iterations"
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Read
  - Edit
  - Write
  - Glob
  - Grep
  - Bash
  - TodoWrite
  - Skill  # For invoking child skills (/spec, /exec, /test, /qa)
  # Optional MCP tools (enhanced functionality if available)
  - mcp__chrome-devtools__*  # Browser testing - falls back to manual checklist if unavailable
  - mcp__sequential-thinking__*  # Complex reasoning - falls back to standard analysis if unavailable
  - mcp__context7__*  # Library documentation - falls back to web search if unavailable
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(gh issue edit:*)
  - Bash(gh pr create:*)
  - Bash(gh pr list:*)
  - Bash(npm test:*)
  - Bash(npm run build:*)
  - Bash(git diff:*)
  - Bash(git status:*)
  - Bash(git log:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git push:*)
  - Bash(git worktree:*)
  - Bash(./scripts/dev/*:*)
  - Bash(./scripts/cleanup-worktree.sh:*)
  - Bash(./scripts/new-feature.sh:*)
  - Bash(./scripts/list-worktrees.sh:*)
---

<!-- sequant:local-override -->
> **Local overrides (read this first).** Before following any instruction below, check whether `.claude/.local/skills/fullsolve/overrides.md` exists. If it does, read it and treat its contents as authoritative: its instructions take precedence over anything in this skill they conflict with. This is the supported way to tailor `/fullsolve` without forking it — `overrides.md` lives under `.claude/.local/`, which `sequant update` and `sync` never overwrite.

# Full Solve Command

You are the "Full Solve Agent" for the current repository.

## Purpose

When invoked as `/fullsolve <issue-number>`, execute the complete issue resolution workflow with integrated quality loops. This command orchestrates all phases and automatically iterates until quality gates pass.

## CRITICAL: Auto-Progression Between Phases

**DO NOT wait for user confirmation between phases.** This is an autonomous workflow — through PR creation.

After each phase completes successfully, **immediately proceed** to the next phase:
1. `/spec` completes → **immediately** invoke `/exec`
2. `/exec` completes → **immediately** invoke `/test` (if UI) or `/qa`
3. `/test` completes → **immediately** invoke `/qa`
4. `/qa` completes → **immediately** create the PR and post the final summary

<!-- BEGIN: merge-gate (#958) -->
**The workflow's terminal state is PR created + final summary posted — not merged.** Merging (§5.3), post-merge verification (§5.4), and the auto-merge-path lock release (§5.5) run **only** when `--auto-merge` is passed, `run.autoMerge` is `true` in `.sequant/settings.json`, or the user has explicitly instructed a merge in this conversation (invoking `/fullsolve` alone does not count). Without one of those, `/fullsolve` stops after the final summary — the PR is left open for human review. See "Merge Gate" below for how this is resolved, and §5.3 for the gate itself.

**The user invoked `/fullsolve` expecting end-to-end automation up to a mergeable PR.** Only stop for:
- Unrecoverable errors (after retry attempts exhausted)
- Final summary after PR creation — **this is the workflow's terminal state**, not a pause
- Explicit user interruption
<!-- END: merge-gate (#958) -->

```
WRONG: "Spec complete. Ready for exec phase." [waits]
RIGHT: "Spec complete. Proceeding to exec..." [invokes /exec immediately]
WRONG (no --auto-merge): [creates PR, immediately runs `gh pr merge`]
RIGHT (no --auto-merge): [creates PR, posts final summary, stops]
```

## Workflow Overview

```
                    /fullsolve <issue>
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────┐                                                │
│  │  SPEC   │ Plan implementation, extract AC (main repo)    │
│  └────┬────┘                                                │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────┐                                                │
│  │WORKTREE │ Create it here; export the resolved path       │
│  └────┬────┘                                                │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────┐                                                │
│  │  EXEC   │ Verify the path, then implement inside it      │
│  └────┬────┘                                                │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────┐                                                │
│  │  TEST   │ Browser-based testing (if UI feature)          │
│  └────┬────┘                                                │
│       │                                                     │
│       ▼ (failures?)                                         │
│  ┌─────────┐     ┌─────────┐                                │
│  │  FIX    │────▶│ RE-TEST │──▶ (loop max 3x)               │
│  └─────────┘     └─────────┘                                │
│       │                                                     │
│       ▼ (all pass)                                          │
│  ┌─────────┐                                                │
│  │   QA    │ Code review, AC validation                     │
│  └────┬────┘                                                │
│       │                                                     │
│       ▼ (not ready?)                                        │
│  ┌─────────┐     ┌─────────┐                                │
│  │  FIX    │────▶│  RE-QA  │──▶ (loop max 2x)               │
│  └─────────┘     └─────────┘                                │
│       │                                                     │
│       ▼ (READY_FOR_MERGE)                                   │
│  ┌─────────┐                                                │
│  │   PR    │ Create PR if not exists                        │
│  └─────────┘                                                │
└─────────────────────────────────────────────────────────────┘
```

## Invocation

```bash
/fullsolve 218                    # Standard full solve
/fullsolve 218 --skip-test        # Skip testing phase (backend issues)
/fullsolve 218 --max-iterations 5 # Override max fix iterations
/fullsolve 218 --parallel         # Force parallel agent execution (faster, higher token usage)
/fullsolve 218 --sequential       # Force sequential agent execution (slower, lower token usage)
/fullsolve 218 --auto-merge       # Merge the PR automatically once QA passes (default: off)
```

## Agent Execution Mode

When spawning sub-agents for quality checks, determine the execution mode:

1. **Check for CLI flag override:**
   - `--parallel` → Run sub-agents in parallel
   - `--sequential` → Run sub-agents one at a time

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

**Pass execution mode to child skills:** When invoking `/qa` or other skills that spawn agents, pass the `--parallel` or `--sequential` flag to maintain consistency.

## Merge Gate (#958)

Determine whether Phase 5.3–5.5's merge workflow runs at all. This mirrors the Agent Execution Mode resolution above — flag first, then settings, defaulting closed.

1. **Check for CLI flag override:**
   - `--auto-merge` → run the merge workflow (§5.3) after the final summary
   - No flag → do not merge automatically; fall through to step 2

2. **If no flag, read project settings:**
   Use the Read tool to check project settings:
   ```
   Read(file_path=".sequant/settings.json")
   # Parse JSON and extract run.autoMerge (default: false)
   ```

3. **Default:** off. `/fullsolve` ends at PR creation + final summary — this
   preserves the human merge gate recorded in #817–#819 (`sequant ready`
   drives an issue to merge-*readiness*; a human runs `sequant merge` to
   actually merge it).

**Explicit user instruction overrides the gate independent of the flag or setting.** If the user has told you in this conversation to merge once ready (not merely "run `/fullsolve`"), treat that as satisfying the gate for this run.

**If the gate does not fire:** skip §5.3 and §5.4 entirely. Release the concurrency locks immediately after §5.2 (see §5.5) and stop — do not attempt `gh pr merge` under any circumstance without one of the three conditions above.

## Orchestration Context

This skill acts as an **orchestrator** and sets environment variables for child skills to optimize their behavior:

| Environment Variable | Description | Example Value |
|---------------------|-------------|---------------|
| `SEQUANT_ORCHESTRATOR` | Identifies the orchestrator | `sequant-run` |
| `SEQUANT_PHASE` | Current phase being executed | `spec`, `exec`, `test`, `qa`, `loop` |
| `SEQUANT_ISSUE` | Issue number being processed | `218` |
| `SEQUANT_WORKTREE` | Path to the feature worktree | `/path/to/worktrees/feature/218-...` |

**Benefits of orchestration context:**

1. **Faster execution** - Child skills skip redundant pre-flight checks
2. **Cleaner GitHub comments** - Only orchestrator posts progress updates
3. **Better coordination** - Skills can trust worktree and issue context
4. **Reduced API calls** - Issue fetch happens once, not per-phase

**Child skills detect orchestration via `SEQUANT_ORCHESTRATOR` and adjust behavior:**
- `/spec`: Runs normally (first phase, no prior context)
- `/exec`: Skips worktree creation, but still verifies the provided path before using it
- `/test`: Skips issue fetch, trusts orchestrator context
- `/qa`: Skips pre-flight sync, defers GitHub updates
- `/loop`: Uses provided worktree, defers GitHub updates

## Phase Detection (Smart Resumption)

**Before starting any phase**, detect the current workflow state from GitHub issue comments to enable smart resumption:

```bash
# Get all phase markers from issue comments
comments_json=$(gh issue view <issue-number> --json comments --jq '[.comments[].body]')
markers=$(echo "$comments_json" | grep -o '{[^}]*}' | grep '"phase"' || true)

if [[ -n "$markers" ]]; then
  echo "Phase markers detected:"
  echo "$markers" | jq -r '"  \(.phase): \(.status)"'

  # Determine resume point
  latest_completed=$(echo "$markers" | jq -r 'select(.status == "completed") | .phase' | tail -1)
  latest_failed=$(echo "$markers" | jq -r 'select(.status == "failed") | .phase' | tail -1)

  echo "Latest completed: ${latest_completed:-none}"
  echo "Latest failed: ${latest_failed:-none}"
fi
```

**Resume Logic:**

| Detected State | Action |
|---------------|--------|
| No markers | Start from Phase 1 (spec) — fresh start |
| `spec:completed` | Skip to Phase 2 (exec) |
| `exec:completed` | Skip to Phase 3 (test) or Phase 4 (qa) |
| `exec:failed` | Resume at Phase 2 (exec) — retry |
| `test:completed` | Skip to Phase 4 (qa) |
| `qa:completed` | Skip to Phase 5 (PR) |
| `qa:failed` | Resume at Phase 4 (qa) — retry with /loop |
| All completed | Skip to PR creation (if no PR exists) |

**Backward Compatibility:**
- Issues without markers → treat as fresh start (no phase detection)
- If detection fails (API error) → fall through to standard Phase 0 checks

**Phase Marker Emission:**

When posting progress comments after each phase, append the appropriate marker:
```markdown
<!-- SEQUANT_PHASE: {"phase":"<phase>","status":"<completed|failed>","timestamp":"<ISO-8601>"} -->
```

## Phase 0: Pre-flight Checks

**CRITICAL after context restoration:** Before starting any work, verify the current git state to avoid duplicate work.

### 0.1 Git State Verification

```bash
# Check current branch — warn if on main/master
CURRENT_BRANCH=$(git branch --show-current)
echo "Current branch: $CURRENT_BRANCH"
if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
  echo "⚠️  WARNING: On $CURRENT_BRANCH — will need feature branch before committing"
fi

# Check recent commits
git log --oneline -5 --stat

# Check for any existing work on this issue
git branch -a | grep -i "<issue-number>" || true
gh pr list --search "<issue-number>"
```

**Why this matters:** After context restoration from a summarized conversation, the git state may have changed (PRs merged, rebases, etc.). Always verify what's already been done before creating files or making changes.

### 0.2 Existing Work Detection

Before creating any files, check if they already exist:
- Look for test files: `ls -la src/**/*.test.ts`
- Check recent commits for relevant changes
- Verify PR status if one was mentioned in context

**If work already exists:** Skip to the appropriate phase (e.g., if implementation is done, go to Phase 3 or 4).

### 0.3 Acquire Concurrency Locks (#625, #901)

**Before invoking `/spec`**, claim the per-issue concurrency lock.

**Phase 0 always runs — including on a resumed run.** Smart Resumption (above) chooses only *which phase comes next after Phase 0*; it never skips Phase 0 itself. A resumed session that skipped the acquire below would hold neither lock while doing exactly the work the locks exist to protect, and would then run the release contract against a lock it never took.

**Declare the issue for the guard.** `pre-tool.sh` decides whether *you* are the checkout's holder by `sessionId` when both sides have one, then by `SEQUANT_ISSUE`, and finally by the session→issue binding it records for itself.

```bash
export SEQUANT_ISSUE=<issue-number>
```

**You do not need that export to be recognized as the holder (#906).** `PreToolUse` runs *outside and before* your command's shell, so nothing a skill bash block exports is visible to it — not even an export prepended to the same block as the guarded command. Instead the hook watches for `locks checkout acquire --issue=<N>` and records the binding itself, keyed on the session id, which is the one identity that survives the shell boundary killing the acquiring PID. The `export` above still helps a parent process that launched you with it; it is not what unblocks you.

Consequences worth knowing:

- After the acquire in this phase, branch-mutating git **in the main checkout is allowed for you** and still refused for every other session.
- `git -C "$SEQUANT_WORKTREE" …` is exempt regardless, and is what every phase after 1.5 should be using anyway.
- Path-restore (`git checkout -- <path>`) is exempt whether or not the path is quoted.
- If the hook never observed your acquire (it was disabled, or the lock was taken by another tool), you are treated as a non-holder — release and re-acquire so the binding is recorded.

**What this lock covers — and what it does not (#901).** The per-issue lock is keyed on the *issue number*. It prevents a second session from working on **the same issue** — another `/fullsolve <same-issue>`, an `npx sequant run <same-issue>`, or the same issue in a different window — and producing zero-diff exec failures.

It is **not** a general concurrency guarantee. Two sessions working *different* issues take different lock files and never contend, even when they share one working tree. `git checkout`, `switch`, `reset`, `rebase`, `merge` and `cherry-pick` are global to a checkout, so the per-issue lock says nothing about them. That contention is covered by the separate **checkout lock** below.

```bash
# Acquire lock for this issue. --skip-pid-check is required: the shell that
# runs this command exits immediately, so the lock's PID is dead by the time
# the next check runs. Stale recovery falls back to age-only (2h).
if ! npx sequant locks acquire <issue-number> \
    --command="/fullsolve <issue-number>" \
    --skip-pid-check; then
  echo "❌ Another session is working on #<issue-number>. Run 'npx sequant locks list' for details."
  echo "   If you're sure the holder is dead, run: npx sequant locks clear <issue-number>"
  exit 1
fi
```

**Checkout lock (#901).** Claim the working tree as well, so a session on a *different* issue cannot run branch-mutating git in the same checkout. `pre-tool.sh` enforces this: a foreign session's `git checkout`/`switch`/`reset`/`rebase`/`merge`/`cherry-pick` in the main checkout is refused with a message naming the holder and its issue.

```bash
# Claim the shared working tree. Skip when you will work entirely inside a
# feature worktree (`git -C <worktree> ...` is never blocked).
npx sequant locks checkout acquire \
    --issue=<issue-number> \
    --command="/fullsolve <issue-number>" \
    --skip-pid-check || true
```

Release it alongside the per-issue lock: `npx sequant locks checkout release --issue=<issue-number> || true`. **`--issue` is mandatory** (#906) — it is what proves you are the holder. `--skip-pid-check` means the acquiring shell's PID is already dead, so PID identity is unavailable and a release without `--issue` is refused, not merely ineffective. Stale recovery is therefore age-based only for this lock: the 6h `SEQUANT_SKILL_LOCK_TTL_MS` and the 24h `SEQUANT_MAX_LOCK_AGE_MS` ceiling, *not* same-host dead-PID recovery, which `--skip-pid-check` disables by definition. An abandoned holder still cannot wedge the checkout permanently.

**Release contract (#958):** the happy path releases both locks **right after §5.2's final summary** — that is the workflow's default terminal state, since §5.3–5.4 do not run without the Merge Gate firing. Only when the Merge Gate *does* fire does release move to §5.5, after merge (§5.3) and post-merge verification (§5.4) complete. On ANY branch that **exits the workflow without reaching Phase 5** — spec failure, exec iterations exhausted, unrecoverable error — you MUST run `npx sequant locks release <issue-number> || true` and `npx sequant locks checkout release --issue=<issue-number> || true` **before** printing the halt message. The explicit release calls below cover the known branches; if you add a new early-exit path, add a release call there too.

**Do NOT release at a branch that continues to Phase 5.** QA-loop exhaustion and the stagnation halt both fall through to PR creation, which still runs git in this tree — releasing there would leave Phase 5 unprotected.

**Backstop:** If a release is somehow missed, stale recovery clears the lock after 6h on the same host (`SEQUANT_SKILL_LOCK_TTL_MS` overrides). The user can also force-clear via `npx sequant locks clear <issue-number>`.

**Orchestrator/MCP mode:** When `SEQUANT_ORCHESTRATOR` is set, `locks acquire`, `locks release` and every `locks checkout` action are no-ops (exit 0, no file touched), and the `pre-tool.sh` checkout guard stands down. Safe to call unconditionally.

## Phase 1: Planning (SPEC)

**Invoke the `/spec` skill** to plan implementation and extract acceptance criteria.

### 1.1 Invoke Spec Skill

Use the `Skill` tool to invoke `/spec`:

```
Skill(skill: "spec", args: "<issue-number>")
```

The `/spec` skill will:
- Fetch issue context from GitHub
- Extract acceptance criteria (AC-1, AC-2, etc.)
- Create implementation plan (3-7 steps)
- Post plan comment to the issue

`/spec` plans in the main repository and does **not** create a worktree — that
is this skill's job, in Phase 1.5 below.

### 1.2 Capture Spec Output

After `/spec` completes, extract and store:
- **AC Checklist:** List of acceptance criteria for tracking
- **Recommended Phases:** Whether `/test` is needed (UI features)

```markdown
## Spec Output Captured

**Issue:** #<N>
**AC Count:** <N> items
**Needs Testing:** Yes/No (based on labels)
```

### 1.3 Handle Spec Failures

If `/spec` fails:
- Check if issue exists and is readable
- Verify GitHub CLI authentication
- **Release the lock acquired in Phase 0.3** (so the user can retry without hitting the orphan window)
- Report failure and exit workflow

```bash
# Release before halting — see Phase 0.3 release contract.
npx sequant locks release <issue-number> || true
npx sequant locks checkout release --issue=<issue-number> || true
```

```markdown
## Spec Failed

**Error:** [error message]
**Action Required:** [what the user needs to do]

Workflow halted. Fix the issue and re-run `/fullsolve <issue-number>`.
```

**State after Phase 1:**
- AC checklist defined
- Implementation plan created (and posted to GitHub)
- Still in the main repository — no worktree exists yet

**→ IMMEDIATELY proceed to Phase 1.5 (do not wait for user input)**

## Phase 1.5: Create the Feature Worktree

<!-- BEGIN: worktree-creation (#899) -->

**This skill creates the worktree. Nothing upstream does it.** Every phase from
here on runs inside it, and `SEQUANT_WORKTREE` is what tells the child skills
where "here" is — so it must hold a **resolved absolute path**, never a glob.

```bash
# 1. Create it. Idempotent: exits 0 with "Worktree already exists" on re-entry
#    (resumed session, retried phase), so this is safe to run unconditionally.
./scripts/new-feature.sh <issue-number>

# 2. Resolve the real path. `sequant worktree resolve` reads
#    `git worktree list` in THIS repository and selects on the branch, so it
#    can never return a sibling project's worktree — `../worktrees/` is one
#    flat namespace shared by every repo under the same parent.
SEQUANT_WORKTREE="$(npx sequant worktree resolve <issue-number>)" || {
  echo "❌ Could not resolve a worktree for #<issue-number> after creating one."
  npx sequant locks release <issue-number> || true
  npx sequant locks checkout release --issue=<issue-number> || true
  exit 1
}
export SEQUANT_WORKTREE
echo "Worktree: $SEQUANT_WORKTREE"
```

**Never substitute a glob for this step.** `../worktrees/feature/<issue>-*/`
is not a path: unquoted it may not expand at all, and where it does expand it
matches on the directory slug, which is shared across repositories and can
drift from its own branch after a rename.

**If `new-feature.sh` fails** (dirty tree, branch conflict), release the lock
and halt — do not proceed into Phase 2 in the main checkout:

```bash
npx sequant locks release <issue-number> || true
npx sequant locks checkout release --issue=<issue-number> || true
```

<!-- END: worktree-creation (#899) -->

**State after Phase 1.5:**
- Feature worktree created and verified to belong to this repository
- `SEQUANT_WORKTREE` exported as a resolved absolute path

**→ IMMEDIATELY proceed to Phase 2 (do not wait for user input)**

## Phase 2: Implementation (EXEC)

**Invoke the `/exec` skill** to implement all acceptance criteria.

### 2.1 Invoke Exec Skill

Use the `Skill` tool to invoke `/exec`:

```
Skill(skill: "exec", args: "<issue-number>")
```

The `/exec` skill will:
- Navigate to the feature worktree
- Implement each AC item
- Run tests and build after changes
- Verify quality gates pass

### 2.2 Pass Orchestration Context

Set environment variables before invoking `/exec` so it can optimize its behavior:

```bash
export SEQUANT_ORCHESTRATOR=fullsolve
export SEQUANT_PHASE=exec
export SEQUANT_ISSUE=<issue-number>
# Absolute path resolved in Phase 1.5 — never a glob.
export SEQUANT_WORKTREE="$SEQUANT_WORKTREE"
```

When `/exec` detects `SEQUANT_ORCHESTRATOR`, it:
- Skips worktree creation (already done in Phase 1.5)
- Verifies the provided path with `npx sequant worktree verify` before using it
- Defers GitHub comment updates to orchestrator

### 2.3 Handle Exec Failures

If `/exec` fails (tests or build):

**Attempt fix (max 3 iterations):**
```
exec_iteration = 0
while exec_iteration < MAX_EXEC_ITERATIONS:
    result = Skill(skill: "exec", args: "<issue-number>")

    if result.success:
        break

    # Parse and log failure
    log_failure(result.error)
    exec_iteration += 1
```

**If all iterations exhausted:**
```bash
# Release before halting — see Phase 0.3 release contract.
npx sequant locks release <issue-number> || true
npx sequant locks checkout release --issue=<issue-number> || true
```

```markdown
## Exec Failed

**Iterations:** 3/3 exhausted
**Last Error:** [error message]

Workflow halted. Manual intervention required.
```

### 2.4 Capture Exec Output

After successful `/exec`:
- Verify tests passed
- Verify build succeeded
- Record files changed

```markdown
## Exec Complete

**Tests:** ✅ All passing
**Build:** ✅ Succeeded
**Files Changed:** <N>
```

**State after Phase 2:**
- All AC items implemented
- Tests passing (verified AFTER final changes)
- Build succeeding

**→ IMMEDIATELY proceed to Phase 3 or 4 (do not wait for user input)**
- If UI labels (`ui`, `frontend`, `admin`) present AND no `no-browser-test` label → invoke `/test`
- If `no-browser-test` label present → skip to `/qa` (explicit opt-out)
- Otherwise → skip to `/qa`

## Phase 3: Testing (TEST)

**Skip if:**
- Issue doesn't have `admin`, `ui`, or `frontend` labels (determined from `/spec` output), OR
- Issue has `no-browser-test` label (explicit opt-out, overrides UI labels)

### Browser Testing Label Reference

| Label | Effect |
|-------|--------|
| `ui`, `frontend`, `admin` | Always includes `/test` phase |
| `no-browser-test` | Always skips `/test` phase (explicit opt-out) |
| Neither | Auto-detection in `/spec` may suggest adding `ui` label |

**Invoke the `/test` skill** for browser-based UI testing.

### 3.1 Invoke Test Skill

Use the `Skill` tool to invoke `/test`:

```
Skill(skill: "test", args: "<issue-number>")
```

The `/test` skill will:
- Start development server
- Navigate to feature in browser (Chrome DevTools MCP)
- Execute each test case
- Record PASS/FAIL/BLOCKED results

### 3.2 Pass Orchestration Context

```bash
export SEQUANT_ORCHESTRATOR=fullsolve
export SEQUANT_PHASE=test
export SEQUANT_ISSUE=<issue-number>
# Absolute path resolved in Phase 1.5 — never a glob.
export SEQUANT_WORKTREE="$SEQUANT_WORKTREE"
```

When `/test` detects `SEQUANT_ORCHESTRATOR`, it:
- Skips issue fetch (trusts orchestrator context)
- Uses provided AC checklist
- Defers GitHub updates to orchestrator

### 3.3 Test Loop (Max 3 iterations)

If tests fail, invoke `/loop` to fix and re-test:

```
test_iteration = 0
while test_iteration < MAX_TEST_ITERATIONS:
    result = Skill(skill: "test", args: "<issue-number>")

    if result.all_tests_pass:
        break

    # Use /loop to fix failures
    Skill(skill: "sequant:loop", args: "<issue-number> --phase test")
    test_iteration += 1
```

### 3.4 Handle Test Exhaustion

If max iterations reached:

```markdown
## Test Loop Exhausted

**Iterations:** 3/3
**Remaining Failures:** [list]

Proceeding to QA phase. Failures will be documented.
```

**State after Phase 3:**
- All tests passing (or max iterations reached)
- Bugs documented and fixed

**→ IMMEDIATELY proceed to Phase 4 (do not wait for user input)**

## Phase 4: Quality Assurance (QA)

**Invoke the `/qa` skill** for code review and AC validation.

### 4.1 Invoke QA Skill

Use the `Skill` tool to invoke `/qa`:

```
Skill(skill: "qa", args: "<issue-number>")
```

The `/qa` skill will:
- Run automated quality checks (type safety, deleted tests, scope)
- Review AC coverage (MET/PARTIALLY_MET/NOT_MET/PENDING)
- Generate review comment draft
- Return verdict: READY_FOR_MERGE, AC_MET_BUT_NOT_A_PLUS, NEEDS_VERIFICATION,
  or AC_NOT_MET

### 4.2 Pass Orchestration Context

```bash
export SEQUANT_ORCHESTRATOR=fullsolve
export SEQUANT_PHASE=qa
export SEQUANT_ISSUE=<issue-number>
# Absolute path resolved in Phase 1.5 — never a glob.
export SEQUANT_WORKTREE="$SEQUANT_WORKTREE"
```

When `/qa` detects `SEQUANT_ORCHESTRATOR`, it:
- Skips pre-flight sync
- Defers GitHub comment posting to orchestrator
- Returns structured verdict for orchestrator to process

### 4.3 QA Loop (Max 2 iterations)

If verdict is not `READY_FOR_MERGE`, invoke `/loop` to fix and re-run QA.

**Stagnation gate (issue #581):** Before each `/qa` re-invocation after iteration 1, run the stagnation detector. If it reports `stagnant: true` with reason `SAME_SHA_NO_PROGRESS`, the prior `/loop` made no commit and produced no diff — re-running `/qa` would yield the same verdict. Halt the loop and surface a hard blocker instead of wasting another cycle.

```bash
# Run before each /qa call after iteration 0 (skip on first call):
npx tsx scripts/qa-stagnation.ts detect <issue-number>
# Output (JSON): {"stagnant": true|false, "reason"?: "SAME_SHA_NO_PROGRESS", "message": "...", ...}
# When stagnant === true: record telemetry, then halt — do NOT call /qa again.
npx tsx scripts/qa-stagnation.ts record <issue-number> <iteration> SAME_SHA_NO_PROGRESS --verdict=AC_NOT_MET
```

```
qa_iteration = 0
while qa_iteration < MAX_QA_ITERATIONS:
    if qa_iteration > 0:
        # Stagnation gate — same-SHA same-verdict cycles are wasted.
        decision = `npx tsx scripts/qa-stagnation.ts detect <issue-number>`
        if decision.stagnant == true:
            `npx tsx scripts/qa-stagnation.ts record <issue-number> {qa_iteration} SAME_SHA_NO_PROGRESS --verdict=AC_NOT_MET`
            # Halt — no progress since last QA. Skip to 4.4 with stagnation note.
            break

    result = Skill(skill: "qa", args: "<issue-number>")

    if result.verdict == "READY_FOR_MERGE":
        break

    if result.verdict == "AC_MET_BUT_NOT_A_PLUS":
        # Good enough, proceed with notes
        break

    if result.verdict == "NEEDS_VERIFICATION":
        # ACs are met but pending external verification
        # Proceed to PR - verification can happen post-PR
        break

    # Use /loop to fix issues (AC_NOT_MET)
    Skill(skill: "sequant:loop", args: "<issue-number> --phase qa")
    qa_iteration += 1
```

### 4.4 Handle QA Exhaustion

If max iterations reached with `AC_NOT_MET`:

```markdown
## QA Loop Exhausted

**Iterations:** 2/2
**Verdict:** AC_NOT_MET
**Remaining Issues:** [list]

Creating PR with notes for human review.
```

**State after Phase 4:**
- AC fully met (or documented as partial)
- Code quality validated
- Ready for merge (or flagged for human review)

**→ IMMEDIATELY proceed to Phase 5 after self-evaluation (do not wait for user input)**

### 4.5 Risk Assessment

Risk assessment is performed during the QA phase — see QA output above. If QA was skipped or incomplete, state risks here using the same format:

```markdown
### Risk Assessment

- **Likely failure mode:** [How would this break in production?]
- **Not tested:** [What gaps exist in test coverage?]
```

---

## Phase 5: Pull Request (PR)

### 5.0 Branch Verification Gate

**CRITICAL: Verify you are on the correct feature branch before committing or creating a PR.**

```bash
CURRENT_BRANCH=$(git branch --show-current)
echo "Current branch: $CURRENT_BRANCH"

# HARD GATE: Must be on a feature branch, not main/master
if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
  # Release before halting — see Phase 0.3 release contract. This gate fires
  # later than any other exit path, so a leak here wedges the tree for the
  # longest (#906).
  npx sequant locks release <issue-number> || true
  npx sequant locks checkout release --issue=<issue-number> || true
  echo "❌ ERROR: On $CURRENT_BRANCH — commits must NOT land on main."
  echo "   Fix: git checkout feature/<issue-number>-* or create a new branch."
  exit 1
fi

# Soft check: branch should match the issue number
if ! echo "$CURRENT_BRANCH" | grep -q "<issue-number>"; then
  echo "⚠️  WARNING: Branch '$CURRENT_BRANCH' does not contain issue number <issue-number>."
  echo "   Verify this is the correct branch before continuing."
fi
```

**Why this matters:** Sub-agents and shell context resets can silently switch the working directory back to main. Without this check, commits land on main instead of the feature branch, requiring messy recovery (cherry-picks, force pushes, re-created PRs).

### 5.1 Create PR (if not exists)

```bash
# Check for existing PR
gh pr list --head feature/<issue-number>-*

# Create if none exists
gh pr create --title "feat(#<N>): <title>" --body "..."
```

### 5.2 Final Summary

Post completion comment to issue with:
- AC coverage summary
- Key changes made
- PR link
- Quality metrics

### 5.3 Merge Workflow (Opt-In Only) (#958)

**STOP — do not run this section unless the Merge Gate above fired.** That
means one of: `--auto-merge` was passed on this `/fullsolve` invocation,
`run.autoMerge` is `true` in `.sequant/settings.json`, or the user
explicitly instructed a merge in this conversation. If none of those hold,
**do not run `gh pr merge`.** Stop after §5.2's final summary instead — the
PR stays open, awaiting human review. That is the default terminal state,
not a fallback.

**IMPORTANT (once the gate above has fired):** Merge the PR first, then clean up the worktree.

```bash
# 1. Merge PR (without --delete-branch; cleanup happens after success)
gh pr merge <N> --squash

# 2. Clean up worktree (removes local worktree + branch)
# Quote the glob: the script resolves the pattern itself, and zsh aborts on an
# unmatched unquoted glob before the script ever runs.
./scripts/cleanup-worktree.sh 'feature/<issue-number>-*'

# 3. Issue auto-closes if commit message contains "Fixes #N"
```

**Why this order matters:** The cleanup script checks if the PR is merged before proceeding. Merging without `--delete-branch` avoids worktree lock conflicts. The post-tool hook and cleanup script handle branch removal after merge succeeds. If the merge fails, the worktree is preserved so work isn't lost.

### 5.4 Post-Merge Verification

**Skip this section if §5.3 did not run.** Nothing to verify post-merge when there was no merge.

**Recommended:** After merge, verify the build and CLI still work:

```bash
# Pull latest main
git pull origin main

# Rebuild and verify
npm run build

# Smoke test - verify CLI runs without errors
npx sequant doctor
```

If any command fails, fix immediately on main before continuing. This catches issues like ESM compatibility bugs that unit tests may miss.

### 5.5 Release Concurrency Locks (#625, #901)

**Default path (Merge Gate did not fire):** release runs immediately after
§5.2's final summary — that is the happy path, since §5.3–5.4 never execute.
Run the release calls below there, not here.

**Auto-merge path (Merge Gate fired):** release runs here, after §5.3
(merge) and §5.4 (post-merge verification) complete.

Either way, release both locks so other sessions can claim them:

```bash
npx sequant locks release <issue-number> || true
npx sequant locks checkout release --issue=<issue-number> || true
```

`|| true` is intentional — release is idempotent; the lock may already have been cleared (orchestrator mode, age-based recovery, or manual `locks clear`). The exit code is informational only.

**But read it if you are debugging (#906).** A non-zero exit from `locks checkout release` no longer means only "nothing was held". It now also means **"held, but not by you"** — a refusal, printed with the holder's issue and the `clear --force` recovery command. If you see that after your own run, the usual cause is a missing or wrong `--issue`, not a stale lock.

## Iteration Tracking

Track iterations to prevent infinite loops:

```markdown
## Full Solve Progress

| Phase | Iterations | Status |
|-------|------------|--------|
| Spec  | 1/1        | Complete |
| Exec  | 1/1        | Complete |
| Test  | 2/3        | Complete (fixed 2 bugs) |
| QA    | 1/2        | Complete |

**Total Time:** [tracked]
**Final Verdict:** READY_FOR_MERGE
```

## Exit Conditions

**Success:**
- All AC met
- All tests passing
- QA verdict: `READY_FOR_MERGE`
- PR created

**Partial Success:**
- Most AC met
- Minor issues documented
- QA verdict: `AC_MET_BUT_NOT_A_PLUS`
- PR created with notes

**Pending Verification:**

- All AC met or pending
- External verification required (CI, manual test)
- QA verdict: `NEEDS_VERIFICATION`
- PR created, verification can happen post-PR

**Failure (manual intervention needed):**
- Max iterations reached on test or QA loop
- Blockers discovered
- QA verdict: `AC_NOT_MET` after all iterations

## GitHub Updates

Throughout the process, post progress comments:

**After Spec:**
```markdown
## Plan Complete

### AC Checklist
- [ ] AC-1: ...
- [ ] AC-2: ...

### Implementation Plan
1. Step 1
2. Step 2

Ready to implement.
```

**After Test Loop:**
```markdown
## Testing Complete

**Result:** 10/10 tests passed
**Iterations:** 2 (fixed 2 bugs)

### Bugs Fixed
1. [Bug] - Fixed in [file:line]
```

**Final Comment:**
```markdown
## /fullsolve Complete

**Issue:** #<N>
**Status:** READY_FOR_MERGE

### Summary
- AC: 5/5 met
- Tests: 10/10 passed
- QA: All checks passed

### Iterations
- Test loop: 2
- QA loop: 1

**PR:** #<PR_NUMBER>

---
Ready for human review and merge.
```

## Error Recovery

**Concurrency lock cleanup (#625, #901, applies to every abort path below):**

```bash
npx sequant locks release <issue-number> || true
npx sequant locks checkout release --issue=<issue-number> || true
```

Run this BEFORE printing the halt/exit message in any branch below that **exits the workflow**. The release call is idempotent (no-op when nothing is held, no-op in orchestrator mode), so calling it unconditionally on a genuine exit path is safe.

Do **not** run it on the two branches below that continue to Phase 5 — "test loop exhausted" and "QA loop exhausted" both go on to create a PR, and releasing there hands the tree away while this session is still using it.

**If spec fails:**
- Check issue exists and is readable
- Verify GitHub CLI authentication
- Release lock (see top of section)
- Exit with clear error

**If exec fails (build/test):**
- Check error logs
- Attempt targeted fix
- If persistent: release lock, document, and exit

**If test loop exhausted:**
- Document remaining failures
- Post status to issue
- Continue to QA (may catch issues there)

**If QA loop exhausted:**
- Document remaining issues
- Create PR anyway with notes
- Flag for human review

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| MAX_TEST_ITERATIONS | 3 | Max fix loops for test phase |
| MAX_QA_ITERATIONS | 2 | Max fix loops for QA phase |
| SKIP_TEST | false | Skip testing phase |
| AUTO_PR | true | Create PR automatically |
| AUTO_MERGE | false | Merge the PR automatically once QA passes (#958) |

## Smart Tests Integration

**Recommended:** Enable smart tests for automatic test running during implementation:

```bash
# Enable before running fullsolve
export CLAUDE_HOOKS_SMART_TESTS=true
```

When enabled, smart tests will:
- Auto-run related tests after each file edit during Phase 2 (EXEC)
- Catch regressions immediately instead of waiting for explicit `npm test`
- Log results to `claude-tests.log` for debugging (`/logs/`, else `/.sequant/logs/`)

**Benefits:**
- Faster feedback loop during implementation
- Catches test failures as they happen
- Reduces QA iteration count

**Trade-off:** Adds ~5-10s per file edit for test execution.

**View test results:**
```bash
npx tsx scripts/dev/analyze-hook-logs.ts --tests
```

## Usage Examples

**Standard full solve:**
```
/fullsolve 218
```

**Backend issue (no UI testing):**
```
/fullsolve 218 --skip-test
```

**With more iteration tolerance:**
```
/fullsolve 218 --max-iterations 5
```

**End-to-end including merge:**
```
/fullsolve 218 --auto-merge
```

## Batch Processing

For multiple issues, run `/fullsolve` on each sequentially:

```bash
# Process multiple issues one at a time
/fullsolve 218
/fullsolve 219
/fullsolve 220
```

Each issue gets its own worktree, PR, and quality validation.

### Post-Batch: Merge Verification

After processing a batch, run `sequant merge` to catch cross-issue integration gaps before merging:

```bash
/fullsolve 218
/fullsolve 219
/fullsolve 220
sequant merge --check         # Verify no cross-issue conflicts
/merger 218 219 220           # Merge all issues
```

`sequant merge --check` detects merge conflicts, template mirroring gaps, and file overlaps at zero AI cost. See `docs/reference/merge-command.md`.

---

## State Tracking

**IMPORTANT:** `/fullsolve` is an orchestrator and manages state for child skills.

### Orchestrator Responsibilities

As an orchestrator, `/fullsolve` must:

1. **Set orchestration context** for child skills:
   ```bash
   export SEQUANT_ORCHESTRATOR=fullsolve
   export SEQUANT_PHASE=<current-phase>
   export SEQUANT_ISSUE=<issue-number>
   # Resolved in Phase 1.5 via `sequant worktree resolve` — absolute, never a glob.
   export SEQUANT_WORKTREE="$SEQUANT_WORKTREE"
   ```

2. **State tracking** is handled automatically by the orchestrator runtime when `SEQUANT_ORCHESTRATOR` is set. Child skills defer state management to the orchestrator to avoid duplicate updates.

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Risk Assessment (from QA)** - Likely failure mode and coverage gaps stated
- [ ] **Progress Table** - Phase, iterations, and status for each phase
- [ ] **AC Coverage** - Each AC marked MET/PARTIALLY_MET/NOT_MET
- [ ] **Quality Metrics** - Tests passed, build status, type issues
- [ ] **Iteration Summary** - Test loop and QA loop iteration counts
- [ ] **Final Verdict** - READY_FOR_MERGE, AC_MET_BUT_NOT_A_PLUS, NEEDS_VERIFICATION,
  or AC_NOT_MET
- [ ] **PR Link** - Pull request URL (if created)
- [ ] **Final GitHub Comment** - Summary posted to issue

**DO NOT respond until all items are verified.**
