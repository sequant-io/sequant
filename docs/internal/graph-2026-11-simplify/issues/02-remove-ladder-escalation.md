chore(cli)!: remove the model ladder and effort escalation — modules, `--model-ladder` and `--escalate-effort` on run and ready, their settings and docs; old logs and settings still load

**Epic:** graph-2026-11-simplify (F-10 cluster of #1501)   **Tier:** judgment   **Execution:** sequant_run   **Blocked by:** #S-01 (the repeat halt must stand on its own before the ladder that feeds the divergence halt goes; both edit the quality loop in `batch-executor.ts`)

- **Blocked by**: #S-01

## Problem

D-1. In 453 recorded runs (2026-01-21 to 2026-10-28) `--model-ladder` and `--escalate-effort` were used 0 times and neither setting is on in this repo. They are 605 + 116 lines (`model-ladder.ts`, `effort-escalation.ts`) plus wiring in `batch-executor.ts`, `phase-executor.ts`, `config-resolver.ts`, `settings.ts`, three schemas, and flags on both `run` and `ready` (`bin/cli.ts:442,450,670,676`). An advisor on the retry rung (#1138) changed neither verdicts nor loop counts. Founding doc §4, P-4, P-5.

## Decisions

| ID | Decision | Rejected |
|---|---|---|
| R-1 | Delete both modules, their tests, the four flag definitions, `run.modelLadder` and `effortEscalation`, and the ladder state in `batch-executor.ts` | keeping the modules behind a hidden flag |
| R-2 | Schemas keep reading `ladderRung`, `escalatedModel`, `escalationTrigger`, `escalationHistory` and `ladder_halt` as optional (I-2); nothing writes them | a schema `version: 2` |
| R-3 | A settings file that still sets `modelLadder` or `effortEscalation` loads, with one warning naming the removal in 3.0 | a hard error |
| R-4 | `divergence-halt.ts` stays (`ready-gate.ts`, `log-writer.ts`, `run-log-schema.ts` import it); the `SPEC_DIVERGENCE` halt keeps working with no ladder; the divergence-suspect block, whose only feed is the ladder snapshot, goes with the ladder | deleting `divergence-halt.ts` with the ladder |

## Prior fixes / producers

- Prior removals: #503–#508 (2026-04 descoping). Class: outcome per named surface.
- Producers: `bin/cli.ts` (flags), `src/lib/settings.ts` (schema, `KNOWN_KEYS`, defaults, the generated settings table), `src/lib/workflow/config-resolver.ts`, `batch-executor.ts`, `phase-executor.ts`, `metrics-writer.ts`, `log-writer.ts`; readers `state-schema.ts`, `run-log-schema.ts`, `metrics-schema.ts`, `src/commands/logs.ts`, `src/commands/stats.ts`; docs under `docs/reference/` and `docs/features/`.

## Acceptance Criteria

- [ ] AC-1: Both modules are gone and nothing imports them, tests included. Evidence: `grep -rlE 'model-ladder|effort-escalation' src bin --include='*.ts' | wc -l | tr -d ' '` → `0`
- [ ] AC-2: Neither flag appears on `run` or `ready`. Evidence: `for c in run ready; do npx tsx bin/cli.ts $c --help; done | grep -cE -- '--model-ladder|--escalate-effort'` → `0`
- [ ] AC-3: A settings file that sets `modelLadder` and `effortEscalation` loads with exactly one warning per removed key that names 3.0, and the run proceeds. Evidence: `npx vitest run src/lib/settings.removed-keys.test.ts` → `≥ 2 passed, 0 failed`
- [ ] AC-4: A pre-3.0 run log carrying `ladder_halt`, `escalationHistory` and ladder fields on its phases validates, and `sequant logs` renders it. Evidence: `npx vitest run src/lib/workflow/run-log-schema.legacy.test.ts` → `≥ 2 passed, 0 failed`
- [ ] AC-5: The `SPEC_DIVERGENCE` halt still fires with no ladder configured. Evidence: `npx vitest run src/lib/workflow/divergence-halt.test.ts` → `0 failed` (constraint)
- [ ] AC-6: User docs no longer offer the features. Evidence: `grep -rlE -- 'model-ladder|escalate-effort|modelLadder|effortEscalation' README.md docs/reference docs/features docs/guides docs/getting-started | wc -l | tr -d ' '` → `0`
- [ ] AC-7: The changelog records the removal. Evidence: `awk '/^## \[Unreleased\]/,/^## \[[0-9]/' CHANGELOG.md | grep -cE -- '--model-ladder|--escalate-effort'` → `≥ 1`
- [ ] AC-8: No skill-directory edits. Evidence: `git diff --name-only $(git merge-base origin/main HEAD)..HEAD | grep -cE '^(plugin/|\.claude/skills/|templates/skills/)'` → `0` (constraint)

`isGateTestEvidence` classifies none of these ACs as a gate (parse-check, 2026-11-04). AC-4's legacy test still earns its place only if it fails when the schema stops reading old fields: the PR body records that run (make `ladderRung` required → the legacy test fails; restore) in the `Mutation-verified:` format.

## May touch

`src/lib/workflow/model-ladder.ts`, `effort-escalation.ts` and their tests (deleted), `batch-executor.ts` and `batch-executor.model-ladder.test.ts`, `phase-executor.ts` and `phase-executor.{model-ladder,effort-escalation}.test.ts`, `config-resolver.ts`, `metrics-schema.ts` and `metrics-schema.effort-escalation.test.ts`, `state-schema.ts`, `run-log-schema.ts`, `log-writer.ts`, `metrics-writer.ts`, `types.ts`, `run-orchestrator.ts`, `divergence-halt.ts` and `ready-gate.ts` (comments and ladder-only branches; the `SPEC_DIVERGENCE` halt and the gate's loop unchanged), `src/lib/settings.ts`, `src/commands/run.ts`, `src/commands/ready.ts`, `src/mcp/tools/run.ts`, `bin/cli.ts` (the four `.option(` blocks only), `__fixtures__/` (one legacy run log), the named docs pages, CHANGELOG.

## Non-Goals

- `--stacked`, `--reflect`, `--full-qa` (#S-03).
- The ready gate's loop and `divergence-halt.ts`.
- Skills (I-1).

## Done when

No code, flag, setting or user doc offers the ladder or escalation, and every pre-3.0 log and settings file still loads.
