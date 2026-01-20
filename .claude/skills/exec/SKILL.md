---
name: exec
description: "Phase 2 - Implementation loop for a single GitHub issue until Acceptance Criteria are satisfied (or as close as practical)."
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  # File operations (required for implementation)
  - Read
  - Glob
  - Grep
  - Edit
  - Write
  # Build and test
  - Bash(npm test:*)
  - Bash(npm run build:*)
  - Bash(npm install:*)
  - Bash(npx tsc:*)
  # Git operations
  - Bash(git status:*)
  - Bash(git diff:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git log:*)
  - Bash(git worktree:*)
  # Worktree management
  - Bash(./scripts/dev/new-feature.sh:*)
  - Bash(./scripts/dev/cleanup-worktree.sh:*)
  # GitHub CLI
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(gh issue edit:*)
  - Bash(gh pr create:*)
  - Bash(gh pr view:*)
  # Optional MCP tools (enhanced functionality if available)
  - mcp__context7__*  # Library documentation lookup - falls back to web search if unavailable
  - mcp__sequential-thinking__*  # Complex reasoning - falls back to standard analysis if unavailable
  # Task management
  - Task
  - TodoWrite
---

# Implementation Command

You are the Phase 2 "Implementation Agent" for the current repository.

## Purpose

When invoked as `/exec`, your job is to:

1. Take an existing, agreed plan and AC (often created by `/spec`).
2. Create a feature worktree for the issue.
3. Implement the changes in small, safe steps.
4. Run checks via `npm test` and, when appropriate, `npm run build`.
5. Iterate until the AC appear satisfied or clear blockers are reached.
6. Draft a progress update for the GitHub issue.

## Behavior

Invocation:

- `/exec 123`:
  - Treat `123` as the GitHub issue number.
  - Assume a plan may already exist in the issue or from `/spec`.
- `/exec <freeform description>`:
  - Treat the text as a lightweight description + AC if no issue context is available.

## Orchestration Context

When running as part of an orchestrated workflow (e.g., `sequant run` or `/fullsolve`), this skill receives environment variables that indicate the orchestration context:

| Environment Variable | Description | Example Value |
|---------------------|-------------|---------------|
| `SEQUANT_ORCHESTRATOR` | The orchestrator invoking this skill | `sequant-run` |
| `SEQUANT_PHASE` | Current phase in the workflow | `exec` |
| `SEQUANT_ISSUE` | Issue number being processed | `123` |
| `SEQUANT_WORKTREE` | Path to the feature worktree | `/path/to/worktrees/feature/...` |
| `SEQUANT_BASE_BRANCH` | Base branch for worktree (if custom) | `feature/dashboard` |

**Behavior when orchestrated (SEQUANT_ORCHESTRATOR is set):**

1. **Skip pre-flight git checks** - The orchestrator has already verified git state
2. **Skip worktree creation** - Orchestrator creates worktrees before invoking skills
3. **Use provided worktree path** - Work in `SEQUANT_WORKTREE` instead of creating a new one
4. **Reduce GitHub comment frequency** - Defer progress updates to the orchestrator
5. **Trust issue context** - The orchestrator has already fetched and validated issue data

**Behavior when standalone (SEQUANT_ORCHESTRATOR is NOT set):**

- Perform all pre-flight checks
- Create worktree if needed
- Post progress updates to GitHub
- Fetch fresh issue context

### 0. Pre-flight Check (After Context Restoration)

**Skip this section if `SEQUANT_ORCHESTRATOR` is set** - the orchestrator has already performed these checks.

**CRITICAL:** If continuing from a restored/summarized conversation (standalone mode), verify git state first:

```bash
# Check current state - are we in a worktree or main repo?
pwd
git log --oneline -3 --stat

# Check for existing PRs or branches for this issue
gh pr list --search "<issue-number>"
git branch -a | grep -i "<issue-number>"
```

**Why this matters:** After context restoration, PRs may have merged, branches may have changed, or work may already be complete. Always verify before creating duplicate work.

