feat(cli): the AC table on every surface — terminal run summary lines per criterion, an ACs column in sequant status, a block in sequant logs; all read the one record

**Epic:** graph-2026-10-review-surface   **Tier:** mechanical   **Execution:** sequant_run   **Blocked by:** #RS-02, #RS-04, #1505

- **Blocked by**: #RS-02
- **Blocked by**: #RS-04
- **Blocked by**: #1505

## Problem

The run summary prints phase names and durations; `sequant status` prints Issue, Title, Status, Phase; `sequant logs` prints phases per issue. None shows a criterion. The cold reader said the per-criterion verdict is the first thing they want to see and that "a terminal spinner as the first image loses me". With RS-02's record in place, this node renders it in the three places a human looks after a run, from the record only (I-2), replacing the phase line in the per-issue summary rather than adding a flag (RD-E, I-4).

Target shape, one line per AC, in the summary:

```
#943  3 of 5 met
  AC-1 met      npx vitest run src/lib/x.test.ts
  AC-2 met      src/lib/y.ts:120
  AC-3 pending  browser check
  AC-4 pending  browser check
  AC-5 unknown
```

## Acceptance Criteria

- [ ] AC-1: The terminal summary prints one line per AC from the record. Evidence: `npx vitest run src/lib/cli-ui/run-renderer.acs.test.ts` → `≥ 4 passed, 0 failed` (an `IssueSummary` with `acs: [{id, status, evidence}]` renders `N of M met` and one line per AC in id order; `unknown` renders as the word; an issue without `acs` renders the previous phase line; nothing in the renderer reads prose)
- [ ] AC-2: `sequant status` has an `ACs` column. Evidence: `npx vitest run src/commands/status.acs.test.ts` → `≥ 2 passed, 0 failed` (a tracked issue with 3 of 5 met shows `3/5`; one with no record shows `—`)
- [ ] AC-3: `sequant logs <run>` prints the block. Evidence: `npx vitest run src/commands/logs.acs.test.ts` → `≥ 2 passed, 0 failed` (a run-log fixture with `acs[]` prints the lines; one without prints nothing extra)
- AC-3 is classified as a gate test by `isGateTestEvidence`; the PR body carries its `SEQUANT_MUTATION` record (remove `acs[]` from the run-log fixture → the "prints the lines" case fails; restore).
- [ ] AC-4: The built CLI shows the column. Evidence: `npm run build > /dev/null 2>&1 && node dist/bin/cli.js status 2>/dev/null | grep -c 'ACs'` → `≥ 1`
- [ ] AC-5: No renderer parses prose (I-2). Evidence: `grep -rlE 'MET\|NOT_MET|\(MET\|' src/lib/cli-ui src/commands | grep -v test | wc -l | tr -d ' '` → `0`
- [ ] AC-6: No skill directory is touched. Evidence: `git diff --name-only $(git merge-base origin/main HEAD)..HEAD | grep -cE '^(plugin/|\.claude/skills/|templates/skills/)'` → `0` (constraint)

## Prior fixes / producers

- Producers of the summary: `renderSummary` implementations in `src/lib/cli-ui/` (#624, #647, #672 fixed duplicate headers and seeded cells). Three prior fixes on the renderer; the AC states the outcome (one line per AC on every renderer implementation), not a site.
- `src/commands/logs.ts` is #1471's and #1505's file; this node lands after both (Blocked-by).

## May touch

`src/lib/cli-ui/run-renderer-types.ts` (optional `acs` on `IssueSummary`), the renderer implementations, `src/commands/status.ts`, `src/commands/logs.ts` (one block, after #1505's), their tests, `docs/reference/run-command.md` and `state-command.md` (one paragraph each), CHANGELOG.

## Non-Goals

- Any new flag (I-4).
- The progress mod and `/qa` chat output (outside the repo; frozen).
- Any edit under `plugin/`, `.claude/skills/`, `templates/skills/` (I-1).

## Done when

The same AC record is visible, identically, in the run summary, `status` and `logs`.
