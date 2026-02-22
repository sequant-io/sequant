# Merge Command

**Quick Start:** Run batch-level integration checks on feature branches after `sequant run` completes. Catches cross-issue gaps that per-issue QA misses — merge conflicts, template mirroring gaps, residual patterns, and file overlaps — at zero AI cost.

## Access

- **Command:** `npx sequant merge [issues...] [options]`
- **Requirements:**
  - Feature branches exist (pushed to remote or in local worktrees)
  - GitHub CLI authenticated (`gh auth login`) for `--post` flag
- **Relationship:** Runs AFTER `sequant run`, BEFORE `/merger`

```text
sequant run 265 298 299 300   # implement
sequant merge --check         # verify (this command)
/merger 265 298 299 300       # merge
```

## Usage

### Check a Completed Batch

```bash
npx sequant merge 265 298 299 300 --check
```

Runs Phase 1 deterministic checks: combined branch test, template mirroring, and file overlap detection.

### Auto-Detect Issues from Last Run

```bash
npx sequant merge --check
```

Reads the most recent run log from `.sequant/logs/` and auto-detects which issues to check.

### Full Scan with Residual Pattern Detection

```bash
npx sequant merge 265 298 299 300 --scan
```

Runs Phase 1 + Phase 2: adds residual pattern detection that finds instances of removed code patterns still present elsewhere in the codebase.

### Post Results to GitHub

```bash
npx sequant merge 265 298 299 300 --check --post
```

Posts per-issue merge readiness reports as comments on each PR.

## Options & Settings

| Option | Description | Default |
|--------|-------------|---------|
| `--check` | Run Phase 1 deterministic checks | Default if no flag specified |
| `--scan` | Run Phase 1 + Phase 2 residual pattern detection | - |
| `--review` | Run Phase 1 + 2 + 3 AI briefing (stub) | - |
| `--all` | Run all phases | - |
| `--post` | Post report to GitHub as PR comments | - |
| `--json` | Output as JSON (for scripting) | - |
| `-v, --verbose` | Enable verbose output | - |

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All checks pass (READY) |
| `1` | Warnings found (NEEDS_ATTENTION) |
| `2` | Failures found (BLOCKED) |

## Checks Performed

### Phase 1: Deterministic Checks (`--check`)

| Check | What It Does | Verdict |
|-------|-------------|---------|
| **Combined Branch Test** | Creates temp branch, merges all feature branches, runs `npm test && npm run build` | FAIL if merge conflict or test/build failure |
| **Template Mirroring** | Verifies `.claude/skills/` changes have matching `templates/skills/` updates (and vice versa for `hooks/`) | WARN if unmirrored changes found |
| **File Overlap Detection** | Flags files modified by multiple issues in the batch, classifies as additive vs conflicting | WARN if overlaps found |

### Phase 2: Residual Pattern Detection (`--scan`)

| Check | What It Does | Verdict |
|-------|-------------|---------|
| **Residual Pattern Scan** | Extracts removed patterns from each PR's diff, searches codebase for remaining instances | WARN if residuals found |

The residual scan uses literal string matching (minimum 8 characters) with `git grep`. It excludes files already modified by the PR, test files, and `node_modules`.

### Phase 3: AI Briefing (`--review`)

Not yet implemented. Returns a stub message directing you to use `--check` or `--scan`.

## Common Workflows

### Standard Post-Run Verification

After `sequant run` completes a batch:

```bash
# 1. Run merge checks
npx sequant merge --scan

# 2. Review the report
#    READY       → safe to merge
#    NEEDS_ATTENTION → review warnings
#    BLOCKED     → fix before merging

# 3. Merge passing issues
/merger 265 298 299 300
```

### Scripted CI Integration

Use JSON output and exit codes for automation:

```bash
npx sequant merge --check --json > report.json
exit_code=$?

if [ $exit_code -eq 0 ]; then
  echo "All clear to merge"
elif [ $exit_code -eq 1 ]; then
  echo "Warnings found — review report.json"
else
  echo "Blocked — fix issues before merging"
fi
```

### Post Findings to PRs

Share results with reviewers by posting to GitHub:

```bash
npx sequant merge 265 298 299 300 --scan --post
```

Each PR receives a per-issue report showing its specific findings and the batch-level verdict.

## Report Format

### Markdown Output (default)

```text
# Merge Readiness Report

**Generated:** 2026-02-21T19:30:00.000Z
**Batch Verdict:** NEEDS_ATTENTION

## Per-Issue Verdicts

| Issue | Title | Verdict |
|-------|-------|---------|
| #265 | Audit skill files | WARN |
| #298 | Add test tautology | PASS |

## Combined Branch Test
- npm test passed on combined state
- npm run build passed on combined state

## Mirroring
- Modified .claude/skills/qa/SKILL.md but not templates/skills/qa/SKILL.md

## Overlap Detection
- src/commands/run.ts modified by issues #298, #299 (additive)

## Summary
- Errors: 0
- Warnings: 2
- Issues in batch: 4
- Checks run: 3
```

### JSON Output (`--json`)

Returns structured JSON with all check results, per-issue verdicts, and the batch verdict. Useful for scripting and CI integration.

## Verdicts

### Per-Issue

| Verdict | Meaning |
|---------|---------|
| **PASS** | No issues found for this issue |
| **WARN** | Warnings found (mirroring gaps, residuals, overlaps) |
| **FAIL** | Critical issues (merge conflicts, test/build failures) |

### Batch-Level

| Verdict | Meaning | Exit Code |
|---------|---------|-----------|
| **READY** | All issues pass, safe to merge | `0` |
| **NEEDS_ATTENTION** | Warnings found, review before merging | `1` |
| **BLOCKED** | Critical failures, fix before merging | `2` |

## Troubleshooting

### "No run logs found"

**Symptoms:** Error when running `sequant merge` without issue numbers.

**Solution:** Either specify issues explicitly or run `sequant run` first to generate a run log:
```bash
# Explicit issues
npx sequant merge 265 298 --check

# Or run first
npx sequant run 265 298
npx sequant merge --check
```

### "No feature branches found"

**Symptoms:** Error saying no branches found for specified issues.

**Solution:** Ensure feature branches exist — either pushed to remote or in local worktrees:
```bash
# Check remote branches
git branch -r | grep feature/265

# Check worktrees
git worktree list
```

### Combined branch test reports merge conflict

**Symptoms:** BLOCKED verdict due to merge conflict between feature branches.

**Solution:** This means two feature branches modify the same file in incompatible ways. Options:
1. Merge one branch first, then rebase the other
2. Manually resolve the conflict before merging both
3. If the conflict is in auto-generated files, it may resolve after merging one branch

### Mirroring warnings for intentional divergences

**Symptoms:** WARN for a `.claude/skills/` file that intentionally differs from `templates/skills/`.

**Solution:** Mirroring warnings are advisory. If the divergence is intentional (e.g., project-specific paths), note it in your PR description and proceed with merge.

## See Also

- [Run Command](./run-command.md) - Execute the full workflow
- [Workflow Phases](../concepts/workflow-phases.md) - Understanding spec/exec/qa
- [Worktree Isolation](../concepts/worktree-isolation.md) - How feature branches work

---

*Generated for Issue #313 on 2026-02-22*
