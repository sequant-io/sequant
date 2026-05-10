# Chain-Mode Success Rate Analysis

**Date:** 2026-05-09
**Issue:** #604
**Source data:** `.sequant/metrics.json` (62 runs), `.sequant/logs/run-*.json` (96 logs)

## Headline

| Cohort | Runs | Success | Rate |
|--------|------|---------|------|
| Single-issue (any phases) | 17 | 13 | 76.5% |
| Single-issue (spec+exec+qa) | 15 | 12 | **80.0%** |
| `--chain` (all lengths) | 7 | 2 | **28.6%** |
| Multi-issue, no `--chain` | 38 | 20 | 52.6% |

The 29% headline from `npx sequant stats` reproduces (28.6% in raw data). Gap vs single-issue holds.

> **Note on the 92% vs 80% gap.** The issue body cites `npx sequant stats` reporting 92% single-issue success at the time it was filed (56 runs in the local sample). This analysis runs on a larger 62-run snapshot of `.sequant/metrics.json` and the doc's 80% applies the explicit `phases ⊇ {spec, exec, qa}` filter. `sequant stats` itself counts every run with `issues.length === 1` (any phase set) — see `src/commands/stats.ts:422`. The headline 76.5% / 80% / 28.6% / 52.6% rates here are reproducible from the raw data; the 92% is a snapshot-in-time figure that does not reproduce against the current data and is treated as a directional, not load-bearing, baseline. (Independent recount of the spec+exec+qa cohort yields 11/14 = 78.6% with a strict `--chain` exclusion; the doc's 12/15 = 80.0% filter includes one borderline single-issue run that may also have ridden in a chain — within rounding either way.)

## Phase A — Signal Confirmation

### Sample size

7 chain runs over 4 months (2026-02-18 → 2026-04-26). Small but every failure is forensically traceable through `.sequant/logs/`.

### Segmentation by chain length

| Length | Runs | Success | Rate |
|--------|------|---------|------|
| 2      | 1    | 1       | 100% (anecdotal) |
| 3      | 4    | 1       | 25% |
| 4      | 2    | 0       | 0% |

**Length-3+ aggregate: 1/6 = 17%.** Failure rate scales with chain length.

> **"Success" filter.** Throughout this doc and the runtime annotation in `assess-collision-detect.ts`, "success" means `outcome === "success"` in `.sequant/metrics.json`. The 2 length-3 chains marked `partial` (some issues completed before the chain halted) are counted with the failures here, not with the successes. Under a partial-counts-as-success framing the length-3+ rate would be 3/6 = 50% rather than 1/6 = 17%; we use the strict definition consistently so the headline (28.6%), the segmentation table, and the runtime annotation all align.

### Per-issue attribution (counterfactual)

The 28.6% whole-chain rate masks a bookkeeping artifact: when issue 1 in a chain fails, issues 2..N never execute and are counted as "chain failed."

| View | Numerator / Denominator | Rate |
|------|------------------------|------|
| Whole-chain success | 2 / 7 | 28.6% |
| Per-issue success (counting skipped as failed) | 8 / 22 | 36.4% |
| Per-issue success (only issues actually attempted) | 8 / 13 | **61.5%** |

**The per-issue success rate when chain mode actually reaches the issue (61.5%) is much closer to the single-issue baseline (80%) than the whole-chain headline suggests.** Chain mode is not 3× worse at solving issues — its halt-on-first-failure semantics inflate the failure count.

### Wall-clock duration

| Cohort | Avg duration |
|--------|--------------|
| Single-issue (success) | 21.9 min |
| Chain (all) | 78.9 min |
| Failed chains | 54-228 min |

Long wall-clock duration is the mechanism behind failure mode #2 below.

## Phase B — Failure Forensics

Each failed/partial chain traced through its log file:

