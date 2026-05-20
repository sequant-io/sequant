# Capture kit — 2026-05-19 (post-#664 file sink)

**Purpose:** validate the 2171× claim from the 2026-05-17 capture under the new
`SEQUANT_DEBUG_RENDERER` file sink, and measure the *real residual* scrollback
duplicate-header rate that #647 AC-3 still needs to fix (if any).

**Pre-conditions:**
- On `main` at HEAD (`git pull && git rev-parse HEAD`)
- `npm run build` clean
- PR #665 (file sink) merged — verify `grep -n "openSync" src/lib/cli-ui/run-renderer.ts` shows the sink path

## Capture command

The file sink now routes debug output to its own JSONL file, so `script(1)`'s
pty stream is clean — no more stderr co-writer. We override the sink to land
*inside* the capture dir for co-located artifacts.

```bash
DAY=2026-05-19
DIR=docs/incidents/647/captures/$DAY

# Use an absolute path so the override survives the subprocess's cwd.
DEBUG_FILE="$(pwd)/$DIR/debug-renderer.jsonl"

SEQUANT_DEBUG_RENDERER=1 \
SEQUANT_DEBUG_RENDERER_FILE="$DEBUG_FILE" \
  script -q "$DIR/terminal.typescript" \
    npx sequant run <issue-pair-or-single> --max-iterations 1
```

Notes on flags:
- `-q` is now `--quiet` (after #660). It is NOT required for repro; the bug is
  about parallel-mode renderer + log-update interaction, independent of quiet
  mode. Omit it unless you specifically want to test quiet-mode rendering.
- `--max-iterations 1` only applies when `-Q`/`--quality-loop` is also set
  (it bounds the quality-retry count). Drop it for a single-pass run; add
  `-Q --max-iterations N` together if you want to exercise the loop.

## Target scenarios — pick one (or run multiple)

In order of fidelity to the original #647 motivating transcript:

1. **Parallel pair where one issue retries** — mirrors `#504/#505` symptom.
   Pick any small two-issue set; cost ~10–20 min real time.
2. **Single issue with forced loop iterations** — `--quality-loop` will exercise
   the 1Hz redraw cycle over a longer window. Lower fidelity to the original
   transcript but cheaper if budget is tight.
3. **Resize stress** — same as (1) or (2), but resize the terminal mid-run to
   trigger SIGWINCH bursts (separate Mechanism #3 probe).

## After the capture — fill this in

Replace each `<...>` with the actual observed value.

| Field | Value |
|---|---|
| Date / time UTC | `<YYYY-MM-DDTHH:MM:SSZ>` |
| Terminal app | `<iTerm2 / Terminal.app / VS Code / Warp / …>` |
| `$COLUMNS × $LINES` at run start | `<cols> × <rows>` |
| Node version (`node --version`) | `<vXX.X.X>` |
| sequant version (`npx sequant --version`) | `<x.y.z>` |
| Run command (exact) | `<paste>` |
| Issues fed | `<#NNN, #MMM>` |
| Wall-clock duration | `<Xm Ys>` |
| `wc -l terminal.typescript` | `<lines>` |
| `wc -l debug-renderer.jsonl` | `<lines>` |
| `grep -c "SEQUANT WORKFLOW" terminal.typescript` (wire count) | `<n>` |
| `grep -c "SEQUANT_DEBUG_RENDERER" terminal.typescript` | should be **0** under the file sink (sanity check) |

## Sanity checks before running the analyzer

```bash
# Debug records exist and have the expected shape:
wc -l $DIR/debug-renderer.jsonl                    # ≥ ~10 expected
head -1 $DIR/debug-renderer.jsonl | jq .           # parses as JSON
jq -s 'group_by(.op) | map({op: .[0].op, count: length})' \
  $DIR/debug-renderer.jsonl                        # impl / clear / done buckets

# Typescript should NOT contain any debug noise post-#664:
grep -c "SEQUANT_DEBUG_RENDERER" $DIR/terminal.typescript
# Expected: 0. If >0, the file sink override didn't take effect.
```

## Analyzer

Run from project root:

```bash
npx tsx docs/incidents/647/captures/2026-05-19/analyze-trace.ts
```

It will:
1. Read `terminal.typescript` (raw pty bytes) and `debug-renderer.jsonl` (debug records)
2. Replay the typescript through `VirtualTerminal` at the rendered dimensions
3. Report scrollback-only `SEQUANT WORKFLOW ·` header count
4. Cross-tabulate against debug records to attribute residual duplicates to
   mechanism (out-of-band stdout vs. width misreporting vs. wrap inflation)
5. Write a summary to `analysis-report.txt` and a human-facing writeup
   skeleton at `analysis.md`

## Decision rule

**Pre-check before applying the table:** the analyzer reports
`Scrollback rows populated: N`. If `N === 0`, the run did not stress the
scrollback path (live frame fit inside the visible viewport) and the table
below is **inapplicable** — re-capture with a smaller terminal (≤30 rows)
and/or a parallel pair with retries before drawing AC-3 conclusions.

| Scrollback header count | Interpretation | Next step |
|---|---|---|
| **1** (with N > 0 scrollback rows) | #647 closed in production by #659 + #665. File sink fully accounts for the 2171× claim. | Close #647 with reference to this capture; archive AC-3 as "no fix needed, instrumentation artifact eliminated." |
| **2–10** | Real residual Mechanism #2 (out-of-band writers) at low rate. Likely subprocess output landing outside pause/resume brackets. | Audit `process.stdout`/`process.stderr` callsites outside the renderer; implement Mechanism #2 fix (option 2 from PR #663's "Recommended fix direction"). |
| **>10** | Significant residual. Worth investing in larger fix (event-driven redraws / withPaused helper). | Plan AC-3 fix as option 3 from PR #663's recommendations. |
| **0** in scrollback **with N > 0 scrollback rows** (scrollback populated but no headers in it) | Different mechanism than originally hypothesized. | Re-open diagnosis; capture `node --inspect` trace. |

## What this capture validates vs. doesn't

- **Validates:** 2171× was the stderr-into-pty amplifier (PR #665 eliminates it).
- **Validates:** real-world post-#664 residual rate for AC-3 sizing.
- **Doesn't validate:** Symptom 2 (mid-string char drops / U+FFFD) — synthetic
  harness in PR #663 already ruled out a shared root cause; would need a
  separate trigger to reproduce.
- **Doesn't validate:** the *original* #504/#505 transcript's 3-in-56m rate
  unless the captured scenario matches its parallel-mode + retry shape.
