# Run Renderer

The default terminal output for `sequant run`: a live, redrawing grid on top showing per-issue state, with an append-only events log below. Use it to track concurrent issues at a glance, see which phase each is in, and pick out failures from a long run.

This is the default — nothing to enable. It replaces the older spinner + parallel-mode line output that produced duplicate and overwritten lines.

> Looking for the experimental Ink-based dashboard with one box per issue? See [Experimental TUI Dashboard](experimental-tui-dashboard.md). The Ink TUI is opt-in via `--experimental-tui`; the renderer described here is the default.

## Prerequisites

1. **`sequant run` available** — `npx sequant run --help`
2. **A terminal** — `node -e "console.log(process.stdout.isTTY)"` reports `true` for the rich live grid. Pipes and CI fall back automatically.

## Setup

No setup. The renderer is wired into `sequant run` and selects a mode based on the environment:

| Environment | Mode | What you see |
|---|---|---|
| Interactive terminal (`process.stdout.isTTY`) | **TTY renderer** | Live grid (redrawn ~1Hz) + events log |
| Pipe, redirect, CI (`!process.stdout.isTTY`) | **Non-TTY renderer** | Append-only timestamped events, 60s heartbeat |
| MCP orchestrator (`SEQUANT_ORCHESTRATOR=1`) | **Orchestrator renderer** | Silent. Only `emitProgressLine` JSON flows. |

`NO_COLOR=1` strips colors; layout is preserved.

## What You See

### Multi-issue run (TTY)

```
SEQUANT WORKFLOW · 3 issues · concurrency 3 · 14m 02s

  ┌────────┬──────────────────────────────────────────────────────────┐
  │ Issue  │ Status                                                   │
  ├────────┼──────────────────────────────────────────────────────────┤
  │ #614   │ ✔ done · 7m 27s · spec→exec→qa · PR #615                 │
  ├────────┼──────────────────────────────────────────────────────────┤
  │ #610   │ ⠋ exec · 4m 18s                                          │
  │        │   spec ✔ 3m 42s  →  exec running                         │
  │        │   claude streaming · editing src/cli.ts                  │
  ├────────┼──────────────────────────────────────────────────────────┤
  │ #606   │ ⠋ qa loop 2/3 · 1m 02s                                   │
  │        │   spec ✔  ·  exec ✔                                      │
  └────────┴──────────────────────────────────────────────────────────┘

  1 done · 2 running · 0 failed

  ── events ────────────────────────────
  ✔ #614 qa  2m 57s  →  PR #615
  ▸ #610 exec
  ▸ #606 qa (attempt 2/3)
```

- **Done** issues collapse to a single line with total time, phase chain, and PR number.
- **Running** issues expand with phase-by-phase progress and a sub-status line (Claude streaming activity, test counts, loop iteration).
- The rollup line below the table summarizes the run.
- The **events log** scrolls naturally below the live zone — one `\n`-terminated line per phase start / complete / failure / PR open. Grep-friendly.

### Single-issue run (TTY)

```
SEQUANT WORKFLOW · #614 · 7m 27s elapsed

  ┌──────────┬─────────────────────────────────────────────────────────┐
  │ Issue    │ #614 — resolve-npm-audit-findings                       │
  │ Worktree │ ../worktrees/feature/614-resolve-...                    │
  │ Branch   │ feature/614-resolve-npm-audit-findings                  │
  │ Status   │ ⠋ exec · 2m 14s                                         │
  │          │   spec ✔ 5m 13s  →  exec running  →  qa queued          │
  │          │   claude streaming · editing src/lib/audit.ts           │
  └──────────┴─────────────────────────────────────────────────────────┘
```

### Non-TTY (CI, pipes)

Append-only lines, prefixed with wall-clock time:

```
[16:03:11] ▸ #614 spec
[16:08:24] ✔ #614 spec  5m 13s
[16:08:24] ▸ #614 exec  (attempt 1/3)
[16:11:02] ✘ #614 exec  exec produced no changes
[16:11:02] ▸ #614 loop
[16:11:28] ✔ #614 loop  26s
[16:11:28] ▸ #614 exec  (attempt 2/3)
[16:11:28] ⏱ still running: #614 exec (1m)        ← 60s heartbeat
```

If no events fire for 60 seconds, a `⏱ still running: …` line emits so CI logs don't look frozen.

### Summary (end of run)

```
SUMMARY · 3 issues · 18m 41s · 2 passed · 1 failed

  ┌────────┬────────────┬──────────────────────────┬──────────┐
  │ Issue  │ Result     │ Detail                   │ Total    │
  ├────────┼────────────┼──────────────────────────┼──────────┤
  │ #614   │ ✔ passed   │ exec → qa · PR #615      │  7m 27s  │
  │ #610   │ ✔ passed   │ exec → qa · PR #616      │  9m 12s  │
  │ #606   │ ✘ failed   │ qa max-iters             │  8m 48s  │
  │        │            │ AC_NOT_MET (3 unmet)     │          │
  │        │            │ log: .../606.log         │          │
  └────────┴────────────┴──────────────────────────┴──────────┘

  Log: .sequant/logs/run-2026-05-09T16-14-29-...json
```

Passed rows are one-line; failed rows expand with reason, last-verdict summary, and log path.

## What to Expect

