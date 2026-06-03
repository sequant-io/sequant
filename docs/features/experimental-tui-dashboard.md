# Live Multi-Issue TUI Dashboard

A live, in-terminal dashboard that renders one box per issue while `sequant run` works through them concurrently. Use it when running multiple issues in parallel and you want to see at a glance which issue is in which phase, what each one is doing right now, and whether anything has stalled.

> **Now the default (#705).** This boxed Ink dashboard is the default for `sequant run` on a TTY — no flag needed. Pass **`--no-tui`** to fall back to the [line phase-matrix renderer](run-renderer.md), or **`-s`/`--quiet`** to suppress both in favor of the liveness heartbeat. Non-TTY output (pipe, redirect, CI) auto-degrades to the line renderer. `--experimental-tui` is retained as a hidden no-op alias so existing scripts keep working.

## Prerequisites

1. **`sequant run` available** — `npx sequant run --help`
2. **TTY stdout** — the dashboard auto-falls back to linear output when stdout is piped (e.g. `| tee`, CI logs). Verify with `node -e "console.log(process.stdout.isTTY)"`
3. **At least one issue passing pre-flight** — the dashboard shows what the orchestrator is running. Issues that fail `assess` pre-flight never enter a box.

## Setup

No installation step beyond sequant itself. The TUI renderer (ink) ships in the package, and it is the default on a TTY — nothing to enable.

```bash
# Single issue — boxed TUI by default on a TTY
npx sequant run 47

# Several issues, parallel — boxed TUI by default
npx sequant run 46 47 8 34

# Opt out to the line phase-matrix renderer
npx sequant run 46 47 8 34 --no-tui
```

## What You Can Do

- **See concurrent progress at a glance.** Each issue gets its own box with the title, current phase, and an elapsed timer.
- **Spot stalls.** A "last activity" stamp ticks under the live `now` line — if it climbs into minutes while a phase shows the spinner, the phase is stuck.
- **Find the right log fast.** Each box prints its `tail -f` path so you can pop a second terminal and stream the underlying log without leaving the dashboard.
- **Ctrl+C cleanly.** The TUI unmounts and hands off to `ShutdownManager`; no terminal corruption, no orphaned spinners.
- **Suppress with `--quiet`/`-s`.** Since #705, `--quiet` (now `-s`) wins over the TUI default: the dashboard is suppressed and the liveness heartbeat becomes the only signal. Use `--no-tui` instead if you want the line renderer rather than heartbeat-only output.

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

**Bundle / startup cost.** Ink and React ship with sequant; cold start is unaffected (the modules load lazily only when the TUI actually mounts — i.e. on a TTY without `--no-tui`/`-s`).

## Reference

| Flag | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `--no-tui` | boolean | no | TUI on | Opt out of the boxed dashboard and use the line phase-matrix renderer instead. |
| `--experimental-tui` | boolean | no | (no-op) | Hidden no-op alias retained for backward compatibility (#705) — the TUI is now the default, so this flag does nothing. |

Interaction with other flags:

| Combined with | Behavior |
|---------------|----------|
| `--quiet` (`-s`) | `--quiet` wins: the TUI is suppressed and the liveness heartbeat is the only signal (#705). |
| `--no-tui` | TUI does not mount; the line phase-matrix renderer is used instead. |
| `--phases ...` | Phase set drives the phase progression row inside each box. |
| `--testgen` / `--security-review` | Inserted phases appear in the progression row like any other. |
| Output piped (`| tee`, `>file`) | TUI does not mount; line renderer is used. |
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

**Fix:** Update to a recent terminal (iTerm2, Ghostty, modern xterm, Windows Terminal). If you cannot, pass `--no-tui` — linear output works in any terminal.

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