**If PR already merged:** The issue may be complete - verify and close if so.

### 1. Check Implementation Readiness

**FIRST STEP:** Review the issue readiness and proceed with implementation.

**Read the latest GitHub comment** (especially from `/spec`) and look for:
```markdown
## Implementation Readiness

**Status:** [READY / NOT READY]
```

**Implementation Policy:**
- Always proceed with implementation when invoked via `/exec`
- Log any warnings or concerns about readiness
- Add notes to progress update if implementing despite blockers

**Readiness Notes to Include in Progress Update:**
- If P2/P3/P4 priority: Note that this is a non-critical issue being implemented
- If technical blockers exist: Note the blockers and explain workarounds/stubs used
- If dependencies are open: Note which issues block full integration

**Only stop implementation if:**
- Issue is labeled `planning`, `research`, or `rfc` (not for implementation)
- Issue is already closed
- No acceptance criteria exist and cannot be inferred

### 2. Re-establish Context (with Parallel Optimization)

**Performance Optimization:** When creating a new worktree, gather context in parallel with worktree creation to reduce setup time by ~5-10 seconds.

#### Parallel Context Gathering Pattern

When worktree creation is needed (standalone mode, no existing worktree):

```
1. Start worktree creation in background    → runs ~30s (npm install)
2. While waiting, gather context in parallel:
   - Fetch issue details                    ~2s
   - Read all issue comments                ~2s
   - Check for existing patterns/files      ~2s
3. Wait for worktree completion
4. Begin implementation with full context ready
```

**Implementation:**

1. **Start worktree creation as background task:**
   ```bash
   # From main repo, start worktree creation in background
   ./scripts/dev/new-feature.sh <issue-number> &
   WORKTREE_PID=$!
   echo "Worktree creation started (PID: $WORKTREE_PID)"
   ```

2. **Gather context while waiting:**
   - **Read all GitHub issue comments** to gather complete context:
     - Comments often contain clarifications, updates, or additional AC added after the initial issue description
     - Look for discussion about implementation details, edge cases, or requirements mentioned in comments
     - Review feedback from previous implementation cycles or review comments
   - Summarize briefly:
     - The AC checklist (AC-1, AC-2, ...) from the issue and all comments
     - The current implementation plan (from issue comments or `/spec`)
   - If there is no plan:
     - Ask whether to quickly propose one (or suggest using `/spec` first).

3. **Wait for worktree completion before implementation:**
   ```bash
   # Wait for worktree creation to complete
   wait $WORKTREE_PID
   WORKTREE_EXIT=$?
   if [ $WORKTREE_EXIT -ne 0 ]; then
     echo "ERROR: Worktree creation failed with exit code $WORKTREE_EXIT"
     # Fall back to sequential creation with error visibility
   fi
   ```

**When to use parallel context gathering:**
- ✅ Creating a new worktree (standalone mode)
- ❌ Worktree already exists (skip - just navigate to it)
- ❌ Orchestrated mode (SEQUANT_WORKTREE set - worktree pre-created)

**Fallback:** If parallel execution fails or is not applicable, fall back to sequential context gathering.

### 2.1a Smoke Test (Recommended for UI Issues)

**Purpose:** Catch runtime failures that pass `npm test` and `npm run build` but crash at runtime (e.g., missing module registrations, framework version incompatibilities).

**When to run:** Issues with `admin`, `ui`, or `frontend` labels.

**Skip if:** Issue has none of these labels (backend-only, CLI, docs, etc.).

**Quick verification (< 30 seconds):**

1. Start dev server in background:
   ```bash
   npm run dev &
   DEV_PID=$!
   sleep 5  # Wait for server startup
   ```

2. Check for startup errors:
   ```bash
   # Verify server is running
   curl -s http://localhost:3000 > /dev/null && echo "✓ Server responding" || echo "✗ Server not responding"
   ```

3. Kill the dev server:
   ```bash
   kill $DEV_PID 2>/dev/null
   ```

