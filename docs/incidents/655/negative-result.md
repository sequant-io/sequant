# #655 — Renderer corruption (Symptom A): negative result

**Status:** AC-D1 (no reproduction; instrumentation in place for next real-run capture).

**Scope of this document:** What `/exec 655` could and could not establish without a real-terminal trace, and how to capture the trace required to advance to AC-1..4.

## TL;DR

- Synthetic reproduction does **not** trigger the `complete[0:8 bytes] + failed[col 9+]` overlay pattern. The scrollback harness from #647 covers the only mechanism reachable in our virtual-terminal model (width misreporting / scroll), and adding the explicit complete→failed event-line sequence at multiple widths + pause/resume states keeps that result.
- Static analysis of every `process.stdout.write` / `console.log` reachable from `npx sequant run …` (both default mode and quiet mode `--quiet`) confirms there is no second stdout writer in either mode: the renderer owns stdout in default mode, the heartbeat owns it in quiet mode, and they are mutually exclusive (see `run-progress.ts:46-49` and `run-progress.ts:59-60`). There is no second-writer mechanism in the source tree.
- The forensic byte math (`complete[0:8] + failed[9:]`) therefore implies one of: (a) a mechanism on the terminal-emulator side, (b) an interleave the static reading missed, or (c) a measurement artifact in the original transcript. Discriminating between these requires a real-run trace.
- AC-1 instrumentation (`SEQUANT_DEBUG_RENDERER=1`, emitted from `src/lib/cli-ui/run-renderer.ts:557-606`) is already shipped. The next productive step is a live capture against a scenario known to corrupt — see "How to capture AC-1" below.

## What was tried

### 1. Synthetic reproduction (spec phase 1)

The #647 scrollback harness (`src/lib/cli-ui/scrollback-harness.ts` + `…test.ts`) drives a real `createLogUpdate(stream)` instance through a `VirtualTerminal` that models cursor positioning, eraseLine variants, and scrollback. Existing scenarios pass green; the duplicate-header / width-misreport case from #647 is locked in.

For #655 specifically, this PR adds one further scenario (see `scrollback-harness.test.ts`'s `#655 negative-result lock-in` block): the motivating issue's exact event sequence (complete `loop` event followed by a failed `loop` event for the same issue) at a 100-col stream + 80-col physical width + pause/resume between events. The VT inspects every row of `(visible + scrollback)` and asserts no row matches the overlay regex `/✔ #\d+(?!.*\d).*Claude/` (a green checkmark on the same row as the error string would indicate the production corruption).

**Result:** assertion passes. No overlay row produced in any synthetic variant tried.

### 2. Static analysis of stdout writers in both run modes (spec phase 2)

Auditing every `process.stdout.write` and `console.log` call reachable from `npx sequant run …` (both default mode and quiet mode `--quiet`). The audit covers both modes because the corrected gating analysis below establishes that they have *different* sole writers — restricting the audit to one mode would miss the mode-discrepancy callout in §"How to capture AC-1":

