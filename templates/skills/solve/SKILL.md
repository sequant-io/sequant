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

## Output Format

Provide a clear, actionable response with:

1. **Issue Summary Table** showing:
   - Issue number
   - Title
   - Labels
   - Recommended workflow

2. **Recommended Commands** in order

3. **CLI Command** - ALWAYS include `sequant run <issue>` for terminal/CI usage

4. **Explanation** of why this workflow was chosen

### Example Output

```markdown
## Solve Workflow for Issues: 152, 153

### Issue Analysis

| Issue | Title | Labels | Workflow |
|-------|-------|--------|----------|
| #152 | Add user dashboard | ui, enhancement | Full (with /test) |
| #153 | Fix API validation | backend, bug | Standard |

### Recommended Workflow

**For #152 (UI feature):**
```bash
/spec 152      # Plan the implementation
/exec 152      # Implement the feature
/test 152      # Browser-based UI testing
/qa            # Quality review
```

**For #153 (Backend fix):**
```bash
/spec 153      # Quick plan (bug fix)
/exec 153      # Implement the fix
/qa            # Quality review
```

### Full Workflow Option

For comprehensive quality with automatic fix iterations:
```bash
/fullsolve 152
```

### CLI Command

Run from terminal (useful for automation/CI):
```bash
sequant run 152        # Single issue
sequant run 152 153    # Multiple issues
```

### Notes
- Issue #152 requires UI testing due to `ui` label
- Issue #153 is a bug fix - simpler workflow recommended
- Run `/qa` after each issue before moving to next
```

## Workflow Selection Logic

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
| Complex Feature | complex, refactor | fullsolve |
| Documentation | docs | exec → qa |

## CLI Alternative

Use `sequant run` for batch execution from the command line:

```bash
# Run workflow for single issue
sequant run 152

# Multiple issues in parallel
sequant run 152 153 154

# Sequential execution (respects dependencies)
sequant run 152 153 --sequential

# Custom phases
sequant run 152 --phases spec,exec,qa

# Dry run (shows what would execute)
sequant run 152 --dry-run
```

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
