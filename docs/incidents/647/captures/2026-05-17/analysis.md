# AC-1 capture forensic analysis — 2026-05-17

## TL;DR

PR #661's "Mechanism #1 confirmed at 2181× over 36m" headline is **incorrect**. The 2181 count is **wire-level traffic** (every `logUpdate(text)` call writes the header string to the typescript file), not scrollback occurrences. log-update's `eraseLines` escape sequences also land in `terminal.typescript` — but those escapes don't delete prior bytes from the recorded file, they only erase characters in a real terminal.

When the raw bytes are replayed through a `VirtualTerminal` (modeling the actual 213×31 production terminal):

| Input | Headers in (visible + scrollback) | Headers in scrollback only |
|---|---|---|
| Raw bytes WITH stderr instrumentation interleaved (script(1) view) | **2180** | 2171 |
| Raw bytes WITHOUT stderr `SEQUANT_DEBUG_RENDERER` lines (real-user view) | **4** | 1 |

**Amplification factor: 2171× (one scrollback header without stderr, 2171 with).**

The "Mechanism #1 reproducing at scale" was an artifact of `SEQUANT_DEBUG_RENDERER=1` instrumentation. In a real user terminal without that flag, log-update's `eraseLines` works correctly and only **one** header survives in scrollback across a 36-minute single-issue run.

## What was actually measured

`grep -c "SEQUANT WORKFLOW" terminal.typescript` returns 2181 — but `grep` counts byte-pattern occurrences in the file, including bytes that a real terminal would have *immediately erased* via the following `eraseLines` escape. The typescript file records the wire (all bytes written to the pty), not the visible state.

A proper measurement requires VT replay. `analyze-trace.ts` (this directory) does exactly that:

```ts
const vt = new VirtualTerminal({ rows: 31, cols: 213 });
const rawWithoutDebug = raw.replace(/SEQUANT_DEBUG_RENDERER \{[^}]+\}\n/g, "");
vt.write(rawWithoutDebug);
console.log(vt.countOccurrences(/SEQUANT WORKFLOW · /));  // → 4 total, 1 in scrollback
```

## Why the stderr instrumentation amplifies so dramatically

`run-renderer.ts:606` writes the AC-1 instrumentation via `this.stderrWrite(...)`. In a normal terminal, stderr and stdout share the same pty. Every `SEQUANT_DEBUG_RENDERER {...}\n` write advances the terminal's cursor by one line. log-update has no knowledge of this — it tracks `previousLineCount` from its own writes only.

So when `logUpdate(text)` is called next, it issues `eraseLines(previousLineCount)` going upward from the current cursor. But the cursor is now `1 + (stderr-line-count-since-last-redraw)` rows below where log-update *thinks* it is. The erase escape erases stderr lines (and parts of the prior frame), then `cursorLeft` resets to col 0, then the new frame is written. The portions of the prior frame that weren't erased remain in scrollback as the live frame scrolls down.

Over a 36m run with 2210 stderr writes (one per `impl`/`clear`/`done` op) and ~2180 log-update redraws, virtually every redraw left a header stranded.

## Sanity checks (all confirmed)

| Check | Result |
|---|---|
| rendererCols vs stdoutCols mismatch (Mechanism #4) | 0 / 2210 samples — ruled out |
| logicalLines vs wrappedLineCount mismatch (wrap inflation) | 0 / 2210 impl ops — ruled out |
| Headers preceded by `clear` op (would indicate appendEventLine misuse) | 0 / 2180 — ruled out |
| Headers per frame distribution | min=1 median=1 max=1 across 2180 frames — every frame writes one header (expected) |
| Inter-header byte gap | median 665, p99 667 — uniform, dominated by frame size (a clean redraw cycle) |
| Symptom 2 corrupted lines in scrollback | 1 (false positive: the initial banner block "SEQUANT WORKFLOW" without the middot — not a corruption) |

## What this means for #647 AC-1 / AC-3

- **AC-1 (Diagnose before fixing)** — still incomplete. The capture shows that:
  1. log-update + a wide-terminal single-issue 1Hz redraw at matched widths does NOT produce scrollback duplicates by itself.
  2. Out-of-band writes to the same pty (stderr, in this capture) breaks log-update's cursor tracking and produces near-100% scrollback duplicates.
- **The original #647 transcript** (3 duplicates over 56m in `npx sequant run 504 505 -q`) reflects a different scenario: parallel mode, subprocess (`claude`) verbose output interleaved with renderer output. That mechanism is consistent with the stderr finding above (any out-of-band writer breaks log-update), but at a lower rate because subprocess output goes through `phase-executor.ts` which now correctly pauses the renderer (per PR #659).
- **The fix direction**: the underlying mechanism is Mechanism #2-adjacent: "writes to the same pty from a path other than log-update break log-update's cursor model." Candidate fixes:
  - Drop the stderr instrumentation (or move it to a separate file via `fs.appendFileSync` rather than `process.stderr.write`), eliminating the amplifier seen in the AC-1 capture. **(Implemented in #664: now writes to `.sequant/debug-renderer.jsonl`, override via `SEQUANT_DEBUG_RENDERER_FILE`.)**
  - Ensure subprocess output goes through `pause()`/`resume()` brackets (already done in #659).
  - Verify no other code path writes to `process.stdout`/`process.stderr` outside the renderer's bracketed regions.

## Recommended next steps

1. **Clean baseline capture** — re-run `npx sequant run <small parallel issue set>` WITHOUT `SEQUANT_DEBUG_RENDERER=1`, manually save scrollback, count headers. Goal: confirm the original-bug magnitude post-#659 and decide whether the residual is worth fixing or can be closed.
2. **Deterministic reproduction** (this iteration's AC-B): synthesise the stderr-write-during-redraw scenario in `scrollback-harness.test.ts` so future regressions in renderer/log-update interaction are caught.
3. **Instrumentation fix** — move `SEQUANT_DEBUG_RENDERER` output to a file (e.g., `process.env.SEQUANT_DEBUG_RENDERER_FILE` or default `.sequant/debug-renderer.jsonl`) so future investigations don't suffer the same amplification. Defer to follow-up issue.

## How to reproduce this analysis

```bash
cd /path/to/sequant
npx tsx docs/incidents/647/captures/2026-05-17/analyze-trace.ts
# outputs to stdout + writes analysis-report.txt
```

Source: `analyze-trace.ts` in this directory. Raw report: `analysis-report.txt`.
