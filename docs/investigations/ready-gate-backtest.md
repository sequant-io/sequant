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

The mechanical parts are automated by **`scripts/analytics/ready-backtest.ts`** (#689). It reads the ground-truth corpus, derives each pre-fix SHA, sets up an issue-number-named worktree, runs `sequant ready` under both policies, captures the JSON, and emits the results table.

```bash
npm run build                                            # ready-backtest invokes dist/bin/cli.js
npx tsx scripts/analytics/ready-backtest.ts              # DRY RUN: resolve SHAs + plan, no live passes
npx tsx scripts/analytics/ready-backtest.ts --run        # execute the live ready passes (SLOW, token cost)
npx tsx scripts/analytics/ready-backtest.ts --run --only 467,318   # subset
npx tsx scripts/analytics/ready-backtest.ts --cleanup    # remove backtest worktrees when done
```

Per-case JSON is written to `.sequant/backtest/<issue>-results.json`; the run prints a heuristic recall figure. **The committed recall number must come from a human reading those JSON files** — the heuristic score is a starting point, not the verdict (scoring is non-deterministic LLM judgment, so this stays an offline committed report, not a CI gate — mirrors the #608 / #609 format).

### Three methodology decisions (made explicit by the driver)

1. **Skill version — `--current-skills` (default ON).** Checking out a pre-fix commit also reverts `.claude/skills/`, so a naive run would test that commit's *old* QA skill. The driver overlays the current `main` skill dirs onto the old product code, so the measurement answers "does **today's** `ready` catch this old bug." Use `--no-current-skills` to evaluate the historical skill instead.
2. **Pre-fix SHA — auto-derived, confidence-flagged.** The SHA is the parent of the squash-merge commit matching `(#<issue>)` (`<fix>~1`). This is the #625-class `git log --grep` false-positive zone, so the driver marks any non-scoped or multi-match derivation **LOW-CONFIDENCE**; those cases (in the current corpus: #503, #528, #625, and the #677 control) **require a manual `sha` override in the `CORPUS` manifest** before their results are trusted.
3. **Scoring — human-confirmed.** The driver's HIT/MISS is heuristic (`reason`/`finalVerdict` vs. expected class). Confirm each by reading the captured JSON before filling the results table.

### Scoring rubric

| Outcome | Counts as |
|---------|-----------|
| `reason: NO_IMPLEMENTATION` on #529/#570 | recall hit (AC subset) |
| `AC_NOT_MET` surfaced, `remaining` names the defect class | recall hit |
| Clean threshold exit on a control case, no invented gaps | true negative |
| Looped to `maxIterations` / budget on a clean case | noise / false-positive |

## ⛔ Methodology blocker — the "checkout pre-fix, run `ready`" harness does not work (discovered 2026-06-01)

Operationalizing the harness via `scripts/analytics/ready-backtest.ts --run` surfaced that the **"`git worktree add <pre-fix-sha>` then run `ready`" approach in the Replay-harness section above is invalid as written.** Three concrete blockers, all verified by git, before any live pass:

1. **Full-weight QA's stale-branch gate blocks every replay.** `sequant ready` runs full-weight QA (`SEQUANT_FULL_QA=1`, #683 AC-2), which **runs** the stale-branch check (the very check the in-run QA skips). Every corpus pre-fix commit is far behind today's `main` — e.g. #467's pre-fix commit is **171 commits behind** `origin/main`, vs. the default `staleBranchThreshold: 5`. So QA `exit 1`s on `STALE_BRANCH` before reviewing anything. Every case is an old commit ⇒ every case blocks.
2. **A detached pre-fix checkout has no candidate diff to review.** `git diff origin/main...<pre-fix>` = **0 files** (the pre-fix commit is an ancestor of `main`). The bug-era *code* is present but **the change under review is not** — QA reviews `<base>...HEAD` and finds nothing. The fresh QA we're trying to reproduce reviewed a *PR diff*, which a detached old-commit checkout does not reconstruct.
3. **The clean control needs the post-fix state.** #677 (noise control) must be replayed at its *implemented* state, not pre-fix — pre-fix is an empty baseline that can't test "does the gate invent gaps on clean work."

**Deeper root cause:** the backtest wants to re-present, to *today's* gate, the *buggy diff the historical fresh QA reviewed*. For squash-merged / deleted PR branches that exact buggy state is often unrecoverable.

### Candidate redesigns (a design decision, not just "run the script")

| Approach | Mechanism | Trade-offs |
|----------|-----------|------------|
| **A — base override** | Add `ready --base <era-sha>`; replay the fix's diff as a branch on the pre-fix base; point QA's diff + stale checks at `<era-sha>` (not `origin/main`). | Faithful to history, but needs a new CLI/QA-base primitive (skill changes ×3) **and** the historical buggy diff (often unrecoverable for squash-merged branches). |
| **B — revert-on-current-main** (looks simpler) | Branch off **current** `main`, `git revert --no-commit <fix>` to reintroduce the bug as a candidate diff, run `ready` with the **default** base. | No new feature: `behind main` = 0 (no stale block) and the diff = the reintroduced bug. Tests "does today's gate catch this defect class **today**" — arguably more relevant. Caveats: the revert may conflict after drift; it reviews a *removal of the fix* (which is itself the #318-class regression test); #534 empty-branch cases (#529/#570) still need their own empty-worktree setup. |

Approach **B** needs only driver changes (no `ready` feature); **A** is the more faithful but heavier primitive.

### Approach B was tested — it also fails on this corpus (2026-06-01)

A manual revert-on-main trial on **#573** (a focused skill-prompt fix) **conflicted immediately**: `git revert <fix>` collided on `skills/qa/SKILL.md` (`U` unmerged), because that file has been edited many times since the fix. Surveying the corpus confirms this is systemic, not a one-off:

- **7 of the 10 derivable fixes touch high-churn files** (`qa/SKILL.md`, `run.ts`, `skills/`, `batch-executor`, `phase-executor`) — #421, #467, #318, #465, #484, #554, #573. Their reverts conflict against the drift.
- The other **3 (#503, #528, #625) are the low-confidence cases** whose `(#N)` match is a *docs* commit — there is no code defect to revert in the first place.

So the corpus is squeezed from both sides: high-churn fixes don't revert cleanly, and the clean-reverting remainder has no real defect. **Both A and B are empirically non-viable** for an *automated* run — A is blocked by the stale-gate + empty-diff, B by revert conflicts on actively-developed files. A valid run would require bespoke per-case reconstruction (hand-resolving each revert conflict, or recovering the historical buggy PR diff from `.entire`), which is archaeology, not a script.

### Conclusion & recommendation

**Automated Layer-2 backtest of this historical corpus is not cost-effective.** The deterministic guarantees AC-7 actually cares about — the #534 empty-branch / null-verdict guard, the policy thresholds, and the budget/stagnation exits — are already pinned by `ready-gate.test.ts` in CI (see Falsifiability). The realistic empirical validation is **Layer 3 (forward shadow dogfood)**: run `sequant ready` alongside the manual fresh `/qa` on the *next* ≥10 live issues, where the candidate diff exists by construction and no archaeology is needed. Recommend **descoping AC-7's "measured historical recall" to the Layer-3 forward cohort** and treating this document as the record of why the backtest-against-history path was abandoned.

## Execution status

⚠️ **Automated historical backtest abandoned as infeasible (see above).** Validation shifts to Layer-3 forward shadow dogfood (#689 AC-2). This document is retained as the methodology + corpus + the evidence that both replay approaches (A: stale-gate/empty-diff; B: revert conflicts on drift) fail for an automated run. The results table below will be filled from the Layer-3 forward cohort, not a historical run.

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
