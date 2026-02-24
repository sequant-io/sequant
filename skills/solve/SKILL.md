---
name: solve
description: "Generate the recommended workflow for one or more GitHub issues"
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
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

## Output Format

Provide a clear, actionable response with:

1. **Issue Summary Table** showing:
   - Issue number
   - Title
   - Labels
   - Recommended workflow

2. **Recommended Commands** in order

3. **CLI Command** - ALWAYS include `npx sequant run <issue>` for terminal/CI usage

4. **Explanation** of why this workflow was chosen

### Example Output

```markdown
## Solve Workflow for Issues: 152, 153

### Issue Analysis

| Issue | Title | Labels | Workflow |
|-------|-------|--------|----------|
| #152 | Add user dashboard | ui, enhancement | Full (with /test) |
| #153 | Refactor auth module | backend, refactor | Standard + quality loop |

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

Run from terminal:
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

# Custom phases
npx sequant run 152 --phases spec,exec,qa

# Quality loop (auto-retry on failures, max 3 iterations)
npx sequant run 152 --quality-loop

# Quality loop with custom iterations
npx sequant run 152 --quality-loop --max-iterations 5

# Dry run (shows what would execute)
npx sequant run 152 --dry-run
```

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

## Persist Analysis to Issue Comments

**After displaying the solve output in the terminal**, prompt the user to save the analysis:

```
Save this plan to the issues? [Y/n]
```

Use the `AskUserQuestion` tool with options "Yes (Recommended)" and "No".

**If user confirms (Y):**

Post a structured comment to **each analyzed issue** with machine-readable markers that `/spec` can later parse.

### Comment Format

```markdown
## Solve Analysis

**Recommended Phases:** <phases in arrow notation>
**Skip Spec:** Yes/No (<reasoning>)
**Browser Testing:** Yes/No (<reasoning>)
**Quality Loop:** Yes/No (<reasoning>)

### Reasoning
- <reason 1>
- <reason 2>
- <reason 3>

### Flags
| Flag | Value | Reasoning |
|------|-------|-----------|
| -q (quality-loop) | ✓/✗ | <reasoning> |
| --chain | ✓/✗ | <reasoning> |
| --qa-gate | ✓/✗ | <reasoning> |
| --base | ✓/✗ | <reasoning> |
| --testgen | ✓/✗ | <reasoning> |

<!-- solve:phases=<comma-separated phases> -->
<!-- solve:skip-spec=<true/false> -->
<!-- solve:browser-test=<true/false> -->
<!-- solve:quality-loop=<true/false> -->

*📝 Generated by `/solve`*
```

### Posting Logic

```bash
# For each analyzed issue, post the structured comment
for issue_number in <ANALYZED_ISSUES>; do
  gh issue comment "$issue_number" --body "$(cat <<'EOF'
## Solve Analysis

**Recommended Phases:** <phases>
...

<!-- solve:phases=<phases> -->
<!-- solve:skip-spec=<true/false> -->
<!-- solve:browser-test=<true/false> -->
<!-- solve:quality-loop=<true/false> -->

*📝 Generated by `/solve`*
EOF
)"
done
```

**If user declines (N):** Skip posting. The terminal output remains the only record.

### Machine-Readable Markers

The HTML comment markers enable downstream tools (like `/spec`) to parse the analysis programmatically:

| Marker | Values | Consumed By |
|--------|--------|-------------|
| `<!-- solve:phases=... -->` | Comma-separated phase names | `/spec` phase detection |
| `<!-- solve:skip-spec=... -->` | `true`/`false` | `/spec` skip logic |
| `<!-- solve:browser-test=... -->` | `true`/`false` | `/spec` test phase |
| `<!-- solve:quality-loop=... -->` | `true`/`false` | `/spec` quality loop |

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Issue Summary Table** - Table with Issue, Title, Labels, Workflow columns
- [ ] **Recommended Workflow** - Slash commands in order for each issue
- [ ] **CLI Command** - `npx sequant run <issue-numbers>` command (REQUIRED)
- [ ] **Explanation** - Brief notes explaining workflow choices
- [ ] **Persist Prompt** - After output, prompt "Save this plan to the issues? [Y/n]"
- [ ] **Comment Posted** - If user confirms, structured comment posted to each issue with HTML markers

**DO NOT respond until all items are verified.**

## Output Template

You MUST use this exact structure:

```markdown
## Solve Workflow for Issues: <ISSUE_NUMBERS>

### Issue Analysis

| Issue | Title | Labels | Workflow |
|-------|-------|--------|----------|
<!-- FILL: one row per issue. For complex/refactor/breaking/major labels, add "+ quality loop" to Workflow -->

### Recommended Workflow

**For #<N> (<type>):**
\`\`\`bash
<!-- FILL: slash commands in order -->
\`\`\`

<!-- IF any issue has complex/refactor/breaking/major label, include this callout: -->
> **Note:** Issue #<N> has `<label>` label. Quality loop will **auto-enable** when using `sequant run`, providing automatic fix iterations if phases fail.

### CLI Command

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
<!-- Include note about quality loop auto-enabling if applicable -->
```
