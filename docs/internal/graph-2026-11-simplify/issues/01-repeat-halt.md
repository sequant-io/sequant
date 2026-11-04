feat(run): the quality loop halts on a second consecutive AC_NOT_MET — its own counter, no ladder needed; maxIterations stays 3

**Epic:** graph-2026-11-simplify   **Tier:** judgment   **Execution:** split   **Blocked by:** #S-00

- **Blocked by**: #S-00

## Problem

D-2: keep `maxIterations` 3 and halt when `AC_NOT_MET` repeats (the #1162 rule). On matcha-maps #1162 the loop ran four exec passes into four `AC_NOT_MET` verdicts and fixed nothing; on fixture #34 (E7) one fix pass turned the verdict's named catch into a commit in 8 of 8 pairs. One pass on a refusal is supported; a second pass after a second refusal is not.

Today the only stop on that pattern is the divergence-suspect halt in `batch-executor.ts` (two consecutive divergence-suspect iterations), and its own comment says it is "reachable only with a ladder configured". D-1 removes the ladder in #S-02, which deletes the halt's feed. `qa-stagnation.ts` stops a re-run at the same SHA with no diff, which is not #1162's pattern (each pass made a diff). Founding doc §4, P-1, P-2, P-3.

## Decisions

| ID | Decision | Rejected |
|---|---|---|
| H-1 | A counter on the QA verdict in the quality loop: two consecutive `AC_NOT_MET` verdicts stop the loop before the next `/loop` spawn. Any other verdict, or no parsed verdict, resets it | reusing `consecutiveDivergenceSuspect` (fed only with a ladder; #S-02 deletes the feed) |
| H-2 | The run log records the stop the way #1254 records a ladder halt: the issue's `abortReason` begins `ac_not_met_repeated`, its `evidenceBundle` carries both verdicts' SHAs and failed AC ids, and the error category enum gains `ac_not_met_repeated` beside `ladder_halt` (additive, `version: 1`) | a new bundle format or top-level field |
| H-3 | `sequant run` and MCP `sequant_run` (same executor) only; the ready gate's loop is unchanged (D-2) | applying it to the ready gate |

## Prior fixes / producers

- Prior halts on the same loop: #581 (`qa-stagnation.ts`, same SHA / no diff), #995 and #971 (divergence-suspect and `SPEC_DIVERGENCE`, `divergence-halt.ts`), #1254 (`ladder_halt` persisted in the run log), the turn cap and the billing window (`haltedByBilling`). `git log --format='%h %ad %s' -S 'consecutiveDivergenceSuspect' -- src/lib/workflow/batch-executor.ts` lists the #995 commit.
- Producers of the loop's stop decision: `batch-executor.ts` (the outer `while (iteration < maxIterations)` at :2120 and the halt flags on the iteration state), `ready-gate.ts` (its own loop, out of scope). Class: the ACs state the outcome for every path through `sequant run`'s quality loop.

## Acceptance Criteria

- [ ] AC-1: Two consecutive `AC_NOT_MET` verdicts stop the loop with halt reason `ac_not_met_repeated`, with no ladder configured, and a single `AC_NOT_MET` followed by a passing verdict does not; a null verdict between two refusals resets the count. Evidence: `npx vitest run src/lib/workflow/batch-executor.repeat-halt.test.ts` → `≥ 4 passed, 0 failed`
- [ ] AC-2: The run log schema accepts the `ac_not_met_repeated` category with its `abortReason` and `evidenceBundle`, and every existing run log fixture still validates. Evidence: `npx vitest run src/lib/workflow/run-log-schema.test.ts -t "ac_not_met_repeated"` → `≥ 1 passed, 0 failed`
- [ ] AC-3: The default stays 3. Evidence: `grep -c 'maxIterations: z.number().positive().default(3)' src/lib/settings.ts` → `1` (constraint)
- [ ] AC-4: The run command reference documents the halt. Evidence: `grep -c 'ac_not_met_repeated' docs/reference/run-command.md` → `≥ 1`
- [ ] AC-5: The changelog records the change. Evidence: `awk '/^## \[Unreleased\]/,/^## \[[0-9]/' CHANGELOG.md | grep -c 'ac_not_met_repeated'` → `≥ 1`
- [ ] AC-6: No skill-directory edits. Evidence: `git diff --name-only $(git merge-base origin/main HEAD)..HEAD | grep -cE '^(plugin/|\.claude/skills/|templates/skills/)'` → `0` (constraint)

`isGateTestEvidence` classifies none of these ACs as a gate (parse-check, 2026-11-04). AC-1 is behaviour; its real-run half is #S-10 (`Execution: split`).

## May touch

`src/lib/workflow/batch-executor.ts` (the quality loop and its iteration state only), `src/lib/workflow/batch-executor.repeat-halt.test.ts` (new), `src/lib/workflow/run-log-schema.ts` and test, `src/lib/workflow/log-writer.ts`, `src/lib/workflow/types.ts`, `docs/reference/run-command.md` (the quality-loop section only), CHANGELOG.

## Non-Goals

- Changing `maxIterations`' default, the ready gate's loop, or `qa-stagnation.ts`.
- Removing the ladder (#S-02, which this blocks).
- Any skill edit (I-1).

## Done when

A `sequant run -Q` whose QA refuses twice in a row stops after the second refusal and says why in the run log, with no ladder configured.
