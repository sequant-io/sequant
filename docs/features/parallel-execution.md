# Parallel Execution

When you pass multiple issues to `sequant run`, they now run concurrently by default. This reduces wall-clock time from the sum of all issues to roughly the duration of the slowest one (bounded by your concurrency limit).

## Prerequisites

1. **sequant installed** — `npx sequant --version`
2. **Multiple issues to run** — at least 2 issue numbers

## Quick Start

```bash
# Run 3 issues in parallel (default concurrency: 3)
sequant run 100 101 102

# Limit to 2 concurrent issues
sequant run 100 101 102 --concurrency 2

# Force sequential (old behavior, stops on first failure)
sequant run 100 101 102 --sequential
```

## What to Expect

**During execution**, you see two levels of progress:

**Issue-level progress line** — updates as each issue finishes:

```
  Progress: #100 ⏳  #101 ⏳  #102 ⏳
```

**Per-phase progress lines** — print as each phase starts and completes:

```
  ● #100: spec started
  ● #101: spec started
  ● #102: spec started
  ● #101: spec ✓ (4m 6s)
  ● #100: spec ✓ (5m 12s)
  ● #102: spec ✗
  ● #101: exec started
  ● #100: exec started
```

**Heartbeat timer** — if no phase events fire for 60 seconds, a heartbeat line prints so the terminal never appears frozen:

```
  ⏳ Still running... (3m 15s elapsed)
```

As each issue completes, a summary line prints:

```
  ✓ Issue #100 completed (12m 15s)
  ✗ Issue #101 failed (45s): Phase exec failed
  Progress: #100 ✓  #101 ✗  #102 ⏳
```

**Output isolation:** Per-issue spinners and phase details are suppressed in parallel mode to prevent garbled terminal output. Each issue's structured log is written to its own entry in the JSON log file. Progress lines use atomic `console.log()` calls so they never interleave.

**On Ctrl-C:** All running issues are stopped immediately. Each concurrent issue's agent process receives an abort signal, and cleanup tasks (worktree removal, log finalization) run in order.

## Execution Modes

| Command | Mode | Behavior |
|---------|------|----------|
| `sequant run 100 101 102` | Parallel (default) | All issues run concurrently; failures don't stop others |
| `sequant run 100 101 --concurrency 1` | Parallel with limit 1 | Effectively serial, but continues on failure |
| `sequant run 100 101 --sequential` | Sequential | Serial execution; stops on first failure |
| `sequant run 100 101 --chain` | Chain | Sequential; each issue branches from the previous |

## Configuration

### CLI Flag

```bash
sequant run 100 101 102 --concurrency 5
```

### Settings File (`.sequant/settings.json`)

```json
{
  "run": {
    "concurrency": 5,
    "sequential": false
  }
}
```

### Priority Order

CLI flag > `settings.json` > default (3)

### `--concurrency` Reference

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `--concurrency <n>` | integer | No | 3 | Maximum number of issues running simultaneously |

**Validation:** Must be a positive integer. Values less than 1 or non-integers produce a clear error:

```
❌ Invalid --concurrency value: 0. Must be a positive integer.
```

## How It Works (High Level)

1. Worktrees are created for all issues upfront (one per issue)
2. Issues are dispatched via `Promise.allSettled` with a `p-limit` concurrency gate
3. Each issue runs through its full phase pipeline (spec → exec → qa) independently
4. Log data is routed to the correct issue via the LogWriter's Map-based tracking
5. Results are collected after all promises settle

## Choosing Between Parallel and Chain Mode

Parallel worktrees are the default for multi-issue runs. Chain mode (`--chain`) is available for dependent issues but has trade-offs.

### Success Rate Comparison

| Mode | Success Rate | Sample Size | Notes |
|------|-------------|-------------|-------|
| Single issue | 72% | n=50+ | Baseline |
| Parallel | 67% | n=50+ | Close to single-issue baseline |
| Chain (`--chain`) | 50% | n=4 | Small sample, but failure compounding is structural |

### Trade-offs

| Dimension | Parallel (default) | Chain (`--chain`) |
|-----------|-------------------|-------------------|
| **Failure isolation** | Issues fail independently | One failure stops the chain |
| **Merge complexity** | Each PR merges to main independently | PRs must merge in order |
| **Code review** | Smaller, focused PRs | Later PRs include prior changes |
| **Recovery** | Re-run single failed issue | May need to re-run entire chain |
| **Speed** | Concurrent execution | Sequential only |

### When to Use Each Mode

**Use parallel (default)** when:
- Issues are independent or loosely related
- You want maximum throughput
- You want failure isolation (one issue failing doesn't block others)

**Use chain (`--chain`)** when:
- Issues have explicit dependencies (issue B builds on issue A's code)
- You're building a feature incrementally (auth → login → logout)
- You need each issue to see the previous issue's changes

### Spec Phase Reliability

The spec phase has a higher transient failure rate (~8.6%) than other phases, primarily due to GitHub API rate limits and transient network issues. To mitigate this, `sequant run` includes automatic spec retry with a 5-second backoff. This is enabled by default when `retry: true` (the default) and applies only to the spec phase.

To disable all retries:
```bash
sequant run 42 --no-retry
```

## Troubleshooting

### Terminal output looks garbled

**Symptoms:** Overlapping text, broken spinner characters

**Solution:** This should not happen in parallel mode (spinners are suppressed). If you see garbled output, check whether `--verbose` is enabled — verbose mode streams raw agent output which can interleave. Remove `--verbose` for clean parallel output.

### One issue's failure stops everything

**Symptoms:** Expected parallel continue-on-failure, but execution stopped

**Solution:** Ensure you are NOT using `--sequential` or `--chain`. Both flags force serial execution with stop-on-failure. Without these flags, `Promise.allSettled` ensures all issues complete regardless of individual failures.

### Ctrl-C only stops one issue

**Symptoms:** After pressing Ctrl-C, some issues keep running

**Solution:** This was fixed in the concurrent shutdown implementation. All registered abort controllers are aborted on SIGINT. If you still see this, press Ctrl-C a second time to force-exit immediately.

### No progress output in CI / piped output

**Symptoms:** No output until the final summary when running in CI or piping to a file

**Solution:** Per-phase progress lines and heartbeat use `console.log` and work in both TTY and non-TTY environments. The issue-level progress bar uses `\r` (carriage return) which requires a TTY — in non-TTY environments it falls back to per-completion lines. Use `--sequential` for full phase details per issue.

---

*Updated for Issue #458 on 2026-03-26 (per-phase progress lines, heartbeat timer)*
*Updated for Issue #452 on 2026-03-26 (parallel vs chain decision framework, spec retry)*
*Generated for Issue #404 on 2026-03-24*
