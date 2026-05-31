# `sequant ready` gate — backtest recall & noise (Layer 2)

**Issue:** [#683](https://github.com/sequant-io/sequant/issues/683)
**Corpus:** 27 captured fresh-session QA passes (`.entire` log study, 2026-05-30)
**Method:** Replay `sequant ready` against the pre-fix commit each fresh QA reviewed; measure recall vs. the 12 known would-ship defects and the false-positive / noise rate on clean cases.
**Status:** ⚠️ **Methodology + corpus committed; empirical numbers pending the offline harness run.** See "Execution status" below.

## Question

The in-orchestrator QA under-catches: across 27 captured fresh-session passes (24 of them *after* an in-orchestrator QA had already passed the same work), **12/27 (44%)** caught a real shipping bug or unmet AC. Does the automated `sequant ready` chain independently flag the same defect class — and at what noise cost? Per-policy numbers matter, because the `ac` default is meant to contain the noise/scope-creep that `a-plus` amplifies (the #608 risk).

## Ground-truth corpus

The 12 real-bug cases the fresh QA caught (the recall denominator):

| # | Defect class caught (in-run QA had missed it) |
|---|-----------------------------------------------|
| #421 | Feature non-functional for its primary multi-issue use case, *after* `READY_FOR_MERGE` |
| #503 | New programmatic API broken at launch |
| #467 | AC test passed vacuously — zero assertions fired |
| #529 | No implementation existed — empty branch, zero commits, reported success |
| #570 | No implementation existed — empty branch (null-verdict-as-success, #534) |
| #318 | Merge would have *deleted* the `--reflect` feature from main |
| #465 | (real-bug subset) |
| #484 | (real-bug subset) |
| #528 | (real-bug subset) |
| #554 | (real-bug subset) |
| #573 | (real-bug subset) |
| #625 | (real-bug subset) |

Clean / noise-control cases (the chain must NOT invent gaps or loop to budget): **#677** plus a sample of cleanly-merged PRs that needed no fixes. Judgment-call quality gaps the team would accept-as-is or defer (#451, #559) are the `a-plus` over-fixing controls.

## Metrics

For each corpus case:

1. **Recall (per policy).** Check out the **pre-fix commit** the fresh QA reviewed, recreate its worktree, run `sequant ready <issue> --policy <ac|a-plus>`, and record whether the chain independently flagged the same defect class.
   - `ac` should hit high recall on the **AC-miss subset** (objective): the #529/#570 empty-branch cases must trip the #534 `NO_IMPLEMENTATION` guard; the #467 vacuous-assertion and #421 broken-use-case cases must surface as `AC_NOT_MET`.
   - `a-plus` adds the quality-gap catches.
   - **Target: ≥ 70% recall on the real-bug set** before public release. Report `ac` vs. `a-plus` separately so the policy boundary is *measured*, not assumed.
2. **False-positive / noise rate (per policy).** On the clean cases, the chain must terminate at the threshold without inventing gaps or looping to `maxIterations` / budget. Measure `ac` and `a-plus` separately — high `a-plus` noise validates keeping `ac` as the default.

## Method

### Replay harness

Reuse the existing `.entire` extraction harness (the `/tmp/qa_sessions` condenser) to recover, per corpus case: the issue number, the pre-fix commit SHA, and the fresh QA's recorded verdict + caught-defect summary (the ground truth).

For each case:

```bash
# 1. Recreate the worktree at the pre-fix commit.
git worktree add ../worktrees/backtest/<issue> <pre-fix-sha>
# 2. Run both policies in shadow (never merges by construction).
npx sequant ready <issue> --policy ac    --json > /tmp/backtest/<issue>-ac.json
npx sequant ready <issue> --policy a-plus --json > /tmp/backtest/<issue>-aplus.json
# 3. Score: did result.reason / result.remaining / result.finalVerdict flag the known defect class?
```

The `--json` output (`reason`, `finalVerdict`, `autoFixed`, `remaining`) is the scored signal. Scoring is a human read of whether the flagged class matches the ground-truth defect — non-deterministic, so this is an **offline committed report, not a CI gate** (mirrors the #608 / #609 investigation format).

### Scoring rubric

| Outcome | Counts as |
|---------|-----------|
| `reason: NO_IMPLEMENTATION` on #529/#570 | recall hit (AC subset) |
| `AC_NOT_MET` surfaced, `remaining` names the defect class | recall hit |
| Clean threshold exit on a control case, no invented gaps | true negative |
| Looped to `maxIterations` / budget on a clean case | noise / false-positive |

## Execution status

⚠️ The empirical recall and noise numbers require running the harness above against 27 pre-fix worktrees with **live LLM QA** — this is non-deterministic and slow, so it is executed **offline on the feature branch** (rollout-plan step 2), not in CI or as part of the implementing commit. This document commits the **methodology, corpus, harness, and scoring rubric**; the results table below is to be filled in by that offline run before public promotion.

### Results (to be filled by the offline run)

| Policy | Real-bug recall | AC-subset recall | Noise rate (clean cases) |
|--------|-----------------|------------------|--------------------------|
| `ac`   | _pending_       | _pending_        | _pending_                |
| `a-plus` | _pending_     | _pending_        | _pending_                |

**Promotion gate (from the issue rollout plan):** ≥ 70% recall on the real-bug set with acceptable noise → graduate `ready` from experimental to a documented default. If `a-plus` noise is high, that *validates* keeping `ac` as the default rather than blocking release.

## Falsifiability

The deterministic plumbing this report depends on is covered in CI:

- `#534` guard (empty branch / null verdict → `NO_IMPLEMENTATION`) — `src/lib/workflow/ready-gate.test.ts`.
- Policy thresholds, stagnation (`LOOP_NO_DIFF`), budget/iteration caps — same suite.

So a regression that silently reports an empty branch as ready (the #529/#570 / #534 class) fails CI independently of this offline backtest.