**What to look for:**
- ✗ Server crash on startup → Check `framework-gotchas.md`
- ✗ Blank white page → React hydration error or missing component
- ✗ Module registration errors → AG Grid, chart libraries, etc.
- ✗ Console errors on load → Missing imports, env vars

**If issues found:** Fix before proceeding with new implementation. Reference `references/shared/framework-gotchas.md` for common solutions.

### Feature Worktree Workflow

**Execution Phase:** Create and work in a feature worktree.

**CRITICAL: Main Branch Safeguard (Issue #85)**

Before starting any implementation, verify you are NOT on the main/master branch:

```bash
# Check current branch
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "Current branch: $CURRENT_BRANCH"
```

**If on main/master branch:**
1. **STOP** - Do not implement directly on main
2. Create a feature worktree first: `./scripts/dev/new-feature.sh <issue-number>`
   - For custom base branch: `./scripts/dev/new-feature.sh <issue-number> --base <branch>`
3. Navigate to the worktree before making any changes

**Why this matters:** Work done directly on main can be lost during sync operations (git reset, git pull --rebase, etc.). Worktrees provide isolation and safe recovery through branches.

**If orchestrated (SEQUANT_WORKTREE is set):**
- Use the provided worktree path directly: `cd $SEQUANT_WORKTREE`
- Skip steps 1-2 below (worktree already created by orchestrator)
- Continue with step 3 (Work in the worktree)

**If standalone:**

1. **Check if worktree already exists:**
   - Check if you're already in a worktree: `git worktree list` or check if `../worktrees/` contains a directory for this issue
   - If worktree exists, navigate to it and continue work there

2. **Create worktree if needed (with parallel context gathering):**

   **Optimized flow (parallel):**
   ```bash
   # Step 1: Start worktree creation in background
   # For default (main) base:
   ./scripts/dev/new-feature.sh <issue-number> &
   # For custom base branch (e.g., feature integration branch):
   ./scripts/dev/new-feature.sh <issue-number> --base feature/dashboard &
   WORKTREE_PID=$!

   # Step 2: Gather context while worktree creates (see Section 2)
   # - Fetch issue details
   # - Read issue comments
   # - Check for existing patterns

   # Step 3: Wait for worktree completion
   wait $WORKTREE_PID
   ```

   **What new-feature.sh does:**
     - Fetch issue details from GitHub
     - Create branch: `feature/<issue-number>-<issue-title-slug>`
     - Create worktree in: `../worktrees/feature/<branch-name>/`
     - Branch from specified base (default: main)
     - Install dependencies (can use cache if `SEQUANT_NPM_CACHE=true`)
     - Copy environment files if they exist

   **After completion:**
   - Navigate to the worktree directory: `cd ../worktrees/feature/<branch-name>/`

3. **Work in the worktree:**
   - All implementation work happens in the worktree directory
   - Run `npm test` and `npm run build` from the worktree
   - Make commits in the worktree (they'll be on the feature branch)

4. **After implementation is complete:**
   - Push the branch: `git push -u origin feature/<branch-name>`
   - Create PR (manually or via script)
   - The worktree will be cleaned up after PR merge using `./scripts/dev/cleanup-worktree.sh <branch-name>`

**Important:** Always work in the worktree directory, not the main repository, once the worktree is created.

### PR Creation and Verification

After implementation is complete and all checks pass, create and verify the PR:

1. **Push the branch:**
   ```bash
   git push -u origin <branch-name>
   ```

2. **Create the PR with HEREDOC formatting:**
   ```bash
   gh pr create --title "feat(#<issue>): <title>" --body "$(cat <<'EOF'
   ## Summary
   <1-3 bullet points>

   ## Test plan
   - [ ] Manual testing steps...

   Closes #<issue>

   🤖 Generated with [Claude Code](https://claude.com/claude-code)
   EOF
   )"
   ```

3. **Immediately verify PR was created:**
   ```bash
   # Verify PR exists - this MUST succeed
   gh pr view --json number,url
   ```

4. **If verification fails, retry once:**
   ```bash
   # Wait 2 seconds and retry
   sleep 2
   gh pr view --json number,url || echo "ERROR: PR verification failed after retry"
   ```

5. **Capture PR URL for progress update:**
   - If PR exists: Record the URL from `gh pr view` output
   - If PR creation failed: Record the error and include manual creation instructions

**PR Verification Failure Handling:**

If `gh pr view` fails after retry:
1. Log the error clearly: `"PR Creation: FAILED - [error message]"`
2. Include manual creation instructions in progress update:
   ```markdown
   ### Manual PR Creation Required

   PR creation failed. Create manually:
   \`\`\`bash
   gh pr create --title "feat(#<issue>): <title>" --body "..."
   \`\`\`
   ```
3. Do NOT report the phase as fully successful - note the PR failure

**Important:** The implementation is complete regardless of PR status, but the progress update MUST accurately reflect whether the PR was created.

### Check Patterns Catalog Before Implementing

**IMPORTANT:** Before creating any new utility functions, components, or types:

1. Read `docs/patterns/README.md` for quick lookup
2. Check `docs/patterns/HELPERS.md` for existing helper functions
3. Check `docs/patterns/COMPONENTS.md` for existing React components
4. Check `docs/patterns/TYPES.md` for existing TypeScript types

**Do NOT create duplicates.** If a similar utility exists:
- Use the existing one
- If it needs modification, extend it rather than creating a new one
- Document why existing utilities don't meet requirements before creating new ones

### Check Framework Gotchas on Runtime Errors

**When encountering unexpected runtime errors or build failures:**

1. Check `references/shared/framework-gotchas.md` for known framework-specific issues
2. Common gotchas include:
   - AG Grid v35+ module registration requirements
   - React 19 concurrent mode behavior changes
   - Next.js 15 caching and async API changes
   - Tailwind v4 CSS-first configuration

If you discover a new framework-specific issue that caused debugging time, add it to the gotchas file following the template.

### MCP Tools Integration

This section covers optional MCP tools that enhance implementation quality when available.

#### MCP Availability Check (Lazy Loading)

**Performance Optimization:** Check MCP availability lazily on first use, NOT proactively at session start. This avoids wasting time checking MCPs for issues that don't need them.

**Lazy Check Pattern:**
- ❌ **Don't:** Check all MCPs at session start
- ✅ **Do:** Check MCP availability only when you're about to use it

```markdown
**MCP Check (on first use only):**
When you need to use an MCP tool:
1. Attempt the MCP call
2. If it fails with "tool not available", use the fallback strategy
3. Cache the result for the session (don't re-check)
```

**Example - Lazy Context7 Check:**
```javascript
// Only check when you actually need library docs
// NOT at session start
if (need_library_documentation) {
  // Try Context7 - fallback to WebSearch if unavailable
  try {
    mcp__context7__resolve-library-id(...)
  } catch {
    // Fallback: use WebSearch or codebase patterns
  }
}
```

**Why lazy loading:**
- Many issues don't need MCPs (simple bugs, docs, config changes)
- Proactive checks waste 2-5 seconds per MCP
- Lazy checks only run when the tool provides value

---

#### Context7 - Library Documentation Lookup

**Tool Names:**
- `mcp__context7__resolve-library-id` - Resolve package name to Context7 library ID
- `mcp__context7__query-docs` - Query documentation for a specific library

**When to Use Context7:**

| Trigger | Example | Action |
|---------|---------|--------|
| Unfamiliar npm package API | First time using `ag-grid-react` | Use Context7 |
| Library version upgrade | Migrating from v1 to v2 of a library | Use Context7 |
| Type errors from third-party lib | `Property 'X' does not exist on type 'Y'` from library | Use Context7 |
| Missing documentation in code | Library patterns not in codebase | Use Context7 |
| **Skip** - Patterns in codebase | Similar usage exists in project | Use Grep/Glob first |
| **Skip** - Standard Node/Browser APIs | `fs`, `path`, `fetch`, `Promise` | Skip Context7 |
| **Skip** - Project's own code | Internal modules, utils, components | Use Grep/Glob |

**How to Use Context7:**

```javascript
// Step 1: Resolve library name to Context7 ID
mcp__context7__resolve-library-id({
  libraryName: "ag-grid-react",
  query: "How to configure column definitions in AG Grid React"
})
// Returns: { libraryId: "/ag-grid/ag-grid", ... }

// Step 2: Query documentation with specific question
mcp__context7__query-docs({
  libraryId: "/ag-grid/ag-grid",
  query: "column definitions with custom cell renderers"
})
// Returns: Relevant documentation and code examples
```

**Decision Flow:**

```
Need to use external library API?
│
├─ YES: Check codebase for existing patterns
│       │
│       ├─ Patterns found? → Use Glob/Grep (skip Context7)
│       │
│       └─ No patterns? → Use Context7 for documentation
│
└─ NO: Skip Context7 (internal code or standard APIs)
```

**Fallback (if Context7 unavailable):**
1. Use WebSearch to find official documentation
2. Search codebase with Grep for existing usage patterns
3. Check library's GitHub README via WebFetch
4. Search for `<library-name> example` or `<library-name> typescript`

---

#### Sequential Thinking - Complex Reasoning

**Tool Name:** `mcp__sequential-thinking__sequentialthinking`

**When to Use Sequential Thinking:**

| Trigger | Example | Action |
|---------|---------|--------|
| 3+ valid architectural approaches | "Should we use Redux, Context, or Zustand?" | Use Sequential Thinking |
| Complex debugging with multiple causes | "Tests fail intermittently" | Use Sequential Thinking |
| Algorithm with edge cases | Implementing rate limiting, caching logic | Use Sequential Thinking |
| Unclear refactoring boundaries | "How to split this 500-line component?" | Use Sequential Thinking |
| Issue labeled `complex`, `refactor`, `architecture` | Check issue labels | Consider Sequential Thinking |
| Previous attempt failed | Already tried one approach, it failed | Use Sequential Thinking to analyze |
| **Skip** - Simple CRUD | Add/edit/delete with clear requirements | Skip |
| **Skip** - Following existing patterns | Similar feature exists in codebase | Skip |
| **Skip** - Clear, unambiguous requirements | "Add a button that calls X" | Skip |

**How to Use Sequential Thinking:**

```javascript
// Start a thinking chain for complex decisions
mcp__sequential-thinking__sequentialthinking({
  thought: "Analyzing authentication flow options. We need to decide between JWT, session-based auth, or OAuth. Let me consider the trade-offs: 1) JWT - stateless, works for API-first, but token revocation is complex. 2) Session-based - simple, secure, but requires sticky sessions for scale. 3) OAuth - good for third-party login, but adds complexity...",
  thoughtNumber: 1,
  totalThoughts: 5,
  nextThoughtNeeded: true
})

// Continue the chain
mcp__sequential-thinking__sequentialthinking({
  thought: "Based on the project requirements (admin dashboard, single tenant), session-based auth seems most appropriate. The trade-offs favor simplicity over scalability at this stage...",
  thoughtNumber: 2,
  totalThoughts: 5,
  nextThoughtNeeded: true
})

// Conclude with a decision
mcp__sequential-thinking__sequentialthinking({
  thought: "Final decision: Implement session-based auth using the existing cookie library. This aligns with the admin-only use case and existing patterns in the codebase.",
  thoughtNumber: 5,
  totalThoughts: 5,
  nextThoughtNeeded: false
})
```

**Decision Flow:**

```
Facing implementation decision?
│
├─ Multiple valid approaches (3+)?
│   │
│   ├─ YES → Use Sequential Thinking
│   │
│   └─ NO → Standard implementation
│
├─ Complex algorithm or edge cases?
│   │
│   ├─ YES → Use Sequential Thinking
│   │
│   └─ NO → Standard implementation
│
└─ Previous attempt failed?
    │
    ├─ YES → Use Sequential Thinking to analyze
    │
    └─ NO → Standard implementation
```

**Fallback (if Sequential Thinking unavailable):**
1. Use explicit step-by-step analysis in your response
2. Create a pros/cons table for each approach
3. Document trade-offs in issue comments before deciding
4. Break complex decisions into smaller, sequential questions

---

#### Database MCP Tools

If your project uses a database MCP (e.g., Supabase, Postgres):
- Verify table schemas before writing queries
- Check access policies before data access code
- Validate data models match TypeScript types

---

#### General MCP Guidelines

1. **Codebase First:** Always check for existing patterns with Glob/Grep before using MCPs
2. **Minimal Usage:** Only invoke MCPs when they provide clear value
3. **Graceful Degradation:** If an MCP is unavailable, use the fallback strategy
4. **Document Decisions:** When using Sequential Thinking, summarize the conclusion

### 3. Checks-first Mindset

- Before and after meaningful changes, plan to run:
  - `npm test`
- For larger changes or anything that might impact build/runtime:
  - Suggest running `npm run build` and interpret any errors.

Do NOT silently skip checks. Always state which commands you intend to run and why.

### 4. Implementation Loop

- Implement in **small, incremental diffs**.
- Prefer touching the minimal number of files required.
- Align with repository conventions described in CLAUDE.md (naming, patterns, etc.).
- After each meaningful change:
  1. Run `npm test` (and optionally `npm run build`).
  2. If checks fail:
     - Inspect the failure output.
     - Identify the root cause.
     - Apply small, targeted fixes.
     - Repeat until checks pass or a clear blocker appears.

### 4a. Parallel Execution (for multi-task issues)

When the `/spec` output includes a `## Parallel Groups` section, you can execute independent tasks in parallel using background agents to reduce execution time by 50-70%.

**Check for Parallel Groups:**
Look in the issue comments (especially from `/spec`) for:
```markdown
## Parallel Groups

### Group 1 (no dependencies)
- [ ] Task A
- [ ] Task B

### Group 2 (depends on Group 1)
- [ ] Task C
```

**If Parallel Groups exist:**

1. **Create group marker before spawning agents:**
   ```bash
   touch /tmp/claude-parallel-group-1.marker
   ```

2. **Determine model for each task:**

   Check for model annotations in the task line: `[model: haiku]` or `[model: sonnet]`

   **Model Selection Priority:**
   1. `CLAUDE_PARALLEL_MODEL` env var (if set, overrides all)
   2. `[model: X]` annotation from the task line
   3. Default to `haiku` if no annotation

3. **Spawn parallel agents with the appropriate model in a SINGLE message:**
   ```
   Task(subagent_type="general-purpose",
        model="haiku",
        run_in_background=true,
        prompt="Implement: Create types/metrics.ts with MetricEvent interface.
                Working directory: [worktree path]
                After completion, report what files were created/modified.")
   ```

4. **Wait for all agents to complete:**
   ```
   TaskOutput(task_id="...", block=true)
   ```

5. **Clean up marker and run post-group formatting:**
   ```bash
   rm /tmp/claude-parallel-group-1.marker
   npx prettier --write [files modified by agents]
   ```

6. **Proceed to next group or sequential tasks**

**If no Parallel Groups section exists:**
Fall back to sequential execution (standard implementation loop).

**Parallel Execution Rules:**
- Maximum 3 agents per group (prevents resource exhaustion)
- Create marker file BEFORE spawning agents
- Delete marker file AFTER all agents complete
- Run Prettier on all modified files after each group (agents skip auto-format)
- On any agent failure: stop remaining agents, log error, continue with sequential
- File locking prevents concurrent edits to the same file

**Error Handling with Automatic Retry:**

When an agent fails, automatic retry kicks in before marking the agent as failed:

1. **Retry Configuration:**
   - Default: 1 retry attempt
   - Configurable via: `CLAUDE_PARALLEL_RETRIES=N` (N = max retry attempts)
   - Exponential backoff: 1s, 2s, 4s between retries
   - After max retries: mark agent as failed

2. **Enhanced Retry Prompt:**
   When retrying a failed agent, add this context to the original prompt:
   ```markdown
   ## RETRY CONTEXT

   **Previous attempt failed with error:**
   [Original error message from TaskOutput]

   **CRITICAL CONSTRAINTS (re-emphasized):**
   - You MUST use the worktree path: /path/to/worktrees/feature/XXX/
   - Do NOT edit files outside the worktree
   - Complete the task in fewer tool calls
   ```

### 4b. Detecting Agent Failures

**Important:** `TaskOutput.status` may show `"completed"` even when an agent failed due to hook blocks or other issues. The actual failure is reported in the output text, not the status field.

**Failure Detection Keywords:**
Parse the agent's output text for these patterns to detect failures:

| Pattern | Meaning |
|---------|---------|
| `HOOK_BLOCKED:` | Hook prevented the operation (most reliable) |
| `unable to proceed` | Agent could not complete the task |
| `blocked by hook` | Operation was blocked by pre-tool hook |
| `I'm unable to` | Agent hit a blocking constraint |

## Implementation Quality Standards

Before each commit, self-check against these standards:

### 1. Scope Check
Does this change directly address an AC item?
- **Yes** → Proceed
- **No** → Is this refactor necessary for the AC? If not, skip it.

### 2. Type Safety Check
Am I maintaining or improving types?
- **Avoid:** Adding `any`, removing type annotations, using `as any`
- **Good:** Adding types, making types more specific, proper type inference

### 3. Test Coverage Check
Am I preserving existing test coverage?
- **Never** delete tests to "make build pass"
- **Always** update tests when behavior changes, add tests for new behavior

### 4. Size Check
Is this change proportional to the AC?
- **Simple AC** (display, button, styling): <100 LOC
- **Medium AC** (CRUD, admin page, form): 100-300 LOC
- **Complex AC** (major feature, multi-component): 300-500 LOC
- **If larger:** Break into smaller, focused commits

### 5. Integration Check
Are new files actually used?
- **Never** create components that aren't imported anywhere
- **Never** create utility functions that aren't called
- **Never** create API routes that aren't used from UI
- **Always** verify new exports are imported in at least one location

**Quick verification:**
```bash
# Check for unused exports in new files
npm run knip 2>/dev/null | grep -E "unused|Unused" || echo "No unused exports"
```

### 6. Test Impact Check (File Conversions)

When converting files to stubs, deleting content, or significantly changing file structure:

```bash
# Check if any tests depend on the modified file's content
grep -r "filename.md" __tests__/
grep -r "filename" __tests__/ | grep -v ".snap"
```

**If tests are found:**
1. Review what the tests are checking (file existence vs. content)
2. Update tests to check the new location if content moved
3. Run `npm test` after ALL file conversions are complete

**Why this matters:** Tests may pass during implementation but fail after final changes if they depend on content that was converted to a stub or moved elsewhere.

### Red Flags to Avoid

These patterns indicate scope creep or over-engineering:
- Renaming functions/variables not related to AC
- Reformatting files you didn't otherwise modify
- "While I was here" improvements
- Converting JS to TS as a side effect
- Changing linting rules or config
- Adding abstractions for one-time use
- Creating utilities not required by AC

### Quality Commitment

When in doubt, choose:
- **Minimal** over comprehensive
- **Explicit** over clever
- **Focused** over thorough
- **Working** over perfect

The goal is to satisfy AC with the smallest, safest change possible.

### 5. Adversarial Self-Evaluation (REQUIRED)

**Before outputting your final summary**, you MUST complete this adversarial self-evaluation to catch issues that automated checks miss.

**Why this matters:** Sessions show that honest self-questioning consistently catches real issues:
- Tests that pass but don't cover the actual changes
- Features that build but don't work as expected
- AC items marked "done" but with weak implementation

**Answer these questions honestly:**
1. "Did anything not work as expected during implementation?"
2. "If this feature broke tomorrow, would the current tests catch it?"
3. "What's the weakest part of this implementation?"
4. "Am I reporting success metrics without honest self-evaluation?"

**Include this section in your output:**

```markdown
### Self-Evaluation

- **Worked as expected:** [Yes/No - if No, explain what didn't work]
- **Test coverage confidence:** [High/Medium/Low - explain why]
- **Weakest part:** [Identify the weakest aspect of the implementation]
- **Honest assessment:** [Any concerns or caveats?]
```

**If any answer reveals concerns:**
- Address the issues before proceeding
- Re-run relevant checks (`npm test`, `npm run build`)
- Update the self-evaluation after fixes

**Do NOT skip this self-evaluation.** Honest reflection catches issues that automated checks miss.

---

### 6. Progress Summary and Draft Issue Update

**If orchestrated (SEQUANT_ORCHESTRATOR is set):**
- Skip posting progress comments to GitHub (orchestrator handles summary)
- Still provide AC coverage summary in output for orchestrator to capture
- Let orchestrator handle final GitHub update

**If standalone:**

At the end of a session:

1. Summarize:
   - Which AC items appear satisfied (AC-1, AC-2, ...).
   - Which AC items are partially or not yet satisfied.
   - Which checks were run and their outcomes (`npm test`, `npm run build`, etc.).
   - Any remaining TODOs or recommended follow-ups.

2. Draft a Markdown snippet as a **progress update** for the GitHub issue:

   - Include:
     - AC coverage summary
     - Brief list of key files changed
     - **PR Status** (Created with URL, or Failed with reason and manual instructions)
     - Any known gaps or open questions

   - Label it clearly as:

     ```md
     --- DRAFT GITHUB ISSUE COMMENT (PROGRESS UPDATE) ---

     ...

     ```

3. **Update GitHub Issue**

   - After drafting the progress update comment, post it to the GitHub issue:
     ```bash
     gh issue comment <issue-number> --body "$(cat <<'EOF'
     [draft comment content]
     EOF
     )"
     ```
   - Include the AC coverage summary, files changed, and any gaps or questions in the comment.
   - If the issue has status fields or labels, update them appropriately based on progress (e.g., mark as "in progress"):
     ```bash
     gh issue edit <issue-number> --add-label "in-progress"
     ```

You may be invoked multiple times for the same issue. Each time, re-establish context, ensure you're in the correct worktree, and continue iterating until we are as close as practical to meeting the AC.

---

## State Tracking

**IMPORTANT:** Update workflow state when running standalone (not orchestrated).

### Check Orchestration Mode

The orchestration check happens automatically when you run the state update script - it exits silently if `SEQUANT_ORCHESTRATOR` is set.

### State Updates (Standalone Only)

When NOT orchestrated (`SEQUANT_ORCHESTRATOR` is not set):

**At skill start:**
```bash
npx tsx scripts/state/update.ts start <issue-number> exec
```

**On successful completion:**
```bash
npx tsx scripts/state/update.ts complete <issue-number> exec
```

**On failure:**
```bash
npx tsx scripts/state/update.ts fail <issue-number> exec "Error description"
```

**Why this matters:** State tracking enables dashboard visibility, resume capability, and workflow orchestration. Skills update state when standalone; orchestrators handle state when running workflows.

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Self-Evaluation Completed** - Adversarial self-evaluation section included in output
- [ ] **AC Progress Summary** - Which AC items are satisfied, partially met, or blocked
- [ ] **Files Changed** - List of key files modified
- [ ] **Test/Build Results** - Output from `npm test` and `npm run build`
- [ ] **PR Status** - Created (with URL) or Failed (with error and manual instructions)
- [ ] **Progress Update Draft** - Formatted comment for GitHub issue
- [ ] **Documentation Reminder** - Note if README/docs need updating (checked in /qa)
- [ ] **Next Steps** - Clear guidance on remaining work

**DO NOT respond until all items are verified.**
