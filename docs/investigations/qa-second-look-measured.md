# QA second look, measured: does `--ready-gate` catch what the first verdict misses? (#1344)

**Status:** Pre-registered 2026-10-10 (owner-approved). Headroom pilot done (human-read recall 0.60 under the rubric). Arms on hold: the human read agreed with itself on 8 of 15 cells across two passes.

## Pre-registration (2026-10-10, committed before any scored run)

### Question

On a fixture whose planted defects the first `/qa` verdict tends to miss, does the shipped automated second look (`sequant run --ready-gate`) catch more of them than the first verdict alone?

### Arms

- **A (first verdict):** `sequant run <N> --phases qa`. Scored on the posted `/qa` verdict.
- **B (shipped second look):** `sequant run <N> --phases qa --ready-gate`. Scored on the gate's **final** verdict. The scorer reads the last QA review the run posts.

Both arms run at the same sequant version (recorded per run), on the same model policy (qa: opus, the repo default), against the same fixture PR. Each run is launched with `launchctl submit` outside any Claude session (#856). Before each run, the fixture PR is reset to its seeded head, so a ready-gate auto-fix in one run can't leak into the next.

### Fixture (held out)

This is a new fixture issue and PR on the private calibration repo. It reuses the #1067 `notes` base project, but has a different feature and **different defect classes**. Its 5 planted defects are taken from classes the first verdict missed or that the n=27 dataset never shows caught (#1272 AC-2's list):

| #   | Class                                    | Modelled on                                        | Shape                                                                                                                                                |
| --- | ---------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `missing-implementation`                 | #529/#570: a success report with no implementation | The PR's summary says the new behaviour (e.g. `notes import --dedupe`) is done. The code parses the flag and returns early with the input unchanged. |
| 2   | `vacuous-test`                           | #467: a test with zero assertions                  | The AC's named test runs the command but asserts nothing, or only `expect(result).toBeDefined()`.                                                    |
| 3   | `primary-path-broken` behind passing ACs | #421, #503                                         | The new helper is correct and unit-tested, but the CLI entry still calls the old function, so a user never gets the new behaviour.                   |
| 4   | `regression-deletion`                    | (dataset class, never caught)                      | The diff deletes an existing guard, e.g. a check that the store path exists, while touching the same function. No AC mentions it.                    |
| 5   | `docs-contract-drift`                    | (dataset class, never caught)                      | The README documents `--dry-run`, but the implementation spells it `--dryrun`.                                                                       |

Each defect gets grep-able aliases that occur on one line of the patch, with no self-pointing tags, under the same rules and integrity test as `qa-seeded-fixture/`. The ground truth is committed in `docs/investigations/qa-heldout-fixture/` with each defect's class, source and commit date. **#1068 must never read it while choosing sections** (#1272 AC-2); the file carries that warning in its first line.

### Metrics, per run

- **Grader recall:** the share of the 5 defects the verdict names by alias, using `scripts/analytics/qa-seeded-grade.ts` (#1313).
- **Human-read recall:** the share the owner judges caught, reading the review blind to arm. **This is the primary metric.** The grader was recalibrated in-sample (#1313), so on a new fixture it is only a cross-check.
- **Planted share:** the share of the verdict's findings that are planted defects.
- **Cost** (USD) and **wall time**, from the run log.
- **Final verdict string** and **exit code.**

### Headroom pilot (AC-2), before the arms

3 arm-A runs. If mean human-read recall is ≥ 0.90, the fixture has no headroom. The doc records "Stopped: no headroom", and the issue ends there with that as the result. Pilot runs are not reused as arm-A data.

### n and its derivation

**n = 8 per arm (16 runs).** One defect is 0.2 recall. Eight runs resolve a mean difference of 0.1, meaning one defect caught in half the runs, which is the smallest change worth acting on (making the gate the default costs every user a second QA pass). Cost estimate: arm A about $0.92 per run (#1067 calibration). Arm B is unmeasured, assumed ≤ $4 per run. Total ≤ about $40 plus the pilot.

### Noise floor and decision rule

- **Noise floor** = arm A's human-read recall spread (max − min) over its 8 runs. If that spread is 0, the floor is 0.2 (one defect).
- **B wins** if mean(B) − mean(A) > the noise floor **and** B catches at least one defect class that A never catches in any run. Then AC-5 files the follow-up proposing `--ready-gate` as the `sequant run` default.
- **Otherwise null.** The doc's null-result section lists, per defect, how many runs in each arm caught it. That shows which classes the second look also fails to catch.

### Run hygiene (mirrors #1272 AC-3)

A run that the 30-minute wall, a watchdog or a crash kills **counts as a miss in its arm and is never dropped** (#1344 AC-3). It is also listed in an "incomplete runs" table with its cause. If an arm has more than 2 such runs, the result is reported as inconclusive and is not decided.

### What I will not do after seeing results

Change n, the floor, the fixture or the metric. Any deviation goes in a dated "Deviations" section above the results.

## Deviations

- **2026-10-10, pilot build.** The pilot ran on a local dev build of sequant 2.19.0 (at or before `68446b02`), not a published release. The fixture PR's branch is `feature/24-add-notes-import`, and each run used `--force` so that a completed QA phase would run again on the reset head.
- **2026-10-10, human read format.** The owner judged each defect from the passage the grader matched, with the full reviews open beside it. The read was not blind, which does not matter for the pilot, because all 3 runs are arm A.
- **2026-10-10, "caught" defined (before the arms).** The pre-registration says "human-read recall" but never defines "caught". In the first pilot pass the owner compared runs: of near-identical findings, they picked the one that left the least room for interpretation. That standard can't score shuffled reviews one at a time, so it is replaced by a per-review rubric that uses the owner's own bar. Each defect in each review is scored on its own as one of:
  - **clear:** the review says what is wrong, where it is, and what it breaks. A stated consequence is enough, and no AC is needed (D4 has none by design). Someone fixing it would not need to investigate further. Only **clear** counts as caught.
  - **vague:** the defect is mentioned, but the consequence is missing or hedged (e.g. a one-line list item, or "dead export" with no broken user path).
  - **absent:** not mentioned.

  The **vague** count is recorded as secondary data, because a second look may turn vague findings into clear ones. The pilot is scored again under this rubric, with every passage in each review that mentions the defect, shuffled and without run labels. Both passes are reported below. The re-score follows from this change of standard, not from the first score. If the re-score reaches 0.90 or higher, the issue stops as pre-registered.
- **2026-10-10, first-pass excerpts were incomplete.** The first pass showed one excerpt per row, cut at 700 characters. For run 1 D4 and run 1 D5 the reviews hold stronger findings than the ones shown: an evidenced `src/store.ts:11-14` regression paragraph, and a full AC-3 NOT_MET row.

## Results

### Headroom pilot (AC-2)

3 arm-A runs on 2026-10-10 against the seeded head `76ec7784`. Each run's final verdict was `AC_NOT_MET` (exit 1). Cost is estimated at about $1.2–3.1 per run; the runs logged no exact figure.

| Run | Wall (s) | Grader recall | Human-read recall | Human-read catches |
|---|---|---|---|---|
| 1 | 97 | 1.00 | 0.60 | D1, D3, D5 |
| 2 | 79 | 1.00 | 0.20 | D4 |
| 3 | 85 | 1.00 | 0.80 | D1, D2, D4, D5 |
| **Mean** | 87 | **1.00** | **0.53** | |

Per defect, human read (runs caught, of 3): D1 `missing-implementation` 2, D2 `vacuous-test` 1, D3 `primary-path-broken` 1, D4 `regression-deletion` 2, D5 `docs-contract-drift` 2.

First pass (comparative standard, one excerpt per row): mean human-read recall 0.53.

**Second pass (2026-10-11, per-review rubric).** The 15 items were shuffled, shown without run labels, and each one listed every passage in its review that mentions the defect. Shuffle key: item 1 = run 2 D3, 2 = 1 D4, 3 = 3 D5, 4 = 2 D1, 5 = 3 D2, 6 = 1 D3, 7 = 2 D4, 8 = 3 D1, 9 = 1 D5, 10 = 2 D2, 11 = 3 D4, 12 = 1 D1, 13 = 2 D5, 14 = 3 D3, 15 = 1 D2.

| Run | D1 | D2 | D3 | D4 | D5 | Recall (clear) |
|---|---|---|---|---|---|---|
| 1 | vague | vague | clear | clear | clear | 0.60 |
| 2 | clear | vague | clear | clear | clear | 0.80 |
| 3 | vague | clear | vague | vague | clear | 0.40 |
| **Mean** | | | | | | **0.60** |

No defect was rated absent. Every review names all 5, as the grader found.

**Agreement between the two passes:** the two passes agree on caught versus not caught for 8 of 15 cells. The mean barely moved (0.53, then 0.60), but the cells that count as caught changed. For example, run 1 D1 went from caught to vague, and run 2 D3 from not caught to clear. Some passages that read almost the same also got different ratings within the second pass: D3 is "ids 1,1,2, and `runImport` never calls it, `src/import.ts:21`" in runs 2 and 3, and was rated clear and vague. As used here, the primary metric is not stable enough to separate the arms. Each arm-A run's recall ranges over 0.4–0.8 on the same fixture, so the noise floor (arm A spread) would likely be 0.4 or more. B would then need a mean near 1.0 to win.

**Decision:** mean human-read recall is 0.60 under the rubric, below 0.90, so the fixture has headroom by the pre-registered rule. The arms are **on hold pending the owner's decision**, because of the agreement finding above.

The grader found every defect's alias in every review. The owner judged 7 of those 15 matches as not caught, including some whose wording is close to a match judged caught in another run. The grader and the human read therefore disagree a lot on this fixture. Each arm's noise floor comes from its own human-read spread, so it already includes this disagreement.
