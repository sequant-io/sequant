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

**New Features** (labels: `enhancement`, `feature`):
- Include `testgen` phase when ACs need automated tests
- Workflow: `spec → testgen → exec → qa`

### Quality Loop Detection

Quality loop (`--quality-loop` or `-q`) provides automatic fix iterations when phases fail. **Recommend quality loop broadly** for any non-trivial work.

**Always recommend `--quality-loop` when:**
- Labels include: `complex`, `refactor`, `breaking`, `major` (auto-enabled)
- Labels include: `enhancement`, `feature` (new functionality)
- Issue involves multiple files or components
- Issue title contains: "add", "implement", "create", "refactor", "update"
- Issue is NOT a simple bug fix with `bug` or `fix` label only

**Skip quality loop recommendation only when:**
- Simple bug fix (only `bug` or `fix` label, no other labels)
- Documentation-only changes (`docs` label only)
- Issue explicitly marked as trivial

**Quality loop benefits:**
- Auto-retries failed phases up to 3 times
- Catches intermittent test failures
- Handles build issues from dependency changes
- Reduces manual intervention for recoverable errors

### Feature Branch Detection

When analyzing issues, check if `--base` flag should be recommended.

**Check for feature branch indicators:**

```bash
# Check for feature branch references in issue body
gh issue view <issue-number> --json body --jq '.body' | grep -iE "(feature/|branch from|based on|part of.*feature)" || true

# Check issue labels for feature context
gh issue view <issue-number> --json labels --jq '.labels[].name' | grep -iE "(dashboard|feature-|epic-)" || true

# Check if project has defaultBase configured
# Use the Read tool to check project settings
Read(file_path=".sequant/settings.json")
# Extract .run.defaultBase from the JSON
```

**Recommend `--base <branch>` when:**
- Issue body references a feature branch (e.g., "Part of dashboard feature")
- Issue is labeled with a feature epic label (e.g., `dashboard`, `epic-auth`)
- Multiple related issues reference the same parent feature
- Project has `run.defaultBase` configured in settings

**Do NOT recommend `--base` when:**
- Issue should branch from main (default, most common)
- No feature branch context detected
- Issue is a standalone bug fix or independent feature

### Chain Mode Detection

When analyzing multiple issues, determine if `--chain` flag should be recommended.

**Check for chain indicators:**

```bash
# Check for dependency keywords in issue body
gh issue view <issue-number> --json body --jq '.body' | grep -iE "(depends on|blocked by|requires|after #|builds on)" || true

# Check for sequence labels
gh issue view <issue-number> --json labels --jq '.labels[].name' | grep -iE "(part-[0-9]|step-[0-9]|phase-[0-9])" || true

# Check for related issue references
gh issue view <issue-number> --json body --jq '.body' | grep -oE "#[0-9]+" || true
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

### QA Gate Detection

When recommending `--chain`, also consider if `--qa-gate` should be added.

**Recommend `--qa-gate` when:**
- Chain has 3+ issues (longer chains have higher stale code risk)
- Issues have tight dependencies (later issues heavily rely on earlier ones)
- Issues modify the same files across the chain
- Production-critical or high-risk changes

**Do NOT recommend `--qa-gate` when:**
- Chain has only 2 issues (lower risk)
- Issues are mostly independent despite chain structure
- Speed is prioritized over safety
- Simple, low-risk changes

**Chain structure visualization:**
```
origin/main → #10 → #11 → #12
              │      │      │
              └──────┴──────┴── Each branch builds on previous
```

## Output Format

**Design Principles:**
- Lead with the recommendation (command first, top-down)
- Show all flag decisions explicitly with reasoning
- Be concise — signal over prose
- Visual hierarchy using ASCII boxes and lines
- Max ~25 lines (excluding conflict warnings)

**Required Sections (in order):**

1. **Header Box** — Command recommendation prominently displayed
2. **Issues List** — Compact: `#N  Title ··· labels → workflow`
3. **Flags Table** — ALL flags with ✓/✗ and one-line reasoning
4. **Why Section** — 3-5 bullet points explaining key decisions
5. **Also Consider** — Conditional curated alternatives (0-3 items)
6. **Conflict Warning** — Only if in-flight work overlaps (conditional)

---

## Conflict Detection

Before generating output, check for in-flight work that may conflict:

```bash
# List open worktrees
git worktree list --porcelain 2>/dev/null | grep "^worktree" | cut -d' ' -f2

# For each worktree, get changed files
git -C <worktree-path> diff --name-only main...HEAD 2>/dev/null
```

**If overlap detected** with files this issue likely touches, include warning:
```
⚠ Conflict risk: #45 (open) modifies lib/auth/* — coordinate or wait
```

---

## "Also Consider" Logic

Only show alternatives representing genuine trade-offs. Max 2-3 items.

| Condition | Show Alternative |
|-----------|------------------|
| Complex issues OR user unfamiliar with sequant | `--dry-run` (preview before executing) |
| UI-adjacent AND test phase not included | `--phases +test` (add browser testing) |
| Mild dependency risk between issues | `--sequential` (run one at a time) |
| Dependencies ambiguous | Show both parallel and `--chain` options |

