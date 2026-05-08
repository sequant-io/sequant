# Live Multi-Issue TUI Dashboard

A live, in-terminal dashboard that renders one box per issue while `sequant run` works through them concurrently. Use it when running multiple issues in parallel and you want to see at a glance which issue is in which phase, what each one is doing right now, and whether anything has stalled. Ships behind `--experimental-tui`; existing linear output is unchanged when the flag is omitted.

## Prerequisites

1. **`sequant run` available** — `npx sequant run --help`
2. **TTY stdout** — the dashboard auto-falls back to linear output when stdout is piped (e.g. `| tee`, CI logs). Verify with `node -e "console.log(process.stdout.isTTY)"`
3. **At least one issue passing pre-flight** — the dashboard shows what the orchestrator is running. Issues that fail `assess` pre-flight never enter a box.

## Setup

No installation step beyond sequant itself. The TUI renderer (ink) ships in the package; nothing extra to enable.

```bash
# Single issue
npx sequant run 47 --experimental-tui

# Several issues, parallel
npx sequant run 46 47 8 34 --experimental-tui
```

If you want to make it the default for your shell, alias it:

```bash
alias srun='npx sequant run --experimental-tui'
```

## What You Can Do

- **See concurrent progress at a glance.** Each issue gets its own box with the title, current phase, and an elapsed timer.
- **Spot stalls.** A "last activity" stamp ticks under the live `now` line — if it climbs into minutes while a phase shows the spinner, the phase is stuck.
- **Find the right log fast.** Each box prints its `tail -f` path so you can pop a second terminal and stream the underlying log without leaving the dashboard.
- **Ctrl+C cleanly.** The TUI unmounts and hands off to `ShutdownManager`; no terminal corruption, no orphaned spinners.
- **Combine with `--quiet`.** `--quiet` is orthogonal: pass both, and the TUI still renders while the per-phase progress lines that `--quiet` suppresses stay suppressed in the fallback path.

## What to Expect

**Pre-run config strip.** Identical to non-TUI mode — base SHA, concurrency, session path. Printed before the dashboard mounts.

**During the run.** The screen clears and one box per issue appears. Boxes have three cells:

```
┌────────────────────────────────────────────────────────────────────────────┐
│  #47  Add pagination to blog index    phase 2/3  •  01:48                  │
├────────────────────────────────────────────────────────────────────────────┤
│  branch   feature/47-blog-pagination                                       │
│  phases   ✓ spec 00:38   ▸   ⠙ exec   ▸   ○ qa                             │
│  log      .sequant/logs/47-exec.log  (tail -f)                             │
├────────────────────────────────────────────────────────────────────────────┤
│  now      ⠙  writing src/blog/pagination.tsx                               │
│           └ last activity 00:02s ago                                       │
└────────────────────────────────────────────────────────────────────────────┘
```

Borders rotate cyan → magenta → blue → yellow by start order. On terminal states the border color flips to green (passed) or red (failed). The braille spinner (`⠋⠙⠹…`) marks the active phase; `✓` / `✗` / `○` mark done / failed / pending.

**Polling cadence.** State is polled at 10 Hz; the `now` line and spinner update at that rate. The per-issue elapsed timer ticks at 1 Hz to avoid thrashing the terminal.

**Post-run summary.** Same summary block as non-TUI mode is printed after the dashboard unmounts.

**When the dashboard does NOT render.** If stdout is not a TTY (CI, redirect, pipe), the orchestrator silently falls back to the existing linear stream — no error, no warning.

**Bundle / startup cost.** Ink and React ship with sequant; cold start is unaffected by passing the flag (modules load lazily when the flag is set).

## Reference

| Flag | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `--experimental-tui` | boolean | no | off | Render the live multi-issue dashboard instead of linear progress lines. Auto-falls back to linear output when stdout is not a TTY. |

Interaction with other flags:

| Combined with | Behavior |
|---------------|----------|
| `--quiet` (`-q`) | Both apply. TUI renders; non-TUI fallback stays quiet (no liveness heartbeat lines, since the dashboard is the liveness signal). |
| `--phases ...` | Phase set drives the phase progression row inside each box. |
| `--testgen` / `--security-review` | Inserted phases appear in the progression row like any other. |
| Output piped (`| tee`, `>file`) | TUI does not mount; linear output is used. |
| `NO_COLOR=1` | Borders and status colors drop; box structure is preserved. |

## Troubleshooting

### Dashboard never appears, output looks linear

**Cause:** Stdout is not a TTY — the most common reasons are running under CI, redirecting to a file, or piping to another command. The TUI deliberately falls back to linear output in those cases so logs stay parseable.

**Fix:** Run in an interactive terminal. To verify:

```bash
node -e "console.log(process.stdout.isTTY)"
# expect: true
```

### Box layout looks broken — vertical lines misaligned, glyphs doubled

**Cause:** Terminal is not reporting display widths correctly for wide glyphs (CJK, some emoji). The TUI uses `string-width` for truncation, so this is unusual but possible in older terminals.

**Fix:** Update to a recent terminal (iTerm2, Ghostty, modern xterm, Windows Terminal). If you cannot, drop the flag — linear output works in any terminal.

### Boxes overflow off-screen with many issues

**Cause:** Each full box is ~13 rows; running, say, 8 issues at full height needs ~104 rows.

**Fix:** Rendering the full layout for tall lists is on the follow-up list (compact 5-row form). For now, run fewer issues per invocation, or split the run.

### Ctrl+C leaves stale spinner output in the scrollback

**Cause:** Rare, usually caused by a parent process suppressing the unmount cleanup (e.g. `script` recordings, certain terminal multiplexers).

**Fix:** Run `reset` to restore the terminal. If reproducible, capture the parent process and open an issue.

### Dashboard renders but the `now` line never updates

**Cause:** The orchestrator's snapshot is not advancing — usually means the agent is genuinely stuck, not the TUI.

**Fix:** Watch the "last activity" stamp. If it climbs past your phase timeout, run `tail -f` on the log path printed in the box and inspect what the agent is doing. Ctrl+C to abort if needed.

---

*Generated for Issue #540 on 2026-05-06*