| Run (id, date) | Issues | Length | Outcome | Stopped at | Root cause |
|---|---|---|---|---|---|
| f317530c · 2026-03-23 | 388,389,391,394 | 4 | failed | #388 | Claude Code 5h rate limit hit during quality-loop iteration after AC_NOT_MET |
| 058048af · 2026-03-25 | 438,439,440 | 3 | failed | #438 | Claude Code rate limit on first exec → 1800s timeout cascade |
| e7d3212d · 2026-04-06 | 484,483,485,486 | 4 | failed | #484 | Quality-loop saturated (3× AC_NOT_MET on issue 1) |
| b0349697 · 2026-04-26 | 554,555,556 | 3 | partial | #555 | QA phase API idle timeouts (1800s × 2) on second issue |
| c20fcde6 · 2026-03-12 | 254,304,307 | 3 | partial | #307 | AC_MET_BUT_NOT_A_PLUS treated as failure → retry loop → process exit 1 |

### Top-3 failure modes

| # | Mode | Count | Chain-specific? |
|---|------|-------|-----------------|
| 1 | First-issue retry exhaustion halts entire chain | 3/5 | **Amplified by chain semantics** — same root causes (AC_NOT_MET saturation, rate limit) would fail one issue in single-issue mode but kill all downstream issues here |
| 2 | Long wall-clock chain run trips Claude 5h rate limit | 2/5 | **Structural** — chain duration scales with length, raising rate-limit risk |
| 3 | Pre-existing per-issue failure modes (API timeouts, AC_MET_BUT_NOT_A_PLUS retry-loop bug) | 2/5 | **No** — would fail in single-issue runs too |

### Chain-attributable rate

Of 5 failed/partial runs, **0 have a root cause that is uniquely chain-mode-induced**. All causes (rate limits, QA saturation, API timeouts, the AC_MET_BUT_NOT_A_PLUS bug) also appear in single-issue runs. Chain mode's contribution is **amplification**, not new failure modes:

- A first-issue failure marks all downstream issues as failed (semantic amplification).
- Long chains accumulate wall-clock time, raising Claude rate-limit probability (mechanical amplification).

## Phase C — Recommendation

**Verdict: RESTRICT chain to length=2; warn for length≥3.**

Rationale:

- Sample (n=7) is too small to deprecate outright.
- Length-2 success (1/1) is consistent with single-issue baseline; length-3+ (1/6 = 17%) is not.
- Per-issue success (61.5%) shows chain mode itself is not structurally broken at solving issues — its accounting and duration scaling are.
- Underlying failure modes (rate limits, AC_MET_BUT_NOT_A_PLUS retry loop) are tracked separately and may be fixed without revisiting chain mode.

### `/assess` collision-detect change (implemented)

Existing rule at `src/lib/assess-collision-detect.ts:267` (length-≥3 emit guard) is **preserved**. The chain suggestion now appends a historical-rate annotation:

```
Chain: npx sequant run A B C --chain --qa-gate -q   # alternative — N issues modify <path> (chain length≥3 historically 1/6 = 17%; see docs/reference/chain-mode-analysis-2026-05.md)
```

The annotation route was chosen over a threshold flip (which would have suppressed the suggestion entirely at length≥3) because n=7 is small enough that hard-restricting based on it would over-fit the sample; surfacing the rate inline lets the user weigh chain mode against the parallel-mode default without removing the option. The three skill mirrors of `predicted-collision-detection.md` (`.claude/skills/`, `templates/skills/`, `skills/`) carry the same wording in lockstep, and `src/lib/__tests__/assess-collision-detect.test.ts` asserts both annotation substrings on every length≥3 collision. Re-evaluate (and consider flipping to a hard `length === 2` threshold) when n≥20 chain runs accumulate.

### Out of scope for this issue

- The AC_MET_BUT_NOT_A_PLUS retry-loop bug is documented in `feedback_qa_break_vs_loop.md` and is a `/qa` skill defect, not a chain-mode defect.
- Claude Code rate-limit handling (resume after limit reset) is a separate orchestrator concern.
- `docs/features/parallel-execution.md:126` previously listed chain rate as `50% n=4` from the #452 era; refreshed to `29% n=7` in this PR.

## Limitations

- **n=7 chain runs.** Verdict is consistent with the data but should be revisited at n≥20.
- **Selection bias.** Chains were chosen by the user for issues judged collision-prone — they may be inherently harder than the single-issue baseline.
- **No A/B counterfactual.** We don't have parallel runs of the same issues in single vs chain mode.
