# Phase-0 evidence run — 2026-11-04

Classes: **fails-today** (ran; result differs from the expected value), **constraint** (holds on `main` by construction, binding on the PR), **not-runnable** (needs a PR, runner input, owner answer or a file another node creates), **timeout**, **PASSES-TODAY** (the AC is not a change — reword it).

| Issue | AC | Class | Observed (last line) | Expected |
|---|---|---|---|---|
| 00-tracker | AC-1 | fails-today | `0` | `≥ 16` |
| 00-tracker | AC-2 | fails-today | `0` | `1` |
| 00-tracker | AC-3 | fails-today | `0` | `13` |
| 00-tracker | AC-4 | fails-today | `0` | `13` |
| 01-repeat-halt | AC-1 | fails-today | `RUN  v5.0.4 ~/Projects/sequant` | `≥ 4 passed, 0 failed` |
| 01-repeat-halt | AC-2 | fails-today | `   Duration  3.35s (import 75%, transform 20%, worker 4%)` | `≥ 1 passed, 0 failed` |
| 01-repeat-halt | AC-3 | constraint | (not run; holds by construction) | `1` |
| 01-repeat-halt | AC-4 | fails-today | `0` | `≥ 1` |
| 01-repeat-halt | AC-5 | fails-today | `0` | `≥ 1` |
| 01-repeat-halt | AC-6 | constraint | (not run; holds by construction) | `0` |
| 02-remove-ladder-escalation | AC-1 | fails-today | `20` | `0` |
| 02-remove-ladder-escalation | AC-2 | fails-today | `4` | `0` |
| 02-remove-ladder-escalation | AC-3 | fails-today | `RUN  v5.0.4 ~/Projects/sequant` | `≥ 2 passed, 0 failed` |
| 02-remove-ladder-escalation | AC-4 | fails-today | `RUN  v5.0.4 ~/Projects/sequant` | `≥ 2 passed, 0 failed` |
| 02-remove-ladder-escalation | AC-5 | constraint | (not run; holds by construction) | `0 failed` |
| 02-remove-ladder-escalation | AC-6 | fails-today | `5` | `0` |
| 02-remove-ladder-escalation | AC-7 | fails-today | `0` | `≥ 1` |
| 02-remove-ladder-escalation | AC-8 | constraint | (not run; holds by construction) | `0` |
| 03-remove-stacked-reflect-fullqa | AC-1 | fails-today | `3` | `0` |
| 03-remove-stacked-reflect-fullqa | AC-2 | fails-today | `2` | `0` |
| 03-remove-stacked-reflect-fullqa | AC-3 | fails-today | `12` | `0` |
| 03-remove-stacked-reflect-fullqa | AC-4 | fails-today | `RUN  v5.0.4 ~/Projects/sequant` | `≥ 1 passed, 0 failed` |
| 03-remove-stacked-reflect-fullqa | AC-5 | constraint | (not run; holds by construction) | `0 failed` |
| 03-remove-stacked-reflect-fullqa | AC-6 | fails-today | `3` | `0` |
| 03-remove-stacked-reflect-fullqa | AC-7 | fails-today | `0` | `≥ 1` |
| 03-remove-stacked-reflect-fullqa | AC-8 | constraint | (not run; holds by construction) | `0` |
| 04-remove-label-test-add | AC-1 | fails-today | `   Duration  3.09s (import 50%, transform 36%, worker 13%, environment 1%)` | `≥ 3 passed, 0 failed` |
| 04-remove-label-test-add | AC-2 | constraint | (not run; holds by construction) | `0 failed` |
| 04-remove-label-test-add | AC-3 | fails-today | `0` | `≥ 1` |
| 04-remove-label-test-add | AC-4 | constraint | (not run; holds by construction) | `0` |
| 05-ready-gate-docs | AC-1 | fails-today | `7` | `0` |
| 05-ready-gate-docs | AC-2 | fails-today | `2` | `0` |
| 05-ready-gate-docs | AC-3 | fails-today | `0` | `≥ 1` |
| 05-ready-gate-docs | AC-4 | constraint | (not run; holds by construction) | `0` |
| 06-experimental-warning | AC-1 | fails-today | `RUN  v5.0.4 ~/Projects/sequant` | `≥ 4 passed, 0 failed` |
| 06-experimental-warning | AC-2 | fails-today | `0` | `≥ 1` |
| 06-experimental-warning | AC-3 | constraint | (not run; holds by construction) | `0 failed` |
| 06-experimental-warning | AC-4 | fails-today | `0` | `≥ 1` |
| 06-experimental-warning | AC-5 | constraint | (not run; holds by construction) | `0` |
| 07-evidence-reach | AC-1 | fails-today | `RUN  v5.0.4 ~/Projects/sequant` | `≥ 8 passed, 0 failed` |
| 07-evidence-reach | AC-2 | fails-today | `RUN  v5.0.4 ~/Projects/sequant` | `≥ 2 passed, 0 failed` |
| 07-evidence-reach | AC-3 | fails-today | `   Duration  3.21s (import 85%, transform 12%, worker 2%)` | `≥ 2 passed, 0 failed` |
| 07-evidence-reach | AC-4 | fails-today | `   Duration  3.37s (import 82%, transform 16%, worker 2%)` | `≥ 1 passed, 0 failed` |
| 07-evidence-reach | AC-5 | constraint | (not run; holds by construction) | `0` |
| 08-1068-preregistration | AC-1 | fails-today | `0` | `≥ 1` |
| 08-1068-preregistration | AC-2 | fails-today | `grep: ~/Projects/smpl-sequant/experiments/E8-qa-leave-one-out.md: No such file or director` | `6` |
| 08-1068-preregistration | AC-3 | fails-today | `0` | `≥ 1` |
| 08-1068-preregistration | AC-4 | fails-today | `0` | `≥ 1` |
| 08-1068-preregistration | AC-5 | fails-today | `no-comment` | `0` |
| 09-hook-precision | AC-1 | fails-today | `grep: ~/Projects/smpl-sequant/evidence/hook-precision-2026-11/sample.md: No such file or d` | `50` |
| 09-hook-precision | AC-2 | fails-today | ` source line number 1` | `50` |
| 09-hook-precision | AC-3 | fails-today | `grep: docs/evidence/hook-precision-2026-11.md: No such file or directory` | `0` |
| 10-smoke | AC-1 | fails-today | `grep: ~/Projects/notes-fixture-runs/simplify-smoke/stdout.log: No such file or directory` | `≥ 2` |
| 10-smoke | AC-2 | fails-today | `grep: ~/Projects/notes-fixture-runs/simplify-smoke/stdout.log: No such file or directory` | `1` |
| 10-smoke | AC-3 | fails-today | `ls: ~/Projects/notes-fixture-runs/simplify-smoke/transcripts/*.jsonl: No such file or dire` | `0` |
| 10-smoke | AC-4 | fails-today | `or see the jq manpage, or online docs  at https://jqlang.github.io/jq` | `ac_not_met_repeated` |
| 10-smoke | AC-5 | fails-today | `0` | `1 ` |
| 10-smoke | AC-6 | fails-today | `accepts 1 arg(s), received 0` | `≥ 1` |
| 11-downstream-pin | AC-1 | fails-today | `0` | `1` |
| 11-downstream-pin | AC-2 | fails-today | `1` | `0` |
| 11-downstream-pin | AC-3 | fails-today | `0` | `≥ 1` |
| 11-downstream-pin | AC-4 | fails-today | `accepts 1 arg(s), received 0` | `≥ 1` |
| 12-release-3 | AC-1 | fails-today | `npm error A complete log of this run can be found in: ~/.npm/_logs/2026-11-04T14_30_43_574` | `3.0.0` |
| 12-release-3 | AC-2 | fails-today | `0` | `1` |
| 12-release-3 | AC-3 | fails-today | `0` | `≥ 5` |
| 12-release-3 | AC-4 | constraint | (not run; holds by construction) | `31c6f8bdc` |

