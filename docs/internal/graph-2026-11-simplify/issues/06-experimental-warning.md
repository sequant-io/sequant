feat(run): `--chain` and multi-issue runs print an "experimental" warning with their measured success rates — fixed, dated counts; the code stays

**Epic:** graph-2026-11-simplify   **Tier:** mechanical   **Execution:** sequant_run   **Blocked by:** #1648 (both edit `src/commands/run.ts`; #1648 removes `--stacked`'s implication of `--chain`)

- **Blocked by**: #1648

## Problem

D-3: mark `--chain` and multi-issue runs experimental, with a warning that names the measured success rates; the code stays. Measured on this repo's `.sequant/metrics.json` (453 runs, 2026-01-21 to 2026-10-28): multi-issue runs 41 of 87 `success`, single-issue 301 of 366; `--chain` 3 of 9 (and 2 of 7 in #604, 2026-05). Founding doc §4, P-7.

## Decisions

| ID | Decision | Rejected |
|---|---|---|
| W-1 | Fixed text with the counts and their source date, printed once per run to stderr before any worktree is provisioned; `--json` output unchanged | reading the user's own metrics (P-7); a suppression flag (new surface) |
| W-2 | Multi-issue means more than one issue number on the command line, any concurrency | counting only concurrency > 1 (the measurement did not split by concurrency) |

Text, exactly:

- `⚠ --chain is experimental: 3 of 9 recorded --chain runs succeeded (sequant's own runs to 2026-10-28; 2 of 7 in #604). Single-issue runs: 301 of 366.`
- `⚠ Multi-issue runs are experimental: 41 of 87 recorded multi-issue runs succeeded, against 301 of 366 single-issue runs (sequant's own runs, 2026-01-21 to 2026-10-28).`

## Acceptance Criteria

- [ ] AC-1: A `--chain` run prints the chain line, a two-issue run prints the multi-issue line, a `--chain` run of two issues prints both, and a one-issue run prints neither. Evidence: `npx vitest run src/commands/run.experimental-warning.test.ts` → `≥ 4 passed, 0 failed`
- [ ] AC-2: The run command reference marks both modes experimental with the same counts. Evidence: `grep -c '41 of 87' docs/reference/run-command.md` → `≥ 1`
- [ ] AC-3: Chain behaviour is unchanged. Evidence: `npx vitest run src/lib/workflow/chain-preflight.test.ts src/lib/workflow/chain-resume.test.ts` → `0 failed` (constraint)
- [ ] AC-4: The changelog records the change. Evidence: `awk '/^## \[Unreleased\]/,/^## \[[0-9]/' CHANGELOG.md | grep -ci 'experimental'` → `≥ 1`
- [ ] AC-5: No skill-directory edits. Evidence: `git diff --name-only $(git merge-base origin/main HEAD)..HEAD | grep -cE '^(plugin/|\.claude/skills/|templates/skills/)'` → `0` (constraint)

`isGateTestEvidence` classifies none of these ACs as a gate (parse-check, 2026-11-04).

## May touch

`src/commands/run.ts`, `src/commands/run.experimental-warning.test.ts` (new), `docs/reference/run-command.md` (the chain and multi-issue sections only), CHANGELOG.

## Non-Goals

- Changing chain or multi-issue behaviour, removing either (D-3), or `--concurrency`'s default.
- The MCP result shape.

## Done when

Anyone starting a chain or multi-issue run sees the measured rate before it starts.