| Writer | File:line | Reachable in quiet mode (`--quiet`)? |
|---|---|---|
| `TTYRenderer.stdoutWrite` (renderer's sole own writer) | `src/lib/cli-ui/run-renderer.ts:131-132` | **No in `--quiet`** — not wired (see `run-progress.ts:59-60`); sole writer in default mode and emits all `✔`/`✘`/`▸` event-line glyphs |
| `log-update` instance (via renderer's `logUpdateImpl`) | `src/lib/cli-ui/run-renderer.ts:664-676` | Same as above — gated on `!quiet && !tuiEnabled` |
| `process.stdout.write(chalk.gray(text))` (verbose subprocess streaming) | `src/lib/workflow/phase-executor.ts:675` | **No** — gated on `if (config.verbose)` |
| `process.stderr.write(chalk.red(data))` (verbose subprocess stderr) | `src/lib/workflow/phase-executor.ts:686` | No — stderr, also gated on verbose |
| `LivenessHeartbeat.stdoutWrite` | `src/lib/workflow/heartbeat.ts:100, :226` | **Yes** — sole stdout writer in quiet mode (see `run-progress.ts:46-49`); mutually exclusive with renderer; writes only `▸ #N phase (elapsed, …)` heartbeat lines, **never `✔`/`✘`** |
| `batch-executor.ts:153, :165` | n/a | No — stderr only |
| Renderer's `stderrWrite` (one-shot fallback notice if `SEQUANT_DEBUG_RENDERER` file sink fails to open, per #664) | `src/lib/cli-ui/run-renderer.ts:588-590` | Yes — stderr only, fires at most once per process |
| `console.log` callsites in `src/commands/sync.ts`, `src/commands/update.ts`, etc. | various | No — not reachable from `run` |

There is **no second stdout writer** in either mode: in default mode the renderer owns stdout end-to-end; in quiet mode the heartbeat owns it (and writes only `▸` lines). No code path produces a `✔` glyph alongside the heartbeat, and no code path produces a `▸` heartbeat alongside the renderer. The `complete[0:8] + failed[col 9+]` overlay cannot be assembled from any combination of these writers in a single run mode.

### 3. Re-confirmation of ruled-out hypotheses

Each of the six ruled-out hypotheses from the issue body was re-examined against the source as of `7412850` (post-#647). No new evidence challenges the prior refutations. Nothing in this audit warrants relitigating them.

## What could not be established without a real-run trace

The forensic byte pattern (`complete[0:8 bytes] + failed[col 9+]` on the same row) is a load-bearing claim. If accurate, **some** mechanism wrote those bytes onto a row that already contained the prefix of the complete-event line. Possible sources, ordered by feasibility:

1. **Terminal-emulator-side rendering bug.** The VT we model in the harness is faithful to the ANSI vocabulary log-update emits, but a specific terminal emulator could implement cursor/erase semantics differently and produce an overlay where the model says none exists. This is testable only against a real terminal that has been observed to corrupt.
2. **A stdout writer we missed in static analysis.** Possible but unlikely given the audit above; the renderer-owned-stdout invariant is structural.
3. **Measurement artifact.** The original transcript was captured via shell redirection / scrollback copy. If the corruption is purely a rendering issue (i.e., bytes on the wire are correct, but the emulator drew the wrong glyphs at the wrong cells), the transcript could mislead the byte-math analysis.

All three require evidence from a real corrupted run. `SEQUANT_DEBUG_RENDERER=1` appends one JSON line per `log-update` callsite to `.sequant/debug-renderer.jsonl` (override path via `SEQUANT_DEBUG_RENDERER_FILE`, see #664) — frame counter, columns/rows from both the renderer and `process.stdout`, logical line count, and wrap-aware wrapped line count. Diffing the trace against the visible terminal corruption is what AC-2 calls for.

## How to capture AC-1

> **Mode discrepancy — resolved by #658.** The issue body labels the motivating transcript as `-q` (quiet) mode, but the visible glyph in the corrupted line (`✔`) is **only** produced by `TTYRenderer`, which is gated off when `quiet === true` (see `run-progress.ts:59-60`). The puzzle dissolves once `bin/cli.ts:234` is read: at the time of capture, `-q` was registered as the short form for `--quality-loop`, not `--quiet` (which had no short alias at `bin/cli.ts:250`). Commander assigns each short form to whichever option declares it first, so `npx sequant run … -q` produced `qualityLoop: true, quiet: undefined`, leaving the renderer wired and free to emit `✔`. The mode label in the issue body was a user-side misreading of what `-q` did, not evidence of a renderer wiring bug; the static-analysis conclusion above (renderer and heartbeat are mutually exclusive on stdout) stands unchanged. Post-#658, `-q` is now the short form for `--quiet`, so a fresh capture using `-q` would route through the heartbeat path and would *not* reproduce Symptom A. The example below uses default mode (no `-q`/`--quiet`) because that matches the mode in which the original transcript was actually captured — the renderer being active is what made `✔` reachable in the first place.

1. Identify a scenario known to produce Symptom A. The motivating transcript referenced `npx sequant run 504 505` (parallel mode, 2 issues, ~12 events including a `loop` retry that fails) in a real terminal.
2. Run with the instrumentation enabled and capture both streams (default mode, **no** `-q`/`--quiet`):

   ```bash
   SEQUANT_DEBUG_RENDERER=1 \
     script -q artifact/terminal.typescript \
     npx sequant run 504 505 \
     2> artifact/debug.jsonl
   ```

   `script -q` records the literal bytes sent to the terminal (including all ANSI sequences) into `artifact/terminal.typescript`. `2>` separates the JSON trace.

3. When Symptom A reproduces, commit both artifacts under `docs/incidents/655/captures/<date>/`. If using `npx sequant run` against real production issues isn't viable, a smaller fixture (any two-issue parallel run where the `loop` phase fails for one issue) should suffice.
4. With both artifacts in hand, the next iteration can:
   - Read `debug.jsonl` to determine the renderer's view at every frame.
   - Read `terminal.typescript` (or replay via `cat`) to determine what the terminal actually drew.
   - Reconcile: does the renderer's wire output already contain the overlay, or does the emulator render an overlay despite a wire output that wouldn't produce one in our VT?

Outcome (1) puts the bug in the renderer / log-update path; outcome (2) puts the bug in the terminal emulator and is out of scope for a sequant patch (though we may want a workaround).

## Open follow-ups (not blocking this PR)

- The PTY-based test harness option from the issue body (`node-pty` or `script`-FIFO) becomes worth building only if the AC-1 capture reveals timing-dependence — i.e., the wire bytes are deterministic but the emulator's response is not. Defer until evidence motivates the cost.
- The pause/resume dead-code bug (`batch-executor` never passes `spinner` to `executePhaseWithRetry`) is filed separately per the issue body; no movement here.

## Artifacts shipped in this PR

- `docs/incidents/655/negative-result.md` — this file
- `src/lib/cli-ui/scrollback-harness.test.ts` — added one negative-result lock-in test asserting the complete→failed event sequence does not produce an overlay row in the synthetic harness
- No changes to `src/lib/cli-ui/run-renderer.ts`; instrumentation from #647 (`SEQUANT_DEBUG_RENDERER=1`) is unchanged and ready for the next capture
