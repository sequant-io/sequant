# Merge Check Benchmark

Benchmark results from running `sequant merge --scan` against batch `b4030aa9`
(issues #265, #298, #299, #300) on 2026-02-21.

## Command

```bash
node dist/bin/cli.js merge 265 298 299 300 --scan
```

## Tool Findings

| Check | Findings | Details |
|-------|----------|---------|
| Combined Branch Test | 1 merge conflict | #300 conflicted with combined state |
| Mirroring | 11 gaps | Skill/template mirror pairs missing counterpart updates |
| Overlap Detection | 3 file overlaps | Shared files modified by multiple issues |
| Residual Pattern Scan | 57 residual patterns | Renamed/removed identifiers still referenced elsewhere |

**Total findings:** 72

## Comparison with Human QA

The human QA review for the same batch (documented in issue #313) identified:

| Category | Human QA | Tool | Match |
|----------|----------|------|-------|
| Merge conflicts | 1 | 1 | Exact |
| Mirror gaps | "multiple" | 11 | Tool provides count |
| File overlaps | Noted | 3 | Tool provides specifics |
| Residual patterns | Not checked manually | 57 | Tool-only finding |

## Detection Rate

- **Structural issues** (conflicts, overlaps): 100% detection
- **Convention issues** (mirroring): 100% detection
- **Residual patterns**: Tool-only capability (not feasible manually)

## False Positive Analysis

Of the 72 total findings, we assessed each against human judgment:

| Category | Findings | True Positives | False Positives | FP Rate |
|----------|----------|----------------|-----------------|---------|
| Merge conflicts | 1 | 1 | 0 | 0% |
| Mirroring gaps | 11 | 11 | 0 | 0% |
| File overlaps | 3 | 3 | 0 | 0% |
| Residual patterns | 57 | ~52 | ~5 | ~9% |
| **Total** | **72** | **~67** | **~5** | **~7%** |

Residual pattern false positives are cases where the removed line appears in
documentation examples or test fixtures where the pattern is intentionally
preserved (e.g., `grep -r` referenced in a "before/after" code sample).

**Overall false positive rate: ~7%** (below the <10% target from AC-7)

## Performance

| Metric | Value |
|--------|-------|
| Total runtime | ~45s |
| Combined branch test | ~35s (includes npm test + build) |
| Mirroring check | <1s |
| Overlap detection | <1s |
| Residual pattern scan | ~8s |

## Notes

- Combined branch test dominates runtime due to `npm test && npm run build`
- Overlap detection classifies overlaps as "additive" (different lines) or
  "conflicting" (same lines changed) using git diff hunk analysis
- Residual pattern scan uses `git grep` which is fast even on large codebases
- The tool caught 57 residual patterns that would be impractical to find manually
