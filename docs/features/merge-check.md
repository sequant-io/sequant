# Batch Integration QA with `sequant merge`

**Quick Start:** Run `sequant merge` to check feature branches from a `sequant run` batch for integration issues (merge conflicts, mirroring gaps, file overlaps, residual patterns) before human review.

## Access

- **Command:** `npx sequant merge [issues...]`
- **Requires:** Git repository with feature branches from a `sequant run` batch
- **Added in:** v1.15.4

## Usage

### Auto-Detect from Latest Run

Run without arguments to auto-detect issues from the most recent `sequant run` batch:

```bash
npx sequant merge
# Reads latest run log from .sequant/runs/
# Resolves branches for all issues in the batch
# Runs Phase 1 deterministic checks
```

### Specify Issues Manually

Provide issue numbers to check specific branches:

```bash
npx sequant merge 265 298 299 300
```

### Phase Flags

Control which checks run using phase flags:

```bash
# Phase 1 only: deterministic checks (default)
npx sequant merge --check

# Phase 1 + 2: adds residual pattern detection
npx sequant merge --scan

# Phase 1 + 2 + 3: adds AI briefing (stub)
npx sequant merge --review

# All phases
npx sequant merge --all
```

### Post Reports to GitHub

Use `--post` to post scoped reports as comments on each issue's PR:

```bash
npx sequant merge --check --post
# Posts a per-issue filtered report to each PR
```

Each PR receives only findings relevant to its issue, plus the overall batch verdict.

### JSON Output

Use `--json` for machine-readable output:

```bash
npx sequant merge --json | jq '.batchVerdict'
```

## Options & Settings

| Option | Description | Default |
|--------|-------------|---------|
| `--check` | Run Phase 1 deterministic checks | Default if no flag |
| `--scan` | Run Phase 1 + Phase 2 residual pattern detection | Off |
| `--review` | Run Phase 1 + 2 + 3 AI briefing (stub) | Off |
| `--all` | Run all phases | Off |
| `--post` | Post report to GitHub PRs | Off |
| `--json` | Output as JSON | Off |
| `-v, --verbose` | Enable verbose output | Off |

## Checks Performed

### Phase 1: Deterministic Checks (--check)

| Check | What It Detects |
|-------|----------------|
| **Combined Branch Test** | Merge conflicts when all feature branches are combined onto main |
| **Mirroring** | Unmirrored changes between paired directories (e.g., `.claude/skills` and `templates/skills`) |
| **Overlap Detection** | Files modified by multiple issues, classified as "additive" (different lines) or "conflicting" (same lines) |

### Phase 2: Residual Pattern Detection (--scan)

| Check | What It Detects |
|-------|----------------|
| **Residual Scan** | Patterns removed by one issue that still appear elsewhere in the codebase (e.g., old API calls, deprecated patterns) |

### Phase 3: AI Briefing (--review)

Not yet implemented. Currently outputs a stub message.

## Common Workflows

### Post-Run Integration Check

After completing a batch of issues with `sequant run`:

1. Run `npx sequant merge` to auto-detect the batch
2. Review the report for conflicts and warnings
3. Address any BLOCKED or NEEDS_ATTENTION findings
4. Re-run after fixes to confirm READY status

### CI Integration

Use `--json` and exit codes for CI pipelines:

```bash
npx sequant merge --check --json
# Exit 0 = READY
# Exit 1 = NEEDS_ATTENTION
# Exit 2 = BLOCKED
```

### Pre-Merge Review with GitHub Comments

Before merging a batch of PRs:

```bash
npx sequant merge --scan --post
# Runs all deterministic checks + residual scan
# Posts per-issue reports to each PR
```

## Report Format

The report includes:

- **Branch Summary:** Issues, branches, and file counts
- **Per-Check Results:** Pass/fail with detailed findings
- **File Overlaps:** Which files are modified by multiple issues, and whether changes are additive or conflicting
- **Per-Issue Verdicts:** PASS, WARN, or FAIL for each issue
- **Batch Verdict:** READY, NEEDS_ATTENTION, or BLOCKED

### Verdict Meanings

| Verdict | Meaning | Action |
|---------|---------|--------|
| READY | No issues found | Safe to merge |
| NEEDS_ATTENTION | Warnings found (e.g., overlaps, mirroring gaps) | Review warnings before merging |
| BLOCKED | Critical issues found (e.g., merge conflicts) | Must fix before merging |

## Troubleshooting

### "No branches found" error

**Symptoms:** Command exits with "No valid branches found for the given issues."

**Solution:** Verify that feature branches exist for the specified issues. Check with `git branch -a | grep feature/`. If using auto-detect, ensure a run log exists in `.sequant/runs/`.

### Overlap shown as "additive" but merge still fails

**Symptoms:** Report shows additive overlap for a file, but git merge conflicts occur.

**Solution:** Overlap classification compares line ranges from diffs. If changes are on adjacent lines, they may be classified as additive but still cause context-based merge conflicts. Use `--verbose` for detailed line-range information.

### Residual scan reports too many patterns

**Symptoms:** `--scan` reports many residual patterns that are false positives.

**Solution:** The residual scanner extracts patterns from removed lines in diffs. Short strings, common identifiers, and import statements are filtered automatically. Review the patterns and ignore those that are clearly coincidental matches.

---

*Generated for Issue #313 on 2026-02-22*
