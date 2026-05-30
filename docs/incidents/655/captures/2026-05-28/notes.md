# #655 capture — 2026-05-28

HITL capture requested by #668 (post-#664 / #667 baseline) to isolate Symptom A
from the wire-amplifiers that made the 2026-05-17 capture non-diagnostic.

## Environment

| | |
|---|---|
| Host project | `matcha-maps` (real `sequant run`, not synthetic) |
| Command | `SEQUANT_DEBUG_RENDERER=1 SEQUANT_DEBUG_RENDERER_FILE=… script -q terminal.typescript npx sequant run 593 627` |
| Machine | Darwin 25.3.0 (macOS) |
| Node | v23.11.0 |
| Terminal size | 155 × 22 |
| Capture 1 | VS Code integrated terminal (xterm.js) v3.3.16 — **not restarted in a long time** |
| Capture 2 | iTerm2 (freshly opened) — counterfactual |

Run outcome: #593 failed (`exec produced no changes`), #627 — run completed; this
is sufficient to exercise the renderer's running→summary transition.

### Capture metadata (#668 template)

| Field | vscode | iterm2 |
|---|---|---|
| `wc -l terminal.typescript` | 5996 | 2630 |
| `wc -l debug-renderer.jsonl` | 503 | 228 |
| `grep -c SEQUANT_DEBUG_RENDERER terminal.typescript` | 0 (file sink active ✓) | 0 (file sink active ✓) |
| Symptom A in byte stream (`grep '✔.*error result'`) | 0 (not present) | 0 (not present) |

Date / time UTC, exact `sequant --version`, and wall-clock duration were not
recorded on the `matcha-maps` host at capture time (2026-05-28) and are not
reconstructable from the artifacts; left unfilled rather than back-filled with
this repo's values.

## What was observed on screen

- **VS Code:** live, on-screen glyph corruption (mid-string overlay; box-drawing
  chars replaced by `�`). Operator attributes this to a stale, long-running VS
  Code terminal that had not been restarted.
- **iTerm2 (fresh):** the `(no commi───────────┐` fragment seen was produced by
  **copy-pasting the scrollback** of an in-place-redrawing TUI, not observed as a
  live paint glitch.

## What the captured bytes actually show

`script` records exactly the bytes the program wrote to the pty. Both captures
are clean:

| Metric | vscode | iterm2 |
|---|---|---|
| typescript bytes | 852,547 | 374,417 |
| U+FFFD (`�`) bytes in stream | **0** | **0** |
| `coatcha` / `(no commi─` overlay in stream | **0** | **0** |
| Whole-file UTF-8 validity | **fully valid** | **fully valid** |
| `ESC[1A` cursor-up / `ESC[2K` erase | 5927 / 6438 | 2583 / 2818 |
| `ESC[?2026h` / `ESC[?2026l` sync pairs | **500 / 500 (balanced)** | **224 / 224 (balanced)** |

Renderer self-instrumentation (`debug-renderer.jsonl`) is internally consistent
across every frame:

| Metric | vscode | iterm2 |
|---|---|---|
| frames | 503 | 228 |
| frames where `rendererCols != stdoutCols` | **0** | **0** |
| frames where `logicalLines > rendererRows` | **0** | **0** |
| max `logicalLines` (vs 22 rows) | 14 | 13 |

## Diagnosis

**sequant's renderer is not corrupting output.** It emitted clean, valid,
column-correct, atomically sync-framed bytes on two independent terminal
emulators, with internally-consistent renderer state throughout.

The corruption originates **downstream of the byte stream**, from two distinct
causes that both leave `script` clean:

1. **Stale terminal-emulator paint state** (VS Code, long-running xterm.js):
   correct bytes mis-painted on screen — an environmental defect cleared by a
   cold restart, not a sequant code bug.
2. **Clipboard flattening of an in-place TUI** (iTerm2 paste): copying scrollback
   that was redrawn in place (5927 cursor-ups in the vscode capture) collides
   fragments of multiple frames onto one line — expected behavior, not a defect.

This refutes #655's core premise. The earlier column-mismatch hypothesis was
already refuted (#654/#657); the renderer-emits-bad-bytes hypothesis is now
refuted too, with byte-level evidence.

## Follow-ups

- **Confirming test (pending):** cold-restart VS Code (⌘Q, not Reload Window),
  re-run, observe live (screenshot, not paste). Gone → close #655 as
  environmental. Persists live → genuinely new, keep digging.
- **Actionable robustness work → #672:** replace the start/complete event journal
  with an in-place phase-matrix. Fewer `logUpdateClear`/`redraw` cycles = smaller
  blast radius for the exact paint churn that a degraded emulator mis-renders.
