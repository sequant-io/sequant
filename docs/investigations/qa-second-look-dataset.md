# QA second look: the n=27 as data, and a seeded-defect ground truth

**Issue:** [#1067](https://github.com/sequant-io/sequant/issues/1067) (blocks [#1068](https://github.com/sequant-io/sequant/issues/1068))
**Source:** the local-only `entire/checkpoints/v1` branch. It holds Entire checkpoints of sessions that opened with `qa <N>`, dated 2026-02-22 → 2026-05-13 (before the 2026-05-30 study).
**Method:** mechanical signals from `scripts/analytics/qa-second-look-mine.ts`, then labels assigned per row from narrow reads of each session (see "Labeling").
**Raw data:** `.sequant/qa-second-look.jsonl` (gitignored; it holds turn heads, so it is never committed)

## Question

The README says a study of 27 fresh second-look `/qa` reviews found that 12 (44%) caught a bug that would have shipped. That number existed only as prose. No per-case table existed, so it could not be re-measured or used to calibrate a grader. This document rebuilds the 27 as rows. It also splits each catch into the three mechanisms the original analysis named: de-anchoring, QA weight, and the human's "any gaps?" follow-up. Finally, it builds the seeded-defect fixture and the graders that any later ablation (#1068) needs.

## TL;DR

- **27 independent reviews were recovered** (30 rows; 3 sessions repeat a review already in the table). The count matches the study's n=27. The recovered list may still differ from the lost one (see "Reconciliation").
- **10 of 27 (37%) caught a would-ship bug, not 12 of 27 (44%).** 13 found only quality gaps and 4 were clean. The original split was 12/11/2.
- **7 of the 10 catches landed only after the human's follow-up turn** ("any gaps?"). 3 were in the first verdict. None needed a step that orchestrated QA skips. **The second look's value is mostly the human-driven second pass, not the fresh session.** The docs that still cite 44% and attribute it to the fresh session are corrected in #1309. They are `docs/reference/ready-command.md`, `docs/features/run-ready-gate.md`, `docs/investigations/ready-gate-backtest.md` and `docs/internal/what-weve-built.md`; the README has no such claim.
- Every session but one asked about gaps, usually on turn 1, the human's first reply. A reviewer that never gets that prompt is a different treatment, and that comparison is #1068's to make.
- The fixture plants 5 defects, one per class the dataset caught. The graders reproduce the hand-written example exactly (recall 0.60, precision 0.60). Calibration (AC-6/7/8): five opus `/qa` runs each caught all 5 planted defects by human reading, at about $0.92 per run. The original literal grader scored recall 0.60 and precision 0.36 mean, disagreeing with the human on 10 of 25 cases. Recalibrated in #1313 (alias identifiers, planted share, no heading or status-table noise), it scores recall 1.00 on all five runs, 0 of 25 disagreements. That result is in-sample.

## Method

### Source and candidate set

The study's transcripts are not under `~/.claude/projects/`, which holds nothing older than 2026-08-17. They are Entire checkpoints on the local branch `entire/checkpoints/v1`. Each checkpoint is `<xx>/<id>/<n>/{prompt.txt, metadata.json, full.jsonl, content_hash.txt}`. The candidate set is every checkpoint created on or before 2026-05-30 whose `prompt.txt` opens with `qa <N>`: 26 checkpoints. Sessions that reviewed two issues give one row per issue, and #395's session also reviewed #390, which adds a row. That makes 30 rows.

#683 also cites #421, #570, #467 and #318. None of them opens a checkpoint with `qa <N>`. A word-boundary `git grep` across every `full.jsonl` on the branch finds those numbers only inside unrelated sessions (fullsolve/merge/status prompts), never as the subject of a review. **They are not recoverable as second-look reviews and are not in the table.**

### Signals (mechanical)

`scripts/analytics/qa-second-look-mine.ts` streams each `full.jsonl` from git and emits, per checkpoint:

| Signal | Rule |
|--------|------|
| human turns | `type:"user"` entries that are not tool results, meta, sidechain, or harness-injected (`<task-notification>`, `<system-reminder>`, local-command output) |
| gap turn | first human turn after the opener matching `\bgaps?\b` |
| stated verdicts | assistant prose matching `verdict … (READY_FOR_MERGE\|AC_MET_BUT_NOT_A_PLUS\|AC_NOT_MET\|NEEDS_VERIFICATION)`, with the human turn they follow |
| edits / commits | `Edit`/`Write`/`MultiEdit` and `git commit` tool calls, bucketed before/after the gap turn |
| orchestrator | any `SEQUANT_ORCHESTRATOR=<value>` in the session (0 of 26: every session is standalone `/qa`) |
| prior QA markers | `--github`: issue comments carrying a `SEQUANT_PHASE` `qa` marker posted **before the session's first entry**. These are lower bounds. Phase markers were young in Feb–Mar 2026, so a `0` there does not prove no earlier QA ran. Multi-issue sessions check the first issue only. |

### Labeling

Each row's `category`, `timing` and `defect class` was assigned from narrow reads of that session: the first QA report, and the turns after the gap prompt. Whole transcripts were not read. Four read-only labeling agents each took a quarter of the sessions with a fixed rubric, and every row carries the agent's confidence.

**These labels are agent-assigned, not human-assigned.** For AC-7, the "human label" side should be a human spot-check of the 10 caught rows plus a sample of the 17 others. Until that happens, the caught/not-caught column is the best available label, not ground truth.

- **category:** `bug` = a would-ship defect: a functional bug, an unmet AC, a missing or non-functional implementation, a broken primary path, a test that guards nothing, or a merge that would delete or regress something. `quality` = only substantive non-blocking gaps (docs drift, missing tests for working code, minor edges). `clean` = nothing substantive.
- **caught** = `y` iff category is `bug`.
- **timing:** `first-verdict` if the defect is named in the first QA report. `after-follow-up` if it is named only after a human follow-up turn.
- **defect class:** one of `primary-path-broken`, `unmet-ac`, `unwired-option`, `error-path`, `security-exposure`, `missing-implementation`, `vacuous-test`, `regression-deletion`, `docs-contract-drift`.

### Primary-mechanism rule (AC-2)

Each caught row gets exactly one primary mechanism, so the counts sum to the catch total:

1. **human follow-up:** timing is `after-follow-up`. The catch did not exist until the human pushed.
2. **QA weight:** timing is `first-verdict`, and finding it depended on a step orchestrated `/qa` skips by design. Those steps are pre-flight git/branch checks, running the feature end to end, and confirming the branch holds the implementation.
3. **de-anchoring:** timing is `first-verdict` and no such step was needed. A fresh standalone reviewer saw it on its first pass.

A row whose catch also needed a skipped step, but which landed after the follow-up, keeps `human follow-up` as primary. The Mechanism column marks it `(+QA weight)` as a contributing cause.

## Dataset (AC-1)

Dates are session start (UTC). The source is the checkpoint path plus the first 16 hex digits of its `content_hash.txt`. Recover one with `git show entire/checkpoints/v1:<path>/full.jsonl`. No transcript text is reproduced here.

<!-- dataset-table:start -->
| # | Issue | Date | First verdict | Category | Caught | Timing | Defect class | Mechanism | Prior QA markers | Gap turn | Duplicate of | Source (checkpoint · content hash) |
|---|-------|------|---------------|----------|--------|--------|--------------|-----------|------------------|----------|--------------|-------------------------------------|
| 1 | #313 | 2026-02-22 | `READY_FOR_MERGE` | bug | y | after-follow-up | `primary-path-broken` | human follow-up | 2 | 1 | - | `f9/389daebb2d/0` · `sha256:98ac4b444711cd59…` |
| 2 | #299 | 2026-02-22 | `AC_MET_BUT_NOT_A_PLUS` | quality | n | - | - | - | 1 | 1 | - | `a8/8566fd523c/0` · `sha256:7a48af3c105040b9…` |
| 3 | #300 | 2026-02-22 | `AC_MET_BUT_NOT_A_PLUS` | quality | n | - | - | - | 1 | 1 | - | `a8/8566fd523c/0` · `sha256:7a48af3c105040b9…` |
| 4 | #336 | 2026-03-11 | `AC_NOT_MET` | bug | y | first-verdict | `unmet-ac` | de-anchoring | 0 | 1 | - | `1e/43716fecdd/2` · `sha256:197172135c869f92…` |
| 5 | #172 | 2026-03-11 | `READY_FOR_MERGE` | clean | n | - | - | - | 0 | 1 | - | `1e/43716fecdd/3` · `sha256:9e71fe9f4f39b687…` |
| 6 | #248 | 2026-03-11 | `NEEDS_VERIFICATION` | clean | n | - | - | - | 1 | 1 | - | `1e/43716fecdd/4` · `sha256:9a4316ef92212cc9…` |
| 7 | #327 | 2026-03-12 | `READY_FOR_MERGE` | quality | n | - | - | - | 0 | 1 | - | `78/781336ea85/0` · `sha256:bc6cac5c94260c59…` |
| 8 | #94 | 2026-03-13 | `READY_FOR_MERGE` | quality | n | - | - | - | 1 | 1 | - | `78/781336ea85/1` · `sha256:a0eb1af8763a7e26…` |
| 9 | #352 | 2026-03-13 | `READY_FOR_MERGE` | bug | y | after-follow-up | `unmet-ac` | human follow-up | 1 | 1 | - | `78/781336ea85/1` · `sha256:a0eb1af8763a7e26…` |
| 10 | #368 | 2026-03-22 | `AC_NOT_MET` | bug | y | first-verdict | `unwired-option` | de-anchoring | 2 | 5 | - | `78/781336ea85/12` · `sha256:8d920a17f188c892…` |
| 11 | #372 | 2026-03-23 | `READY_FOR_MERGE` | bug | y | after-follow-up | `security-exposure` | human follow-up | 2 | 6 | - | `78/781336ea85/14` · `sha256:b46fe9fd09374413…` |
| 12 | #369 | 2026-03-23 | `READY_FOR_MERGE` | bug | y | after-follow-up | `primary-path-broken` | human follow-up | 1 | 1 | - | `78/781336ea85/15` · `sha256:e9b9f501ba260cd3…` |
| 13 | #370 | 2026-03-23 | `READY_FOR_MERGE` | bug | y | after-follow-up | `security-exposure` | human follow-up | 0 | 1 | - | `78/781336ea85/18` · `sha256:32808031f8f10ff3…` |
| 14 | #395 | 2026-03-24 | `READY_FOR_MERGE` | clean | n | - | - | - | 1 | 2 | - | `78/781336ea85/22` · `sha256:24506fa5ba155ea5…` |
| 15 | #390 | 2026-03-24 | `READY_FOR_MERGE` | quality | n | - | - | - | 1 | 2 | - | `78/781336ea85/22` · `sha256:24506fa5ba155ea5…` |
| 16 | #447 | 2026-03-26 | `READY_FOR_MERGE` | quality | n | - | - | - | 1 | 1 | - | `a9/ea4586305f/1` · `sha256:4e96c40a79de169d…` |
| 17 | #448 | 2026-03-26 | `READY_FOR_MERGE` | quality | n | - | - | - | 1 | 1 | - | `a9/ea4586305f/0` · `sha256:79d3ef3aed3b498a…` |
| 18 | #448 | 2026-03-26 | `READY_FOR_MERGE` | quality | n | - | - | - | 1 | 1 | `a9/ea4586305f/0` | `80/f7c4e77624/0` · `sha256:79d3ef3aed3b498a…` |
| 19 | #461 | 2026-03-26 | `READY_FOR_MERGE` | clean | n | - | - | - | 0 | - | - | `37/2c9c4e609f/3` · `sha256:7085b1a405c40e87…` |
| 20 | #460 | 2026-03-26 | `READY_FOR_MERGE` | quality | n | - | - | - | 1 | 3 | - | `f7/450c494650/3` · `sha256:3642f7e4648cf8eb…` |
| 21 | #484 | 2026-04-07 | `READY_FOR_MERGE` | quality | n | - | - | - | 4 | 1 | - | `5b/588313b1b7/1` · `sha256:1842b80b4df2971a…` |
| 22 | #503 | 2026-04-09 | `READY_FOR_MERGE` | bug | y | after-follow-up | `error-path` | human follow-up | 1 | 1 | - | `7a/86e4a2ac1f/1` · `sha256:9ec11b2206717f67…` |
| 23 | #503 | 2026-04-09 | `READY_FOR_MERGE` | bug | y | after-follow-up | `error-path` | human follow-up | 1 | 1 | `7a/86e4a2ac1f/1` | `d0/9462ed63c7/1` · `sha256:9cd4f54138fa6314…` |
| 24 | #528 | 2026-04-18 | `AC_NOT_MET` | bug | y | first-verdict | `unmet-ac` | de-anchoring | 1 | 1 | - | `27/f002f3c8e8/0` · `sha256:57ea030cc176204a…` |
| 25 | #528 | 2026-04-18 | `AC_NOT_MET` | bug | y | first-verdict | `unmet-ac` | de-anchoring | 1 | 1 | `27/f002f3c8e8/0` | `dc/ef697be3a1/0` · `sha256:3a8862bfc9c00a54…` |
| 26 | #529 | 2026-04-23 | `READY_FOR_MERGE` | bug | y | after-follow-up | `primary-path-broken` | human follow-up (+QA weight) | 3 | 2 | - | `44/b04e8aa7a7/1` · `sha256:47ed2cb2fa41a986…` |
| 27 | #531 | 2026-04-23 | `READY_FOR_MERGE` | quality | n | - | - | - | 3 | 2 | - | `44/b04e8aa7a7/1` · `sha256:47ed2cb2fa41a986…` |
| 28 | #616 | 2026-05-09 | `AC_MET_BUT_NOT_A_PLUS` | quality | n | - | - | - | 0 | 1 | - | `4a/267c526c78/0` · `sha256:92cbf21bbe03cec1…` |
| 29 | #605 | 2026-05-12 | `AC_MET_BUT_NOT_A_PLUS` | quality | n | - | - | - | 1 | 1 | - | `e4/b2f746d002/0` · `sha256:4b8b218a2cd04dfe…` |
| 30 | #543 | 2026-05-12 | `READY_FOR_MERGE` | quality | n | - | - | - | 0 | 1 | - | `e4/b2f746d002/1` · `sha256:b2b27b663fcf0ed7…` |
<!-- dataset-table:end -->

### The 10 caught defects, paraphrased

| Issue | Class | Defect (paraphrase) |
|-------|-------|---------------------|
| #313 | `primary-path-broken` | The merge check assumed remote branches and reported false conflicts for unpushed worktree branches |
| #336 | `unmet-ac` | A skill change was missing from one of the three mirrored skill directories |
| #352 | `unmet-ac` | A permission-mode fix was missing from one mirrored skill copy |
| #368 | `unwired-option` | A platform flag and config field were registered but never consumed |
| #372 | `security-exposure` | An unauthenticated server was bound to all interfaces |
| #369 | `primary-path-broken` | An alternate backend was sent prompts it cannot execute |
| #370 | `security-exposure` | Untrusted comment text was interpolated into CI shell steps |
| #503 | `error-path` | Undefined programmatic options overwrote env and settings values |
| #528 | `unmet-ac` | The AC required an integration test, but only a mocked unit test existed |
| #529 | `primary-path-broken` | The spec-comment filter picked the wrong comment on real issue data |

### Summary

Counted over the **27 independent reviews**. Rows marked "Duplicate of" re-review the same work in a second checkpoint and are excluded.

| Category | Count | Original study |
|----------|-------|----------------|
| bug (caught) | **10** | 12 |
| quality only | 13 | 11 |
| clean | 4 | 2 |
| **total** | **27** | 27 |

## Three-way attribution (AC-2)

| Primary mechanism | Catches |
|-------------------|---------|
| human follow-up ("any gaps?") | **7** |
| de-anchoring (fresh standalone first verdict) | **3** |
| QA weight (skipped-by-orchestrator step) | **0** |
| **total = caught** | **10** |

Contributing, not primary: 1 human follow-up catch (#529) also needed a QA-weight step, confirming the filter against real issue data.

**Reading:** de-anchoring accounts for at most 3 of 27 reviews (11%). Those 3 were all `AC_NOT_MET` first verdicts on mirrored-file or test-shape ACs (#336, #368, #528). Even this is an upper bound. The prior-QA marker counts are lower bounds (see Signals), so "fresh" and "standalone" cannot be told apart from the transcripts alone. The headline "44% of fresh second looks caught a would-ship bug" becomes **26% (7/27) caught one only because a human asked again, and 11% (3/27) caught one on the first pass**.

## Reconciliation with the original 12/11/2

- **n matches (27), the split does not.** The original's 12 bugs included #421, #570 (and #533), #467 and #318. None of these is a `qa <N>` session in the checkpoints. The original analysis probably drew on a wider set of sessions (fullsolve, follow-up turns) than this candidate set. So it had more catches from a source that is now gone.
- **Two of #683's cited cases are here and agree:** #529 (caught after follow-up) and #503 (programmatic API broken: caught, `error-path`).
- The 4 clean / 13 quality rows include reviews the original may have counted as bugs. #447 (a schema field never set, despite a changelog claim) and #605 (an older `createPR` dropping `base`) are the closest calls; both were labeled non-blocking with medium confidence.
- The numbers were not forced to match.

## Seeded-defect fixture (AC-3)

[`qa-seeded-fixture/`](qa-seeded-fixture/) is a small `notes` CLI (`base/`) plus `defects.patch`, which claims to implement [`fixture-issue.md`](qa-seeded-fixture/fixture-issue.md). It plants one defect per class the dataset caught. Each class is the class of at least one caught row.

| Identifier | Class | Modeled on | `/qa` section that should catch it (lines at `cbc2fcee`) |
|------------|-------|------------|-------------------------------------------------------------|
| `formatNotes` | `primary-path-broken` | #313, #369, #529 | §3 QA vs AC (1854–1879), §6 Execution Evidence (1950–1989) |
| `parseSinceDate` | `unwired-option` | #368 | §2g Call-Site Review (1627–1742), §2h CLI Registration (1743–1853) |
| `readNotesFile` | `error-path` | #503 | §4 Failure Path & Edge Cases (1880–1891) |
| `0.0.0.0` | `security-exposure` | #372, #370 | §6f Trust-Boundary (2457–2483), reported as a Code Review **Issues** item or a not-met AC-4 row. §5 Risk Assessment (1892–1939) may also raise it, but the grader does not read §5 (see Known bias) |
| `vi.mock` | `unmet-ac` | #528 (also #336, #352) | §2d Test Quality Review (1523–1540), §6h Declared-Evidence (2484–2552) |

Ground truth: [`ground-truth.json`](qa-seeded-fixture/ground-truth.json). Each identifier occurs on exactly one line of `defects.patch`. That is enforced by `scripts/analytics/qa-seeded-grade.test.ts`, which also checks that every class appears among this document's caught rows. The section column gives #1068 its leave-one-out targets.

## Graders (AC-4, AC-5)

`scripts/analytics/qa-seeded-grade.ts`:

- **identifiers:** each planted defect lists `identifiers` in `ground-truth.json`: tokens a reviewer must write to describe it (the defect site or its `file:line`), not a pre-existing helper name. The defect counts as named when **any** alias appears. Aliases are matched case-insensitively. Each defect must have at least one alias that occurs on exactly one line of `defects.patch`; a test enforces it.
- **recall** = planted defects named in at least one finding ÷ planted defects. A mention outside a finding does not count. For example, an AC row marked `MET` that names a helper, or a Risk Assessment note naming a defect, is not a catch.
- **planted share** (renamed from `precision` in #1313) = distinct planted defects named ÷ (distinct planted defects named + non-planted findings). It is **not a false-positive rate**. Restatements of one planted defect (AC row, Issues bullet, Next steps) collapse to one. A real finding the fixture did not plant is listed as `unmatched` and reported, not scored as a mistake. With 0 findings it is undefined (`n/a`), not 0.
- **finding:** every top-level list item in a section whose heading names issues (blocker, issue, gap, finding, concern, problem, defect, bug, recommendation), plus every row of an **AC table** (header's first cell starts with `AC`) marking the AC not met or partially met (`AC_NOT_MET`, `NOT_MET`, `PARTIALLY_MET`, `❌`, "not met", "partially met"). `❌` in a build or test status table is not a finding, and the title `## QA Review for Issue #N` does not open an issues section, so its Mode and Branch bullets are not findings. **Risk Assessment is excluded.** The `/qa` template fills it in on every review (likely failure mode, not tested, sibling sites), so its bullets are analysis, not findings. Counting them scored a template-shaped verdict at precision 0.00. A test in `qa-seeded-grade.test.ts` pins this behaviour against a verdict shaped like a real posted review.
- **match:** a literal identifier with no word character or `.` before it and no word character after it. `catch` inside `catchAll` does not match, and `10.0.0.0` does not match `0.0.0.0`.

Worked example: [`sample-verdict.md`](qa-seeded-fixture/sample-verdict.md) names 3 of the 5 defects and lists 2 unrelated issues.

```
$ npx tsx scripts/analytics/qa-seeded-grade.ts --verdict docs/investigations/qa-seeded-fixture/sample-verdict.md --truth docs/investigations/qa-seeded-fixture/ground-truth.json
recall 0.60 (3/5)
planted share 0.60 (3/5)
unmatched findings 2
```

**Known bias:** a verdict that describes a defect without writing any alias is a miss (for example, "listens on every interface" without `0.0.0.0`). That under-counts recall relative to a human reader, and AC-7 measures it. It is deliberately not fuzzy-matched. The opposite bias, a neutral mention counted as a catch, is closed by reading recall from findings only. A finding that names an identifier while calling it correct would still count. AC-7's human pass is where that shows up. **Risk Assessment is invisible to the grader.** A `/qa` run that names `0.0.0.0` (or any identifier) only in §5 Risk Assessment, or only in the Trust-Boundary `**Finding:**` line, scores a recall miss for it. That is a deliberate under-count, the price of not counting §5's routine bullets as findings, and AC-7's human pass must report it per class, `security-exposure` first.

## Calibration (AC-6, AC-7, AC-8)

The tables below record the **original** (#1067) grader's scores. The recalibrated grader's re-grade of the same five reviews is in [Re-grade (#1313)](#re-grade-1313).

**Setup (2026-10-04).** A private throwaway repo got the fixture's `base/` on `main`, plus five identical issues (#1–#5, the `fixture-issue.md` body). Each issue has its own PR carrying `defects.patch`; the five diffs hash identically. One issue per run means no run sees an earlier run's comment, and §0a's prior-QA short-circuit can't fire.

Each run is `sequant run <N> --phases qa` (sequant 2.19.0, dev build at `79808fa7`). QA runs on opus with the default orchestrated weight (no `--full-qa`). The runs ran back to back from a launchd job, not from a Claude session. The repo carries a copy of this repo's `.claude/skills` at `79808fa7`.

**What was graded.** Each run's full QA review, meaning the phase agent's final report taken from its transcript. Under `sequant run`, the comment posted on the issue is the orchestrator's short summary, and it is graded separately below. Run 5's summary was never posted. `GitHubProvider.postComment` ignores `gh`'s exit status, so the failure was silent (#1312).

### Results (AC-6, AC-8)

| Run | Date | Model | Verdict | Recall | Precision | Findings | Planted named | Cost (USD) | Wall (s) |
|-----|------|-------|---------|--------|-----------|----------|---------------|------------|----------|
| 1 | 2026-10-05 03:13Z | opus | `AC_NOT_MET` (0/5) | 0.40 | 0.27 | 15 | 4 | 0.91 | 83 |
| 2 | 2026-10-05 03:14Z | opus | `AC_NOT_MET` (0/5) | 0.80 | 0.42 | 12 | 5 | 0.95 | 80 |
| 3 | 2026-10-05 03:16Z | opus | `AC_NOT_MET` (0/5, AC-1 partial) | 0.80 | 0.36 | 11 | 4 | 0.92 | 73 |
| 4 | 2026-10-05 03:17Z | opus | `AC_NOT_MET` (0/5, AC-1 partial) | 0.40 | 0.36 | 11 | 4 | 0.90 | 75 |
| 5 | 2026-10-05 03:18Z | opus | `AC_NOT_MET` (0/5) | 0.60 | 0.38 | 13 | 5 | 0.92 | 87 |
| **min / max / mean** | | | | 0.40 / 0.80 / **0.60** | 0.27 / 0.42 / **0.36** | | | 0.90 / 0.95 / **0.92** | |

- **Cost** is each run's `metrics.costUSD` in the fixture repo's `.sequant/metrics.json`, the SDK `modelUsage` sum. It is opus QA plus a small haiku helper call. The five runs together cost $4.60.
- **Posted summary graded instead:** recall 0.00 / 0.80 / 0.60 / 0.40 / n/a (run 5 not posted). The summary is a one-line-per-gap paraphrase, and it rarely keeps an identifier.

### Grader vs human (AC-7)

The maintainer's runner read every review and marked each planted defect caught or missed, regardless of wording. **Every run caught all 5 planted defects (human recall 1.00 in each of the five runs).** Each review ran the CLI and quoted the behaviour:
- `--format md` prints JSON;
- `--since` is ignored;
- a bad store prints `[]` and exits 0;
- `lsof` shows `*:4399`;
- the mocked test fails.

**Grader and human labels disagree on 10 of 25 overlapping cases; classes: `error-path` (5 of 5 runs), `unmet-ac` (3: runs 1, 4, 5) and `primary-path-broken` (2: runs 1, 4).** In each one the human marks the defect caught and the grader marks it missed. The other 15 agree. Three of the agreeing `formatNotes` hits (runs 2, 3, 5) are right for the wrong reason: the identifier came from a sentence about the `vi.mock` test, not from the format bug.

**Precision.** Human reading finds **0 false positives** across the five reviews. Every finding without a planted identifier is one of three things:
1. a restatement of a planted defect without its identifier (the AC row, the Issues bullet, Next steps);
2. a real defect that wasn't planted: the serve handler has no try/catch so a request hangs, `--port abc` gives `NaN`, and the PR body claims an integration test it doesn't have;
3. grader noise: intro bullets under `## QA Review for Issue #N`, where the heading matches "Issue", and `❌` rows in the build table.

The grader's 0.36 measures "share of findings naming a planted identifier", not a false-positive rate.

**Reading.** On this fixture, `/qa` under `sequant run` catches every planted defect, in all five runs, for about $0.92 each. The grader as built under-reads it by 40% on recall. The miss is concentrated in two identifiers, `formatNotes` and `readNotesFile`. Both name pre-existing `store.ts` helpers, not the defect site, and reviewers cite the site instead (`export.ts:25`, the empty `catch`). **The grader is not ready to be #1068's instrument.** Recalibration is tracked in #1313: identifiers at the defect site, a precision that doesn't penalise real extra findings, and no heading or status-table noise.

**Against the dataset.** The human second-look baseline in the Dataset table caught each of these five classes at least once in 27 reviews. The fixture's per-class human recall is 5/5 for every class. The fixture defects are easier than the field ones: each breaks a stated AC that the reviewer can run. Treat recall 1.00 here as a ceiling for "obvious, AC-visible" defects, not as the field catch rate.

## Reproducing this analysis

```bash
# Signals (needs the local entire/checkpoints/v1 branch; --github adds prior-QA markers)
npx tsx scripts/analytics/qa-second-look-mine.ts --github
# Graders, fixture integrity, miner signal rules
npx vitest run scripts/analytics/qa-seeded-grade.test.ts scripts/analytics/qa-second-look-mine.test.ts
```

⚠️ `entire/checkpoints/v1` exists only on the maintainer's machine. It must never be pushed: this repository is public, and the transcripts are private. Preserve it locally (do not prune it). The Source column cites each transcript by path and content hash, so a preserved copy can be verified against this table.

### Re-grade (#1313)

The five full QA reviews are committed as [`qa-seeded-fixture/reviews/run-N.md`](qa-seeded-fixture/reviews/) (extraction command in that README), so the grader can be re-run without new `/qa` runs. Aliases changed as follows:

| Defect | Was | Now |
|--------|-----|-----|
| format | `formatNotes` | `"markdown"`, `export.ts:25` |
| since | `parseSinceDate` | `parseSinceDate` (unchanged) |
| swallowed error | `readNotesFile` | `empty catch`, ``empty `catch` ``, `catch {` |
| bind | `0.0.0.0` | `0.0.0.0` (unchanged) |
| mock test | `vi.mock` | `vi.mock`, `export.test.ts` |

A bare `catch` was tried and dropped: it also matches "no try/catch" in the unrelated serve-handler finding.

| Run | Recall (was) | Planted share | Unmatched findings |
|-----|--------------|---------------|--------------------|
| 1 | 1.00 (0.40) | 0.71 (5/7) | 2 |
| 2 | 1.00 (0.80) | 0.63 (5/8) | 3 |
| 3 | 1.00 (0.80) | 0.63 (5/8) | 3 |
| 4 | 1.00 (0.40) | 0.63 (5/8) | 3 |
| 5 | 1.00 (0.60) | 0.63 (5/8) | 3 |

**Grader vs human: 0 disagreements of 25** (was 10 of 25; AC-1 allows ≤ 2). The unmatched findings are the real non-planted ones (serve handler without try/catch, unvalidated `--port`, the PR-body claim) plus restated AC rows whose text names no alias.

**Caveat: in-sample.** The aliases were chosen with these five reviews in view, so 25/25 is a fit, not a validation. #1068 should grade new runs it has not seen. The final alias set came from trying a bare `catch` first and reading what each alias matched, which is the tuning the caveat is about.