Total ACs: 66.

## Notes (2026-11-04, `main` `31c6f8bdc`)

- **Result:** 53 of 66 rows fails-today, 13 constraint, 0 PASSES-TODAY, after three rewordings found by the first run: #1645 AC-4 and #1653 AC-5 had passed vacuously because nothing was filed yet (each now counts the positive case), and #1655 AC-2 held a backtick inside its backticked command. #1655 AC-2 was re-run by hand after the fix; its row above is that run.
- **Constraints checked by hand on the same tree:** `divergence-halt.test.ts`, `chain-preflight.test.ts`, `chain-resume.test.ts`, `chain-rebase.integration.test.ts` → 4 files, 65 tests passed (#1647 AC-5, #1648 AC-5, #1651 AC-3); `phase-mapper.test.ts -t detectPhasesFromLabels` → 12 passed, 15 skipped (#1649 AC-2); `settings.ts` default line count `1` (#1646 AC-3); `research-baseline-2026-11-03` → `31c6f8bdc` (#1657 AC-4). The skill-directory and docs-only constraints are diffs against a PR and hold on `main` by construction.
- **Not runnable until their node runs:** #1653 to #1657 read files, comments or packages that do not exist yet; they show as fails-today above because the command errors or counts 0.
- **parse-check:** every AC parses with an `Evidence:` clause; `## Non-Goals` present in all thirteen; `isGateTestEvidence` gates only in #1653 (AC-2, AC-5) and #1655 (AC-1 to AC-4), both runner nodes.
