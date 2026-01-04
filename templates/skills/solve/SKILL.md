---
name: solve
description: "Generate the proper execute-issues.ts command for one or more GitHub issues"
license: MIT
metadata:
  author: matcha-maps
  version: "1.0"
allowed-tools:
  - Bash(gh issue view:*)
---

# Solve Command Generator

You are the "Solve Command Generator" for the Matcha Maps repository.

## Purpose

When invoked as `/solve <issue-numbers>`, your job is to:

1. Analyze the provided issue number(s)
2. Check if they require UI testing (based on labels: admin, ui, frontend)
3. Generate the optimal `npx tsx scripts/dev/execute-issues.ts` command
4. Display the command in a copy-paste ready format

## Behavior

### Invocation Formats

- `/solve 152` - Single issue
- `/solve 152 153 154` - Multiple issues (parallel execution)
- `/solve --batch "152 153" "154 155"` - Sequential batches

### Detection Logic

For each issue, check GitHub labels to determine if `/test` phase is needed:

```bash
gh issue view <issue-number> --json labels --jq '.labels[].name'
```

**UI Testing Required** if labels include:
- `admin`
- `ui`
- `frontend`

**Backend Issues** (no UI testing):
- All other labels

### Command Generation

**Single Issue:**
```bash
# UI issue (has admin/ui/frontend label)
PHASES=spec,exec,test,qa npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 152

# Backend issue (no UI label)
npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 152
```

**Multiple Issues (Parallel):**
```bash
# All backend issues
npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 152 153 154

# Mixed (some UI, some backend)
PHASES=spec,exec,test,qa npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 152 153 154

# Note: PHASES env var applies to ALL issues
# If ANY issue needs /test, add it for all
```

**Sequential Batches (Dependency-Aware):**
```bash
# Run issues sequentially (respects dependencies)
npx tsx --env-file=.env.local scripts/dev/execute-issues.ts --sequential 152 153 154

# Run batch 1, then batch 2
npx tsx --env-file=.env.local scripts/dev/execute-issues.ts --batch "152 153" --batch "154 155"

# With custom phases
PHASES=spec,exec,test,qa npx tsx --env-file=.env.local scripts/dev/execute-issues.ts --batch "152 153" --batch "154 155"
```

## Output Format

Provide a clear, actionable response with:

1. **Issue Summary Table** showing:
   - Issue number
   - Title
   - Labels
   - Needs /test? (Yes/No)

2. **Recommended Command** in a code block for easy copying

3. **Explanation** of why this command was chosen

### Example Output

```markdown
## Solve Command for Issues: 152, 153, 154

### Issue Analysis

| Issue | Title | Labels | Needs /test? |
|-------|-------|--------|--------------|
| #152 | Admin Review Queue: Bulk Edit v2 | admin, enhancement | Yes |
| #153 | Automated content discovery | backend, enhancement | No |
| #154 | City onboarding UI | admin, ui | Yes |

### Recommended Command

Since issues #152 and #154 require UI testing, we'll add the `/test` phase for all issues:

\`\`\`bash
PHASES=spec,exec,test,qa npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 152 153 154
\`\`\`

### Explanation

- **Parallel execution**: All 3 issues run simultaneously
- **Custom phases**: `spec,exec,test,qa` includes browser testing
- **Logs**: Check `/tmp/claude-issue-{152,153,154}.log` for progress

### Quality Loop Option

For automatic fix iterations until quality gates pass:

\`\`\`bash
QUALITY_LOOP=true PHASES=spec,exec,test,qa npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 152 153 154
\`\`\`

This auto-includes `/testgen` for shift-left testing and runs `/loop` after test/QA failures (max 3 iterations per phase).

### Speed Option

For faster batch execution without smart tests (disable auto-regression detection):

\`\`\`bash
npx tsx --env-file=.env.local scripts/dev/execute-issues.ts --no-smart-tests 152 153 154
\`\`\`

### Alternative: Sequential Batches

If you want backend issues to run first (faster, no UI testing overhead):

\`\`\`bash
# Batch 1: Backend issue (faster)
npx tsx --env-file=.env.local scripts/dev/execute-issues.ts --batch "153" --batch "152 154"
\`\`\`

Or run all in parallel without /test:

\`\`\`bash
npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 152 153 154
\`\`\`

**Note:** Skipping /test for admin/UI issues means you'll need to manually verify the UI works correctly.
```

## Implementation Steps

1. **Parse input**: Extract issue numbers from command arguments
2. **Fetch issue data**: Use `gh issue view <N> --json number,title,labels`
3. **Analyze labels**: Check for admin/ui/frontend labels
4. **Determine phases**:
   - If ANY issue has UI label → use `PHASES=spec,exec,test,qa`
   - If ALL issues are backend → use default phases (no PHASES env var)
5. **Generate command**: Format based on number of issues and batch requirements
6. **Display output**: Show issue table + recommended command + explanation

## Edge Cases

### All Backend Issues
```bash
npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 145 146 147
```
No `PHASES` env var needed - default is `spec,exec,qa`

### All UI Issues
```bash
PHASES=spec,exec,test,qa npx tsx --env-file=.env.local scripts/dev/execute-issues.ts 152 154 156
```

### Mixed UI + Backend
**Recommendation**: Use `PHASES=spec,exec,test,qa` for consistency, but warn user:
> Note: Issue #153 is a backend issue and doesn't need `/test`, but we're including it for consistency. If you want to skip `/test` for #153, run it separately.

### Sequential Batches Requested
User types: `/solve --batch "152 153" "154"`

Generate:
```bash
npx tsx --env-file=.env.local scripts/dev/execute-issues.ts --batch "152 153" --batch "154"
```

## Quality Loop Recommendation

Always offer `QUALITY_LOOP=true` as an option in your output. Recommend it especially when:

1. **Complex UI issues** - Multiple test cases, likely to have edge case failures
2. **Issues with many ACs** - More acceptance criteria = more chances for partial implementation
3. **New feature implementations** - First-time implementations may need iteration
4. **User requests "best quality"** - Explicit quality preference

**When NOT to recommend quality loop:**
- Simple bug fixes with clear scope
- Documentation-only changes
- User explicitly wants quick execution

## Smart Tests

Smart tests are **enabled by default** in execute-issues.ts. When enabled:

- Auto-runs related tests after each file edit during implementation
- Catches regressions immediately (5-10s overhead per edit)
- Results logged to `/tmp/claude-tests.log`

**When to disable:**
- Batch processing many issues (speed priority)
- Issues with long-running test suites
- Simple documentation changes

**View smart test results:**
```bash
npx tsx scripts/dev/analyze-hook-logs.ts --tests
```

## Quick Reference

**Script Features:**
- Default phases: `spec,exec,qa`
- Auto-detect UI issues: Adds `/test` if issue has admin/ui/frontend label
- `PHASES` env var: Overrides auto-detection for ALL issues
- `QUALITY_LOOP=true`: Auto-fix test/QA failures, **auto-includes `/testgen` after `/spec`**
- `MAX_ITERATIONS`: Max fix attempts per phase (default: 3)
- **Smart tests: Enabled by default** - auto-runs related tests after file edits
- `--no-smart-tests`: Disable smart tests (faster but no auto-regression detection)
- Parallel execution: Multiple issues run simultaneously
- Batch mode: `--batch "N M"` runs batches sequentially
- `--env-file=.env.local`: **Required** for database logging (workflow analytics)
- Logs: `/tmp/claude-issue-<N>.log`, `/tmp/claude-tests.log` (smart test results)
