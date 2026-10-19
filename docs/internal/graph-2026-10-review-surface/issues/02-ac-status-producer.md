feat(run): one producer for per-AC status — parse the QA phase output, write the state record through updateACStatus, carry acs[] in the run log; unknown is a status

**Epic:** graph-2026-10-review-surface   **Tier:** judgment   **Execution:** sequant_run   **Blocked by:** #RS-01, #1504, #1471, #1507

- **Blocked by**: #RS-01
- **Blocked by**: #1504
- **Blocked by**: #1471
- **Blocked by**: #1507

## Problem

`state-schema.ts` defines a per-AC record with `status` and `evidence`; `StateManager.updateACStatus` can write it; nothing calls it. The record is set to `pending` at registration and stays there (17 of 17 items on this checkout). Every renderer in this graph reads that record (I-2), so it needs one producer: at the point where the QA phase output is already parsed for counts (`parseQaSummary`, phase-executor.ts:615, consumed at :1272), parse per-AC status with the function RS-01 measured, write each AC through `updateACStatus` with its evidence text, and copy the list into the run log's issue entry as an optional `acs[]`. An AC the parse cannot classify is written `unknown` (I-8). A failed state write is counted through #1504's helper (I-9), which is why this waits for it.

The hook lives in a new sibling module called from one line, because `phase-executor.ts` is #1471's file and `batch-executor.ts` is #1507's; this node lands after both.

## Acceptance Criteria

- [ ] AC-1: The parse reproduces the fixture's ground truth. Evidence: `npx vitest run src/lib/workflow/ac-status.test.ts -t "fixture"` → `≥ 10 passed, 0 failed` (one case per fixture in `__tests__/fixtures/qa-comments/`; statuses equal `expected.json`; an AC id absent from the comment yields `unknown`)
- AC-1 is classified as a gate test by `isGateTestEvidence`; the PR body carries its `SEQUANT_MUTATION` record (flip one status in `expected.json` → that fixture's case fails; restore).
- [ ] AC-2: The state record is written through the existing updater against a real temp state file. Evidence: `npx vitest run src/lib/workflow/ac-status.integration.test.ts` → `≥ 3 passed, 0 failed` (real `StateManager` on a temp dir, no fs mock; after a QA phase result, `getAcceptanceCriteria(issue).items` carry the parsed statuses and evidence; an AC in the comment but not in the issue is ignored and counted; a `chmod 0444` state file makes the write fail and `suppressed.byScope.state` increments)
- [ ] AC-3: The updater has a caller. Evidence: `grep -rn 'updateACStatus(' src --include='*.ts' | grep -v test | grep -vc 'state-manager.ts'` → `≥ 1`
- [ ] AC-4: The run log carries `acs[]` as an optional field and the schema version is unchanged. Evidence: `grep -c 'acs' src/lib/workflow/run-log-schema.ts` → `≥ 1` and `grep -c 'version: z.literal(1)' src/lib/workflow/run-log-schema.ts` → `1`
- [ ] AC-5: Renderers do not re-parse prose (I-2). Evidence: `grep -rlE 'MET\|NOT_MET|\(MET\|' src/lib/cli-ui src/commands | grep -v test | wc -l | tr -d ' '` → `0`
- [ ] AC-6: No test lines are added beyond the two files above and no skill directory is touched. Evidence: `git diff --name-only $(git merge-base origin/main HEAD)..HEAD | grep -cE '^(plugin/|\.claude/skills/|templates/skills/)'` → `0` (constraint)

## Prior fixes / producers

- Producers of the AC record: `StateManager.updateAcceptanceCriteria` (registration, from `parseAcceptanceCriteria`) and `updateACStatus` (dead). Two producers of one record; this node makes the second one live and leaves the first unchanged, so the AC states the outcome: after any QA phase, the record reflects the QA output.
- Prior fixes on QA-output parsing: `parseQaVerdict` first-match fix (v2.18.0), `parseQaSummary` (#964), `SEQUANT_PHASE` marker parsing. Class: the output format is skill-owned and frozen, which is why §10 names the marker as the long-term producer.

## May touch

`src/lib/workflow/ac-status.ts` (new), `ac-status.test.ts`, `ac-status.integration.test.ts` (new), the one call line at the QA summary hook (in `phase-executor.ts` after #1471, or the module #1507 extracts), `src/lib/workflow/log-writer.ts` and `run-log-schema.ts` (optional `acs[]`, after #1504's block), CHANGELOG.

## Non-Goals

- Rendering (RS-03).
- Changing the QA skill's output (frozen; §10).
- Any status other than the five: `met`, `not_met`, `pending`, `blocked`, `unknown`.
- Any edit under `plugin/`, `.claude/skills/`, `templates/skills/` (I-1).

## Done when

After a QA phase, `state.json`'s AC items and the run log's `acs[]` say what QA said, per criterion, with `unknown` where it could not tell.
