# QA Incremental Re-Runs

When `/qa` is re-run on an issue that already has QA findings, sequant detects what changed since the last QA run and skips checks whose inputs haven't changed. This reduces token usage and execution time on iterative QA cycles.

## Prerequisites

1. **QA cache enabled** (default) — the `.sequant/.cache/qa/` directory must exist
2. **Prior QA run** — at least one `/qa` must have completed on the issue, with a phase marker containing a `commitSHA`

## How It Works

On each QA run, sequant saves a **run context** to the cache:

- The HEAD commit SHA at the time of the QA run
- The diff hash at that point
- The AC status for each acceptance criterion (met, not_met, partially_met)

On subsequent runs, sequant compares the current state to the saved context and decides what to skip.

## What Gets Skipped vs Re-Run

| Check / Item | Skip Condition | Always Re-Run? |
|-------------|----------------|----------------|
| Quality checks (type-safety, security) | Diff hash unchanged | No — cached if unchanged |
| Build verification | Never skip | Yes — cheap and can regress |
| CI status | Never skip | Yes — external state changes |
| AC items previously `MET` | No file changes since last QA | No — cached if unchanged |
| AC items previously `NOT_MET` | Never skip | Yes — primary purpose of re-runs |
| AC items previously `PARTIALLY_MET` | Never skip | Yes |

## What You Can Do

**Normal re-run** — just run `/qa` again on the same issue. Incremental mode activates automatically when prior findings exist.

**Force a full re-run** — use `--no-cache` to skip all caching and re-evaluate everything from scratch:
```
sequant run --phase qa --no-cache <issue>
```

**Inspect the cached run context:**
```bash
npx tsx scripts/qa/qa-cache-cli.ts get-run-context
```

**Check what files changed since the last QA:**
```bash
npx tsx scripts/qa/qa-cache-cli.ts changed-since <commit-sha>
```

**Clear all QA cache data (including run context):**
```bash
npx tsx scripts/qa/qa-cache-cli.ts clear
```

## What to Expect

When incremental mode activates, the QA output includes an **Incremental QA Summary** section at the top:

```
### Incremental QA Summary

**Last QA:** 2025-01-15T12:00:00Z (commit: abc123d)
**Changes since last QA:** 3 files

| Check / AC | Status | Re-run? | Reason                         |
|------------|--------|---------|--------------------------------|
| type-safety| PASS   | Cached  | Diff hash unchanged            |
| security   | PASS   | Cached  | Diff hash unchanged            |
| build      | PASS   | Re-run  | Always fresh                   |
| CI status  | PASS   | Re-run  | Always fresh                   |
| AC-1       | MET    | Cached  | Previously MET, no file changes|
| AC-2       | MET    | Re-eval | Was NOT_MET                    |

**Summary:** 3 checks cached, 2 re-evaluated, 2 always-fresh
```

## CLI Commands Reference

The `qa-cache-cli.ts` script gained three new commands for run context management:

| Command | Description |
|---------|-------------|
| `set-run-context` | Save QA run context (reads JSON from stdin) |
| `get-run-context` | Get last QA run context as JSON (exit 1 if not found) |
| `changed-since <sha>` | List files changed since a commit SHA (prints `NO_CHANGES` if none) |

## Troubleshooting

### Re-run still evaluates everything

**Symptoms:** QA output shows no "Incremental QA Summary" section and all checks are re-evaluated.

**Solution:** The prior QA phase marker may not contain a `commitSHA`. QA runs before this feature was added don't include the commit SHA. Run one full QA cycle — subsequent re-runs will be incremental.

### "Last QA commit SHA not found in history"

**Symptoms:** Warning message appears and QA falls back to a full run.

**Solution:** This happens when the branch was rebased or force-pushed since the last QA, invalidating the cached commit SHA. The full run will establish a new baseline.

---

*Generated for Issue #377 on 2026-03-25*
