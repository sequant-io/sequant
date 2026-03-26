# Error Capture for Phase Failures

Automatically captures and categorizes the last 50 lines of stderr/stdout when a workflow phase fails, replacing generic "exited with code 1" messages with actionable diagnostics.

## Prerequisites

1. **Sequant CLI** — `npx sequant --version`
2. **Run logs enabled** — `logJson: true` in `.sequant/settings.json` (default)

## What Changed

Previously, 60% of phase failures showed only "Claude Code process exited with code 1" with no indication of the actual cause. Now every failed phase captures:

- **stderr tail** — last 50 lines of stderr output
- **stdout tail** — last 50 lines of stdout output
- **exit code** — process exit code (Aider driver only; Claude Code SDK does not expose this)
- **error category** — one of: `context_overflow`, `api_error`, `hook_failure`, `build_error`, `timeout`, `unknown`

## What You Can Do

### View error context for failed runs

```bash
# Show failed runs with error category and last 5 stderr lines
sequant logs --failed

# Show full stderr tail (all 50 lines) for detailed diagnosis
sequant logs --failed --verbose
```

### See failure breakdowns in stats

```bash
# Failures are now grouped by category instead of truncated error strings
sequant stats
```

Example output in the "Common Failures" section:

```
exec: [context_overflow]    12
exec: [api_error]            8
exec: [build_error]          5
spec: [timeout]              3
exec: [unknown]             15
```

### Read error context in JSON logs

```bash
sequant logs --failed --json
```

Each failed phase includes an `errorContext` object:

```json
{
  "phase": "exec",
  "status": "failure",
  "error": "Process exited with code 1",
  "errorContext": {
    "stderrTail": ["error TS2304: Cannot find name 'foo'.", "..."],
    "stdoutTail": ["Building..."],
    "exitCode": 1,
    "category": "build_error"
  }
}
```

## Error Categories

| Category | Matched Patterns | Typical Cause |
|----------|-----------------|---------------|
| `context_overflow` | "context window", "token limit" | Prompt or conversation exceeded model context |
| `timeout` | "timeout", "timed out", "SIGTERM" | Phase exceeded `phaseTimeout` setting |
| `api_error` | "rate limit", "429", "503", "unauthorized" | API rate limit, outage, or auth failure |
| `hook_failure` | "hook fail", "pre-commit", "HOOK_BLOCKED" | Git hook blocked a commit |
| `build_error` | "TS2304", "syntax error", "cannot find module", "npm ERR!" | TypeScript, build, or lint failure |
| `unknown` | (no match) | Unrecognized error — check stderr tail for details |

Categories are checked in priority order (first match wins). The classifier scans all captured stderr lines against each category's patterns before moving to the next.

## What to Expect

- **No action required** — error capture is automatic for all `sequant run` executions
- **Backward compatible** — old run logs without `errorContext` continue to display normally
- **Storage** — `errorContext` is stored in the same JSON run log files under `.sequant/logs/`
- **No performance impact** — uses a fixed-size ring buffer (50 lines), no unbounded memory growth

## Troubleshooting

### All failures show category "unknown"

The error classifier uses pattern matching on stderr. If your failures don't match any known pattern, they classify as "unknown." Check the stderr tail for the actual error — it may suggest a new category pattern is needed.

### No error context shown for Claude Code failures

The Claude Code SDK communicates via JSON messages, not a subprocess. Stderr captures SDK diagnostic output (which usually contains useful error info), but `exitCode` will always be empty for Claude Code phases. This is expected — use the `category` and `stderrTail` fields instead.

### Verbose flag shows same output as default

If stderr tail has 5 or fewer lines, `--verbose` output is identical to default. The flag only makes a difference when more than 5 lines were captured.

---

*Generated for Issue #447 on 2026-03-26*