- **Frame cadence.** The live zone redraws on phase events and at most once per second on a timer between events. Elapsed counters keep ticking even when nothing is happening, so the screen is always alive.
- **Verbose streaming.** Running with `-v` / `--verbose` pauses the live zone while Claude's stream prints, then redraws below it on the next phase event. No interleaved garble.
- **Quiet mode (`-q`).** Renderer is disabled in quiet mode (gated at `run-progress.ts:60` on `!quiet`); the liveness heartbeat replaces it — a TTY-only rewriting line every 30s plus a one-shot stall warning at 5 minutes. See [Quiet Mode Heartbeat](quiet-mode-heartbeat.md).
- **Retries get a counter.** When a quality loop retries `exec`, the second and later attempts annotate as `(attempt 2/3)`, `(attempt 3/3)` in both the events log and the live-zone status cell (added by #624). QA loop iterations show `qa loop N/3` the same way.
- **Identical failures get folded.** If `exec` fails three times with the same error, you see the full message on attempt 1 and on the final attempt. The middle attempt shows `(attempt 2/3, same failure as attempt 1)` instead of repeating the error verbatim. Divergent failures always print in full.
- **Frame stability.** The live zone height is capped at `max(8, terminal-rows − 5)`. With more than ~10 active issues, the oldest done rows roll up to a single `✔ {n} done` line so the grid never spills past the visible terminal.
- **Narrow terminals.** Under 80 columns, the renderer drops box-drawing characters and falls back to indented `key: value` pairs. The summary table uses the same fallback.
- **Ctrl+C.** Clears the live zone before printing the cleanup messages (`Aborted N active phases…`).
- **Terminal resize.** `SIGWINCH` triggers a full redraw at the new dimensions.

## Modes & Settings

| Env / context | Effect |
|---|---|
| `process.stdout.isTTY` truthy | TTY renderer (live grid + events log) |
| `process.stdout.isTTY` falsy | Non-TTY renderer (append-only + 60s heartbeat) |
| `SEQUANT_ORCHESTRATOR=1` | Renderer is a no-op; only `emitProgressLine` JSON is emitted (MCP path) |
| `NO_COLOR=1` | Colors stripped; layout preserved |
| `SEQUANT_DEBUG_RENDERER=1` | Per-frame instrumentation emitted to **stderr** as JSON-lines (see [Debugging renderer regressions](#debugging-renderer-regressions)) |
| Terminal width `< 80` cols | Box-drawing replaced with indented key:value pairs |
| Terminal rows visible | Live-zone height auto-capped to fit; excess done rows roll up |

No CLI flags configure the renderer directly. Renderer behavior is driven by environment and the existing `run` flags (`-v`, `-q`, `--experimental-tui` to swap to Ink). See [Run Command](../reference/run-command.md) for run-level flags.

## Troubleshooting

### The grid is printing multiple times instead of redrawing in place

**Cause:** `log-update` lost track of the cursor row, typically because the frame exceeded terminal rows on an earlier draw. The height cap added in #624 prevents this in normal use.

**Fix:** Verify your terminal reports rows correctly (`tput lines`). If you're in an embedded terminal that reports `rows=0`, set `LINES` in the environment, or pipe to a file and read the non-TTY output.

### Colors look broken or boxes show garbage characters

**Cause:** Terminal doesn't support Unicode box-drawing or ANSI colors.

**Fix:** Set `NO_COLOR=1` and use a terminal at ≥80 columns. The renderer auto-falls back to indented key:value layout under 80 columns.

### Output in CI logs is just one line every 60 seconds

**Cause:** Non-TTY mode. The 60s `⏱ still running: …` heartbeat is the liveness signal when phases are long.

**Fix:** No fix needed — phase events still emit immediately when they happen. If you need richer output in CI, force-enable a PTY (e.g., `script -q /dev/null npx sequant run …`) so the TTY renderer engages.

### MCP / orchestrator shows nothing in stdout

**Cause:** When `SEQUANT_ORCHESTRATOR=1` is set, the renderer is silent on purpose — the orchestrator consumes `emitProgressLine` JSON events directly.

**Fix:** Read the JSON event stream, or unset `SEQUANT_ORCHESTRATOR` if you want human-readable output.

### Same failure error printed three times in a row

**Cause:** You're on a build before #624 was merged. The renderer now collapses repeated identical failure signatures.

**Fix:** `npm install sequant@latest` (≥ next release after v2.2.0).

### Summary table characters are corrupted at the bottom of a run

**Cause:** Pre-#624 teardown race: `displaySummary` printed before `log-update` flushed. Fixed by flushing the live zone before the summary renders.

**Fix:** Upgrade to a post-v2.2.0 build.

### Debugging renderer regressions

Set `SEQUANT_DEBUG_RENDERER=1` to capture per-callsite instrumentation for diagnosing duplicate-frame and scrollback regressions (#647). One JSON-line is emitted to **stderr** per `log-update` operation (`impl` / `clear` / `done`):

```bash
SEQUANT_DEBUG_RENDERER=1 npx sequant run 504 505 2> /tmp/debug.jsonl
```

Each record looks like:

```json
{
  "t": 1234,
  "op": "impl",
  "frame": 7,
  "rendererCols": 100,
  "rendererRows": 30,
  "stdoutCols": 100,
  "stdoutRows": 30,
  "logicalLines": 12,
  "wrappedLineCount": 12
}
```

| Field | Meaning |
|---|---|
| `t` | ms since renderer construction (monotonic) |
| `op` | `impl` (new frame), `clear` (erase live zone), `done` (finalize) |
| `frame` | monotonic counter of `impl` calls |
| `rendererCols` / `rendererRows` | what the renderer believes the terminal is |
| `stdoutCols` / `stdoutRows` | what `process.stdout` actually reports (may be `null` under `npx` / pipes) |
| `logicalLines` | newline-split count of the input text |
| `wrappedLineCount` | approximate count after `wrapAnsi`-style wrapping at `streamCols` — should match `log-update`'s `previousLineCount` |

**Divergence diagnostic:** if `wrappedLineCount` ≠ the on-terminal row count you observe, `log-update`'s `eraseLines` will under- or over-erase, leaving stale rows in scrollback (the #647 symptom).

Output goes to **stderr** so the live zone on stdout is not disrupted. Redirect with `2> debug.jsonl` and inspect with `jq -s` or grep.

---

*Documents issues #618 (unified renderer) and #624 (follow-ups: frame stability, attempt counter, summary teardown, failure dedup).*
