---
name: exec
description: "Phase 2 - Implementation loop for a single GitHub issue until Acceptance Criteria are satisfied (or as close as practical)."
license: MIT
metadata:
  author: matcha-maps
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
  # MCP tools for implementation
  - mcp__supabase__list_tables
  - mcp__supabase__execute_sql
  - mcp__supabase__apply_migration
  - mcp__context7__resolve-library-id
  - mcp__context7__query-docs
  # Task management
  - Task
  - TodoWrite
---

# Implementation Command

You are the Phase 2 "Implementation Agent" for the Matcha Maps repository.

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

### 2. Re-establish Context

- **Read all GitHub issue comments** to gather complete context:
  - Comments often contain clarifications, updates, or additional AC added after the initial issue description
  - Look for discussion about implementation details, edge cases, or requirements mentioned in comments
  - Review feedback from previous implementation cycles or review comments
- Summarize briefly:
  - The AC checklist (AC-1, AC-2, ...) from the issue and all comments
  - The current implementation plan (from issue comments or `/spec`)
- If there is no plan:
  - Ask whether to quickly propose one (or suggest using `/spec` first).

### Feature Worktree Workflow

**Execution Phase:** Create and work in a feature worktree.

1. **Check if worktree already exists:**
   - Check if you're already in a worktree: `git worktree list` or check if `../worktrees/` contains a directory for this issue
   - If worktree exists, navigate to it and continue work there

2. **Create worktree if needed:**
   - From the main repository directory, run: `./scripts/dev/new-feature.sh <issue-number>`
   - This will:
     - Fetch issue details from GitHub
     - Create branch: `feature/<issue-number>-<issue-title-slug>`
     - Create worktree in: `../worktrees/feature/<branch-name>/`
     - Install dependencies
     - Copy `.env.local` if it exists
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

### Using Sequential Thinking, Context7, or Supabase MCP

Use these specialized tools when appropriate:

**Sequential Thinking** - For complex problem-solving requiring multi-step reasoning:
- Novel algorithms or data structures
- Ambiguous requirements needing exploration
- Complex business logic with multiple edge cases
- Multi-step reasoning with dependencies
- **NOT for:** Standard CRUD operations, UI implementation following existing patterns, straightforward feature additions

**Context7** - For understanding external libraries and packages:
- Learning unfamiliar npm package APIs (react-query, zod, framer-motion, etc.)
- Understanding third-party library patterns
- Resolving library-specific type issues
- **NOT for:** Project's own codebase (use Glob/Grep instead), Next.js patterns (documented in CLAUDE.md)

**Supabase MCP** - For any database-related implementation:
- **ALWAYS USE** before writing database queries or migrations
- Verify table schemas and column types
- Check RLS policies before data access code
- Understand table relationships
- Validate data models match TypeScript types
- **USE for:** Every feature touching `content_updates`, `shops`, `pending_shops`, etc.

**General Rule:** If you're implementing a feature similar to an existing one (e.g., new admin card component, new validation function), use Glob/Grep to find patterns rather than Sequential Thinking.

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

### 5. Progress Summary and Draft Issue Update

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
