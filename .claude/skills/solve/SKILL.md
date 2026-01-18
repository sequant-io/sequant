---
name: solve
description: "Generate the recommended workflow for one or more GitHub issues"
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Bash(gh issue view:*)
---

# Solve Command Generator

You are the "Solve Command Generator" for the current repository.

## Purpose

When invoked as `/solve <issue-numbers>`, your job is to:

1. Analyze the provided issue number(s)
2. Check labels to determine issue type
3. Recommend the optimal workflow sequence
4. Display the recommended commands

## Behavior

### Invocation Formats

- `/solve 152` - Single issue
- `/solve 152 153 154` - Multiple issues

### Detection Logic

For each issue, check GitHub labels to determine the workflow:

```bash
gh issue view <issue-number> --json labels --jq '.labels[].name'
```

**UI/Frontend Issues** (labels: `ui`, `frontend`, `admin`):
- Include `/test` phase for browser testing

**Backend/API Issues** (labels: `backend`, `api`, `cli`):
- Skip browser testing, focus on unit/integration tests

**Bug Fixes** (labels: `bug`, `fix`):
- May need simpler workflow, possibly skip `/spec`

**Complex Issues** (labels: `complex`, `refactor`, `breaking`, `major`):
- Recommend `--quality-loop` flag for auto-retry on failures
- Quality loop auto-enables for these labels in `sequant run`

### Chain Mode Detection

When analyzing multiple issues, determine if `--chain` flag should be recommended.

**Check for chain indicators:**

```bash
# Check for dependency keywords in issue body
gh issue view <issue-number> --json body --jq '.body' | grep -iE "(depends on|blocked by|requires|after #|builds on)"

# Check for sequence labels
gh issue view <issue-number> --json labels --jq '.labels[].name' | grep -iE "(part-[0-9]|step-[0-9]|phase-[0-9])"

# Check for related issue references
gh issue view <issue-number> --json body --jq '.body' | grep -oE "#[0-9]+"
```

**Recommend `--chain` when:**
- Multiple issues have explicit dependencies (e.g., "depends on #123")
- Issues are labeled as parts of a sequence (e.g., `part-1`, `part-2`)
- Issue titles indicate sequence (e.g., "Part 1:", "Step 2:")
- Issues reference each other in their bodies
- Issues modify the same files in a specific order

**Do NOT recommend `--chain` when:**
- Single issue (chain requires 2+ issues)
- Issues are independent (no shared files or dependencies)
- Issues touch completely different areas of codebase
- Parallel batch mode is more appropriate (unrelated issues)

**Chain structure visualization:**
```
origin/main → #10 → #11 → #12
              │      │      │
              └──────┴──────┴── Each branch builds on previous
```

## Output Format

Provide a clear, actionable response with:

1. **Issue Summary Table** showing:
   - Issue number
   - Title
   - Labels
   - Recommended workflow

2. **Chain Mode Section** (for multiple issues):
   - Whether `--chain` is recommended
   - Why chain is/isn't recommended
   - Chain structure visualization (if recommended)

3. **Recommended Commands** in order

4. **CLI Command** - ALWAYS include `npx sequant run <issue>` for terminal/CI usage

5. **Explanation** of why this workflow was chosen

### Example Output (Independent Issues - No Chain)

```markdown
## Solve Workflow for Issues: 152, 153

### Issue Analysis

| Issue | Title | Labels | Workflow |
|-------|-------|--------|----------|
| #152 | Add user dashboard | ui, enhancement | Full (with /test) |
| #153 | Refactor auth module | backend, refactor | Standard + quality loop |

### Chain Mode: ❌ Not Recommended

These issues are **independent** and can be run in parallel:
- #152 touches UI components
- #153 touches backend auth module
- No shared files or dependencies detected

### Recommended Workflow

**For #152 (UI feature):**
```bash
/spec 152      # Plan the implementation
/exec 152      # Implement the feature
/test 152      # Browser-based UI testing
/qa 152        # Quality review
```

**For #153 (Backend refactor):**
```bash
/spec 153      # Plan the refactor
/exec 153      # Implement changes
/qa 153        # Quality review
```

> **Note:** Issue #153 has `refactor` label. Quality loop will **auto-enable** when using `sequant run`, providing automatic fix iterations if phases fail.

### CLI Command

Run from terminal (parallel execution):
```bash
npx sequant run 152 153
```

For issue #153 (or any complex work), quality loop is recommended:
```bash
npx sequant run 153 --quality-loop   # Explicit (auto-enabled for refactor label)
```

> **Tip:** Install globally with `npm install -g sequant` to omit the `npx` prefix.

### Notes
- Issue #152 requires UI testing due to `ui` label
- Issue #153 will auto-enable quality loop due to `refactor` label
- Quality loop: auto-retries failed phases up to 3 times
```