**Rules:**
- Omit section entirely if nothing worth showing
- Never list every flag — only curated, contextual options
- Each alternative needs one-line explanation

---

## Output Template

You MUST use this exact structure:

```
╭──────────────────────────────────────────────────────────────╮
│  sequant solve                                               │
│                                                              │
│  npx sequant run <ISSUES> <FLAGS>                            │
╰──────────────────────────────────────────────────────────────╯

#<N>  <Title truncated to ~35 chars> ·········· <labels> → <workflow>
#<N>  <Title truncated to ~35 chars> ·········· <labels> → <workflow>

┌─ Flags ──────────────────────────────────────────────────────┐
│  -q  quality-loop   ✓/✗  <one-line reasoning>                │
│  --chain            ✓/✗  <one-line reasoning>                │
│  --qa-gate          ✓/✗  <one-line reasoning>                │
│  --base             ✓/✗  <one-line reasoning>                │
│  --testgen          ✓/✗  <one-line reasoning>                │
└──────────────────────────────────────────────────────────────┘

Why this workflow:
  • <reason 1>
  • <reason 2>
  • <reason 3>

<!-- CONDITIONAL: Only if alternatives worth showing -->
Also consider:
  <flag>     <one-line explanation>
  <flag>     <one-line explanation>

<!-- CONDITIONAL: Only if conflict detected -->
⚠ Conflict risk: #<N> (open) modifies <path> — coordinate or wait
```

---

### Example Output (Independent Issues)

```
╭──────────────────────────────────────────────────────────────╮
│  sequant solve                                               │
│                                                              │
│  npx sequant run 152 153 -q                                  │
╰──────────────────────────────────────────────────────────────╯

#152  Add user dashboard ······················ ui → spec → testgen → exec → test → qa
#153  Refactor auth module ···················· backend → spec → exec → qa

┌─ Flags ──────────────────────────────────────────────────────┐
│  -q  quality-loop   ✓  refactor label auto-enables retry     │
│  --chain            ✗  independent (different codepaths)     │
│  --qa-gate          ✗  no chain mode                         │
│  --base             ✗  branching from main                   │
│  --testgen          ✓  #152 has testable ACs (Unit Tests)    │
└──────────────────────────────────────────────────────────────┘

Why this workflow:
  • #152 has ui label → includes /test for browser verification
  • #152 has testable ACs → includes /testgen for test stubs
  • #153 has refactor label → quality loop auto-enabled
  • No shared files → safe to parallelize

Also consider:
  --dry-run     Preview execution before running
```

---

### Example Output (Dependent Issues — Chain)

```
╭──────────────────────────────────────────────────────────────╮
│  sequant solve                                               │
│                                                              │
│  npx sequant run 10 11 12 --sequential --chain --qa-gate -q  │
╰──────────────────────────────────────────────────────────────╯

#10  Add auth middleware ······················ backend → spec → testgen → exec → qa
#11  Add login page ··························· ui → spec → testgen → exec → test → qa
#12  Add logout functionality ················· ui → spec → exec → test → qa

┌─ Flags ──────────────────────────────────────────────────────┐
│  -q  quality-loop   ✓  multi-step implementation             │
│  --chain            ✓  #11 depends on #10, #12 depends on #11│
│  --qa-gate          ✓  3 issues with tight dependencies      │
│  --base             ✗  branching from main                   │
│  --testgen          ✓  #10, #11 have Unit Test ACs           │
└──────────────────────────────────────────────────────────────┘

Chain structure:
  main → #10 → #11 → #12

Why this workflow:
  • Explicit dependencies detected in issue bodies
  • Chain ensures each branch builds on previous
  • QA gate prevents stale code in downstream issues
  • UI issues (#11, #12) include /test phase
  • #10, #11 have testable ACs → include /testgen
```

---

### Example Output (With Conflict Warning)

```
╭──────────────────────────────────────────────────────────────╮
│  sequant solve                                               │
│                                                              │
│  npx sequant run 85 -q                                       │
╰──────────────────────────────────────────────────────────────╯

#85  Update auth cookie handling ·············· bug → exec → qa

┌─ Flags ──────────────────────────────────────────────────────┐
│  -q  quality-loop   ✓  auth changes benefit from retry       │
│  --chain            ✗  single issue                          │
│  --qa-gate          ✗  no chain mode                         │
│  --base             ✗  branching from main                   │
│  --testgen          ✗  bug fix (targeted tests in exec)      │
└──────────────────────────────────────────────────────────────┘

Why this workflow:
  • Bug fix with clear AC → skip /spec
  • Bug fix → skip /testgen (targeted tests added during exec)
  • Single issue → no chain needed

⚠ Conflict risk: #82 (open) modifies lib/auth/cookies.ts — coordinate or wait
```

## Workflow Selection Logic

**Note:** `npx sequant run` now uses **spec-driven phase detection**. It runs `/spec` first, which analyzes the issue and outputs a `## Recommended Workflow` section. The CLI then parses this to determine subsequent phases.

