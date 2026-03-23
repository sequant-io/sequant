# Merger Baseline Comparison

Detects regressions during `/merger` by comparing build and test metrics before and after merge. Prevents merging PRs that introduce new build errors or test failures.

## Prerequisites

1. **sequant project initialized** — `sequant init` completed
2. **Issues ready for merge** — QA passed, PRs created

## How It Works

When `/merger` runs, it now captures a **baseline** on main before merging, then compares post-merge results against that baseline.

```
main (before merge)     →  Capture baseline: build errors, test pass/fail counts
merge PR                →  Squash merge
main (after merge)      →  Capture post-merge metrics, compare against baseline
                        →  Block if regressions detected
```

## What You Can Do

### Standard merge (regression gate active)

```bash
/merger 10
```

If post-merge has more build errors or test failures than baseline, the merge is blocked with a regression report.

### Force merge despite regressions

```bash
/merger 10 --force
```

Proceeds with an explicit warning. Use when regressions are known/acceptable (e.g., flaky tests).

### Multi-issue merge (baseline cached)

```bash
/merger 10 12 15
```

Baseline is captured once before the first merge and reused for all subsequent issues in the same invocation.

### Skip baseline and smoketest

```bash
/merger 10 --skip-smoketest
```

Skips both baseline capture and post-merge comparison.

## What to Expect

### Regression Check output

After every merge, the report includes a comparison table:

```
### Regression Check

| Metric           | Baseline (main) | Post-merge | Delta | Status            |
|------------------|-----------------|------------|-------|-------------------|
| Build errors     | 14              | 14         | 0     | ✅ No regression   |
| Test failures    | 5               | 5          | 0     | ✅ No regression   |
| Test passes      | 1628            | 1630       | +2    | ✅ Tests added     |
```

### When regressions are detected

The merge is blocked and you see:

```
❌ REGRESSION DETECTED — merge is blocked.

New build errors: 2
New test failures: 1

To override this gate, re-run with --force:
  /merger <issues> --force
```

### Pre-existing failures

Failures that match baseline are reported separately as pre-existing — they don't block the merge:

```
### ℹ️ Pre-existing Failures (not regressions)

| Check  | Status           | Notes                          |
|--------|------------------|--------------------------------|
| Build  | ⚠️ 14 errors      | Same as baseline — pre-existing |
| Tests  | ⚠️ 5 failures     | Same as baseline — pre-existing |
```

## Reference

### Flags

| Flag | Description |
|------|-------------|
| `--force` | Bypass regression gate (merge proceeds with warning) |
| `--skip-smoketest` | Skip baseline capture and post-merge comparison entirely |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SEQUANT_MERGER_FORCE` | Same as `--force` flag |
| `SEQUANT_MERGER_SKIP_SMOKETEST` | Same as `--skip-smoketest` flag |

## Troubleshooting

### Baseline capture is slow

**Symptoms:** `/merger` takes longer than expected before starting the actual merge.

**Cause:** Baseline runs `npm run build` and `npm test` on main, which can take 1-2 minutes.

**Solutions:**
- For multi-issue merges, baseline is captured once and cached — subsequent merges are faster
- Use `--skip-smoketest` if you've already verified main is clean

### False regression from flaky tests

**Symptoms:** Regression detected but the failing test passes on re-run.

**Solution:** Re-run `/merger` — the baseline will capture fresh counts. If the flaky test still causes issues, use `--force` and note the flaky test for follow-up.

### Regression gate blocks a valid merge

**Symptoms:** New test failures reported, but they're expected (e.g., test was updated in the PR).

**Solution:** Use `--force` to proceed. The regression report will include the acknowledgment in the output for audit trail.

---

*Generated for Issue #397 on 2026-03-23*
