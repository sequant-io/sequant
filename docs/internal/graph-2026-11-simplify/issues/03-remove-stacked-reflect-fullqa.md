chore(cli)!: remove `--stacked`, `--reflect` and `--full-qa` — flags, `run.fullQa`, the MCP `fullQa` parameter and `run-reflect.ts`; `--chain` keeps working

**Epic:** graph-2026-11-simplify (F-10 cluster of #1501)   **Tier:** mechanical   **Execution:** sequant_run   **Blocked by:** #S-02 (both edit `bin/cli.ts`, `KNOWN_KEYS` in `settings.ts`, `types.ts` and `src/commands/run.ts`)

- **Blocked by**: #S-02

## Problem

D-1. In 453 recorded runs `--stacked`, `--reflect` and `--full-qa` were each used 0 times. `--reflect` is read once (`run-display.ts:297`) and calls `run-reflect.ts` (291 lines). `--stacked` implies `--chain` (`run.ts:67-74`) and threads a predecessor base through `worktree-manager.ts` and `batch-executor.ts:1406`. `--full-qa` exists as a flag, the `run.fullQa` setting (#982) and a `fullQa` parameter on MCP `sequant_run` (`src/mcp/tools/run.ts:655`). D-3 keeps `--chain`, so the stacked-only paths go and the chain paths stay. Founding doc §4, OQ-1.

## Decisions

| ID | Decision | Rejected |
|---|---|---|
| X-1 | `ExecutionConfig.fullQa` (#683) stays: `sequant ready` forces it on every gate pass (`settings.ts:383-389`). Only the opt-in surfaces go: `--full-qa`, `run.fullQa`, the MCP `fullQa` parameter | removing the config field (breaks `sequant ready`) |
| X-2 | The MCP input schema strips unknown keys (no `.strict()` in `src/mcp/tools/run.ts`), so a caller still passing `fullQa` is ignored, not refused. OQ-1's grep is the check; no new warning surface | a strict schema for one removed key |

## Prior fixes / producers

- Prior removals: #503–#508. `--stacked` landed in #605; `--full-qa` in #982.
- Producers: `bin/cli.ts`, `src/lib/settings.ts` (`KNOWN_KEYS.run`, schema, generated table), `src/mcp/tools/run.ts`, `src/commands/run.ts`, `src/commands/run-display.ts`, `src/lib/workflow/{types,batch-executor,worktree-manager,run-reflect}.ts`, `docs/reference/run-command.md`, `docs/features/`. Class: outcome per named surface.

## Acceptance Criteria

- [ ] AC-1: None of the three flags appears on `run` or `ready`. Evidence: `for c in run ready; do npx tsx bin/cli.ts $c --help; done | grep -cE -- '--stacked|--reflect|--full-qa'` → `0`
- [ ] AC-2: `run-reflect.ts` is gone and nothing imports it. Evidence: `grep -rl 'run-reflect' src bin --include='*.ts' | wc -l | tr -d ' '` → `0`
- [ ] AC-3: The MCP tool no longer accepts `fullQa` and the setting is gone. Evidence: `grep -c 'fullQa' src/mcp/tools/run.ts src/lib/settings.ts | awk -F: '{s+=$2} END{print s}'` → `0`
- [ ] AC-4: A settings file that sets `run.fullQa` loads with one warning naming the removal in 3.0. Evidence: `npx vitest run src/lib/settings.removed-keys.test.ts -t "fullQa"` → `≥ 1 passed, 0 failed`
- [ ] AC-5: `--chain` still provisions, rebases and resumes. Evidence: `npx vitest run src/lib/workflow/chain-preflight.test.ts src/lib/workflow/chain-resume.test.ts src/lib/workflow/chain-rebase.integration.test.ts` → `0 failed` (constraint)
- [ ] AC-6: User docs no longer offer them. Evidence: `grep -rlE -- '--stacked|--reflect|--full-qa|fullQa' README.md docs/reference docs/features docs/guides docs/getting-started | wc -l | tr -d ' '` → `0`
- [ ] AC-7: The changelog records the removal. Evidence: `awk '/^## \[Unreleased\]/,/^## \[[0-9]/' CHANGELOG.md | grep -cE -- '--stacked|--reflect|--full-qa'` → `≥ 1`
- [ ] AC-8: No skill-directory edits. Evidence: `git diff --name-only $(git merge-base origin/main HEAD)..HEAD | grep -cE '^(plugin/|\.claude/skills/|templates/skills/)'` → `0` (constraint)

OQ-1 (does any MCP caller pass `fullQa`): exec greps `~/Projects/harness` and `docs/internal/graph-*/HANDOFF.md` and records the count in the PR body; no AC depends on it.

## May touch

`bin/cli.ts` (the three `.option(` blocks only), `src/lib/settings.ts`, `src/mcp/tools/run.ts` and test, `src/commands/run.ts`, `src/commands/run-display.ts`, `src/lib/workflow/run-reflect.ts` and test (deleted), `full-qa.test.ts` (deleted), `types.ts`, `batch-executor.ts` and `worktree-manager.ts` (stacked branches only), their tests, `docs/reference/run-command.md` (flag rows only), CHANGELOG.

## Non-Goals

- The `/reflect` skill text (frozen; §10).
- `--chain`, multi-issue runs (#S-06), `sequant ready`.

## Done when

No flag, setting, MCP parameter or user doc offers stacked PRs, reflection or full-weight QA, and the chain suite is green.
