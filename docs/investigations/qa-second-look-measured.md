# QA second look, measured: does `--ready-gate` catch what the first verdict misses? (#1344)

**Status:** Pre-registered 2026-10-10 (owner-approved); no scored run yet.

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

## Results

(empty until the pilot)
