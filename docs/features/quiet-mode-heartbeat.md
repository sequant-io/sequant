# `-q` Mode Liveness Heartbeat & Stall Warning

`sequant run -q` used to go silent for the entire duration of each phase — sometimes 15+ minutes — with no way to tell "agent working" from "process hung" short of digging through `ps`, `lsof`, and `state.json`. The heartbeat fixes that with two thin signals: a TTY-only liveness line that ticks during long phases, and a one-shot warning (TTY and non-TTY) when an in-progress phase shows no activity for 5 minutes.

## Prerequisites

1. **`sequant run` available** — `npx sequant run --help`
2. **Run with `-q` (or `--quiet`)** — the heartbeat is gated to `-q`. Default verbose mode already prints per-phase progress lines, so it does nothing.
3. **`.sequant/state.json` is being written** — this happens automatically during any run; the heartbeat reads its mtime as the activity proxy.

## Setup

No setup. The heartbeat is on by default whenever `sequant run -q` runs without `--experimental-tui`. There is no flag to enable or configure it.

```bash
# Heartbeat active (TTY: liveness line + stall warning; non-TTY: stall warning only)
npx sequant run 551 559 -q

# Heartbeat NOT active (TUI handles its own liveness)
npx sequant run 551 559 -q --experimental-tui

# Heartbeat NOT active (verbose progress lines render every phase event)
npx sequant run 551 559
```

## What You Can Do

- **Tell "working" from "hung" in a TTY.** A long phase under `-q` rewrites a single line every 30s with elapsed time and how recently `state.json` was last touched.
- **Get a written warning when something stalls.** If `state.json` mtime hasn't advanced for 5 minutes during an in-progress phase, the heartbeat emits one warning to stderr — even when stdout is piped to a file or CI log.
- **Keep CI logs clean.** Non-TTY runs (CI, redirected output) get the stall warning only — no scroll-spam from periodic heartbeats.
- **Trust the no-news case.** No warning fired and the rewriting line keeps ticking? The phase is genuinely making progress.

## What to Expect

**TTY, in `-q`, normal phase progress.** Every 30s the active phase line is rewritten in place using `\r`:

```
  ▸ #551  exec  (12m elapsed, last log update 8s ago)
```

The line stays on a single row — no scrolling — and is overwritten on each tick. When the phase completes, the existing `✔ #551 exec  17m 20s` line replaces it.

**Either TTY or non-TTY, when a phase stalls.** Once `now - state.json mtime` crosses 5 minutes for an in-progress phase, exactly one warning is written to stderr:

```
  ⚠ #551  exec  no log activity for 5m 12s (phase timeout in 24m 48s)
```

The warning fires once per stall window. If `state.json` is touched again, the warning state resets — a subsequent stall would warn again. The "phase timeout in N" suffix only appears if the run knows the configured phase timeout.

**Non-TTY, normal progress.** No output. The heartbeat is silent unless something stalls. Pipe-to-file and CI runs see exactly what they used to see, plus the one-shot stall warning when applicable.

**Cadence and overhead.** Single `fs.stat` on `.sequant/state.json` every 30s. No-op when no phase is active.

**Interaction with shutdown.** Ctrl+C tears the heartbeat timer down via `ShutdownManager` before any post-run output prints — no orphaned ticks, no terminal corruption.

## Reference

The heartbeat is automatic, not flag-driven. Behavior is determined by the matrix below.

| Mode | TTY heartbeat line | Stall warning |
|------|--------------------|---------------|
| `-q` (TTY) | Yes — rewrites every 30s | Yes — once per stall window |
| `-q` (non-TTY: pipe, redirect, CI) | No | Yes — once per stall window |
| `-q --experimental-tui` | No (TUI owns liveness) | No (TUI surfaces its own activity) |
| Default verbose (`sequant run` without `-q`) | No (per-phase progress lines exist) | No |

| Constant | Default | Source |
|----------|---------|--------|
| Poll interval | 30s | `DEFAULT_POLL_INTERVAL_MS` |
| Stall threshold | 5 minutes | `DEFAULT_STALL_THRESHOLD_MS` |
| Activity proxy file | `.sequant/state.json` | `DEFAULT_LIVENESS_FILE` |

These are not user-configurable from the CLI. They live in `src/lib/workflow/heartbeat.ts` and are overridable only from tests.

## Troubleshooting

### `-q` run still feels silent — no rewriting line appears

**Cause:** Either stdout is not a TTY (running under CI, redirected to a file, piped through another command), or the run is using `--experimental-tui`. Both intentionally suppress the rewriting line.

**Fix:** Run in an interactive terminal without `--experimental-tui`. Verify TTY with:

```bash
node -e "console.log(process.stdout.isTTY)"
# expect: true
```

If you need a live signal under `--experimental-tui`, the dashboard's per-issue activity stamp is the equivalent.

### Heartbeat line keeps ticking but I'm sure the phase is hung

**Cause:** The heartbeat reads `.sequant/state.json` mtime, which `StateManager.saveState()` writes 3–10 times per phase. If the phase is making _any_ kind of progress that touches state, the mtime advances and the stall warning will not fire — but progress can still be slow.

**Fix:** Watch the "last log update" portion of the line. Continuous values under ~30s mean active state writes. If "last log update" climbs but stays under 5 minutes, the run is alive but the phase is between checkpoints. To inspect what the agent is actually doing, `tail -f` the per-phase log under `.sequant/logs/`.

### Stall warning fired during a legitimately long phase

**Cause:** Some phases (large diffs, multi-step `/spec` reviews) have legitimate periods over 5 minutes between state writes.

**Fix:** The warning is informational only — nothing is killed or skipped. If "last log update" eventually drops back under 30s, the phase resumed and the warning state was already reset for the next stall window. If the warning was misleading for your workload, raise an issue with the phase name and approximate workload size.

### Heartbeat appears in non-TTY logs

**Cause:** Should not happen for the rewriting line — only the stall warning prints in non-TTY mode, by design.

**Fix:** If you're seeing rewriting `\r` lines in a captured log, the capturing tool is presenting an interactive TTY to the child process (`script`, certain terminal multiplexers, some CI integrations). Pipe through `cat` or run in a true non-TTY context to suppress.

### Want to disable the heartbeat entirely

**Cause:** Heartbeat noise in scripted scenarios where even the stall warning is unwanted.

**Fix:** No CLI flag exists today. Either use `--experimental-tui` (suppresses the heartbeat in favor of the dashboard) or drop `-q` (verbose mode also suppresses it). Filing a flag-level opt-out is reasonable if your use case can't use either.

---

*Generated for Issue #574 on 2026-05-06*