### Example Output (Dependent Issues - Chain Recommended)

```markdown
## Solve Workflow for Issues: 10, 11, 12

### Issue Analysis

| Issue | Title | Labels | Workflow |
|-------|-------|--------|----------|
| #10 | Add auth middleware | backend, part-1 | Standard |
| #11 | Add login page | ui, part-2 | Full (with /test) |
| #12 | Add logout functionality | ui, part-3 | Full (with /test) |

### Chain Mode: ✅ Recommended

These issues form a **dependency chain**:
- #11 body contains "depends on #10"
- #12 body contains "depends on #11"
- Issues are labeled as parts of a sequence (part-1, part-2, part-3)

**Chain structure:**
```
origin/main → #10 → #11 → #12
              │      │      │
              auth   login  logout
```

### Recommended Workflow

Run sequentially with `--chain`:
```bash
npx sequant run 10 11 12 --sequential --chain
```

This ensures:
- #10 completes and merges before #11 starts
- #11 branches from completed #10
- #12 branches from completed #11

### CLI Command

```bash
npx sequant run 10 11 12 --sequential --chain
```

> **Note:** The `--chain` flag ensures each issue builds on the previous. Without it, issues would branch from the same base.

### Notes
- Issues 10, 11, 12 form a dependency chain
- Chain mode builds each branch on top of the previous
- Order matters: run in dependency order (10 → 11 → 12)
```

## Workflow Selection Logic

**Note:** `npx sequant run` now uses **spec-driven phase detection**. It runs `/spec` first, which analyzes the issue and outputs a `## Recommended Workflow` section. The CLI then parses this to determine subsequent phases.

### How It Works

1. **Bug fixes** (labels: `bug`, `fix`) → Skip spec, run `exec → qa` directly
2. **All other issues** → Run `/spec` first, which recommends phases based on:
   - UI/frontend changes → Add `test` phase
   - Complex refactors → Enable quality loop
   - Security-sensitive → Add `security-review` phase

### Standard Workflow (Most Issues)
```
/spec → /exec → /qa
```

### UI Feature Workflow
```
/spec → /exec → /test → /qa
```

### Bug Fix Workflow (Simple)
```
/exec → /qa
```
Skip `/spec` if the bug is well-defined and straightforward.

### Complex Feature Workflow
```
/fullsolve <issue>
```
Runs complete workflow with automatic fix iterations.

## Quick Reference

| Issue Type | Labels | Workflow |
|------------|--------|----------|
| UI Feature | ui, frontend, admin | spec → exec → test → qa |
| Backend Feature | backend, api | spec → exec → qa |
| Bug Fix | bug, fix | exec → qa (or full if complex) |
| Complex Feature | complex, refactor | `--quality-loop` or fullsolve |
| Documentation | docs | exec → qa |

**Quality Loop vs Fullsolve:**
- `--quality-loop`: Enables auto-retry within `sequant run` (good for CI/automation)
- `/fullsolve`: Interactive single-issue resolution with inline loops (good for manual work)

## CLI Alternative

Use `npx sequant run` for batch execution from the command line:

```bash
# Run workflow for single issue
npx sequant run 152

# Multiple issues in parallel
npx sequant run 152 153 154

# Sequential execution (respects dependencies)
npx sequant run 152 153 --sequential

# Chain mode (each issue branches from previous completed issue)
npx sequant run 10 11 12 --sequential --chain

# Custom phases
npx sequant run 152 --phases spec,exec,qa

# Quality loop (auto-retry on failures, max 3 iterations)
npx sequant run 152 --quality-loop

# Quality loop with custom iterations
npx sequant run 152 --quality-loop --max-iterations 5

# Dry run (shows what would execute)
npx sequant run 152 --dry-run
```

### Chain Mode Explained

The `--chain` flag (requires `--sequential`) creates dependent branches:

```
Without --chain:          With --chain:
origin/main               origin/main
    ├── #10                   └── #10 (merged)
    ├── #11                       └── #11 (merged)
    └── #12                           └── #12
```

**Use `--chain` when:**
- Issues have explicit dependencies
- Later issues build on earlier implementations
- Order matters for correctness

**Do NOT use `--chain` when:**
- Issues are independent
- Parallel execution is appropriate
- Issues can be merged in any order

> **Tip:** Install globally with `npm install -g sequant` to omit the `npx` prefix.

## Edge Cases

### Multiple Issues with Different Types

When solving multiple issues with mixed types, recommend running them separately:

```markdown
These issues have different requirements. Run separately:

**UI Issues (with browser testing):**
/fullsolve 152

**Backend Issues:**
/fullsolve 153
```

### Issue with Dependencies

If issues depend on each other:

```markdown
⚠️ Issue #154 depends on #153. Run in order:

1. /fullsolve 153
2. (Wait for PR merge)
3. /fullsolve 154
```

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Issue Summary Table** - Table with Issue, Title, Labels, Workflow columns
- [ ] **Chain Mode Section** - (for 2+ issues) Whether chain is recommended and why
- [ ] **Recommended Workflow** - Slash commands in order for each issue
- [ ] **CLI Command** - `npx sequant run <issue-numbers>` command (REQUIRED)
- [ ] **Explanation** - Brief notes explaining workflow choices

**DO NOT respond until all items are verified.**

## Output Template

You MUST use this exact structure:

```markdown
## Solve Workflow for Issues: <ISSUE_NUMBERS>

### Issue Analysis

| Issue | Title | Labels | Workflow |
|-------|-------|--------|----------|
<!-- FILL: one row per issue. For complex/refactor/breaking/major labels, add "+ quality loop" to Workflow -->

<!-- IF 2+ issues, ALWAYS include Chain Mode section: -->
### Chain Mode: ✅ Recommended / ❌ Not Recommended

<!-- IF chain recommended: -->
These issues form a **dependency chain**:
- [List dependency indicators found]

**Chain structure:**
\`\`\`
origin/main → #<first> → #<second> → #<third>
\`\`\`

<!-- IF chain NOT recommended: -->
These issues are **independent** and can be run in parallel:
- [List reasons: different areas, no shared files, no dependencies]

### Recommended Workflow

**For #<N> (<type>):**
\`\`\`bash
<!-- FILL: slash commands in order -->
\`\`\`

<!-- IF any issue has complex/refactor/breaking/major label, include this callout: -->
> **Note:** Issue #<N> has `<label>` label. Quality loop will **auto-enable** when using `sequant run`, providing automatic fix iterations if phases fail.

### CLI Command

<!-- IF chain recommended: -->
Run with chain mode:
\`\`\`bash
npx sequant run <ISSUE_NUMBERS> --sequential --chain
\`\`\`

<!-- IF chain NOT recommended (parallel OK): -->
Run from terminal:
\`\`\`bash
npx sequant run <ISSUE_NUMBERS>
\`\`\`

<!-- IF any issue has complex/refactor/breaking/major label, include: -->
For complex issues, quality loop is recommended:
\`\`\`bash
npx sequant run <ISSUE_NUMBER> --quality-loop   # Explicit (auto-enabled for <label> label)
\`\`\`

> **Tip:** Install globally with `npm install -g sequant` to omit the `npx` prefix.

### Notes
<!-- FILL: explanation of workflow choices -->
<!-- Include note about chain mode if applicable -->
<!-- Include note about quality loop auto-enabling if applicable -->
```