### How It Works

1. **Bug fixes** (labels: `bug`, `fix`) → Skip spec, run `exec → qa` directly
2. **All other issues** → Run `/spec` first, which recommends phases based on:
   - UI/frontend changes → Add `test` phase
   - Complex refactors → Enable quality loop
   - Security-sensitive → Add `security-review` phase
   - New features with testable ACs → Add `testgen` phase

### Standard Workflow (Most Issues)
```
/spec → /exec → /qa
```

### Feature with Testable ACs
```
/spec → /testgen → /exec → /qa
```
Include `testgen` when ACs have Unit Test or Integration Test verification methods.

### UI Feature Workflow
```
/spec → /exec → /test → /qa
```

### UI Feature with Tests
```
/spec → /testgen → /exec → /test → /qa
```
Combine `testgen` and `test` for UI features with testable ACs.

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
| UI Feature with Tests | ui + enhancement | spec → testgen → exec → test → qa |
| Backend Feature | backend, api | spec → exec → qa |
| New Feature (testable) | enhancement, feature | spec → testgen → exec → qa |
| Bug Fix | bug, fix | exec → qa (or full if complex) |
| Complex Feature | complex, refactor | `--quality-loop` or fullsolve |
| Documentation | docs | exec → qa |

### Testgen Phase Detection

**Include `testgen` in workflow when:**
- Issue has `enhancement` or `feature` label AND
- Issue is NOT a simple bug fix or docs-only change AND
- Project has test infrastructure (Jest, Vitest, etc.)

**Skip `testgen` when:**
- Issue is `bug` or `fix` only (targeted tests added during exec)
- Issue is `docs` only (no code tests needed)
- All ACs use Manual Test or Browser Test verification

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

# Chain mode with QA gate (pause if QA fails, prevent stale code)
npx sequant run 10 11 12 --sequential --chain --qa-gate

# Custom base branch (branch from feature branch instead of main)
npx sequant run 117 --base feature/dashboard

# Chain mode with custom base branch
npx sequant run 117 118 119 --sequential --chain --base feature/dashboard

# Custom phases
npx sequant run 152 --phases spec,exec,qa

# Quality loop (auto-retry on failures, max 3 iterations)
npx sequant run 152 --quality-loop

# Quality loop with custom iterations
npx sequant run 152 --quality-loop --max-iterations 5

# Dry run (shows what would execute)
npx sequant run 152 --dry-run
```

### Post-Run: Merge Verification

After batch execution, run merge checks before merging:

```bash
# Verify feature branches are safe to merge (auto-detects issues from last run)
npx sequant merge --check

# Full scan including residual pattern detection
npx sequant merge --scan

# Post results to each PR
npx sequant merge --check --post
```

**Recommended workflow:**
```bash
npx sequant run 152 153 154        # implement
npx sequant merge --check          # verify cross-issue integration
/merger 152 153 154                # merge
```

### Custom Base Branch

The `--base` flag specifies which branch to create worktrees from:

```
Without --base:           With --base feature/dashboard:
origin/main               feature/dashboard
    ├── #117                  ├── #117
    ├── #118                  ├── #118
    └── #119                  └── #119
```

**Use `--base` when:**
- Working on issues for a feature integration branch
- Issue references a parent branch (e.g., "Part of dashboard feature")
- Project uses `.sequant/settings.json` with `run.defaultBase` configured
- Issues should build on an existing feature branch

**Do NOT use `--base` when:**
- Issues should branch from main (default behavior)
- Working on independent bug fixes or features

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

## State Tracking

**IMPORTANT:** `/solve` initializes issue state when analyzing issues.

### State Updates

When analyzing issues, initialize state tracking so the dashboard can show planned work:

**Initialize each issue being analyzed:**
```bash
# Get issue title
TITLE=$(gh issue view <issue-number> --json title -q '.title')

# Initialize state (if not already tracked)
npx tsx scripts/state/update.ts init <issue-number> "$TITLE"
```

**Note:** `/solve` only initializes issues - actual phase tracking happens during workflow execution (`/fullsolve`, `sequant run`, or individual skills).

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Header Box** — ASCII box with `sequant solve` and full command
- [ ] **Issues List** — Each issue with dot leaders: `#N  Title ··· labels → workflow`
- [ ] **Flags Table** — ALL five flags (-q, --chain, --qa-gate, --base, --testgen) with ✓/✗ and reasoning
- [ ] **Why Section** — 3-5 bullet points explaining decisions
- [ ] **Also Consider** — (conditional) Curated alternatives if applicable
- [ ] **Conflict Warning** — (conditional) If in-flight work overlaps
- [ ] **Line Count** — Total ≤25 lines (excluding conflict warnings)
- [ ] **Persist Prompt** — After output, prompt "Save this plan to the issues? [Y/n]"
- [ ] **Comment Posted** — If user confirms, structured comment posted to each issue with HTML markers

**DO NOT respond until all items are verified.**
