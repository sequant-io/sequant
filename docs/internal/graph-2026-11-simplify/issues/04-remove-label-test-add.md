fix(run)!: no label adds the `test` phase to a phase list the user or detection chose — remove the UI-label insertion in `determinePhasesForIssue` (closes #1631)

**Epic:** graph-2026-11-simplify (F-10 cluster of #1501)   **Tier:** mechanical   **Execution:** sequant_run   **Blocked by:** #1645

- **Blocked by**: #1645

## Problem

D-1 removes `/test`'s label auto-add; the `/test` skill stays. `determinePhasesForIssue` (`src/lib/workflow/phase-mapper.ts:200-208`) appends `test` whenever an issue carries a UI label, including on an explicit `--phases` list: `sequant run 930 --phases spec` ran spec then test on matcha-maps (#1631), and #857 was the same block. `--phases spec,test` or `--phases spec,exec,test,qa` stays the way to ask for the phase. Founding doc P-6.

## Decisions

| ID | Decision | Rejected |
|---|---|---|
| T-1 | Delete the insertion block. `--testgen` and `--security-review` adjustments in the same function stay: the user passed those flags | gating the block on explicit `--phases` only (#1631's first ask; D-1 removes the add) |
| T-2 | `detectPhasesFromLabels` (auto-detect mode, opt-in through `run.autoDetectPhases`) keeps choosing the UI workflow | removing label detection (not named by D-1) |

## Prior fixes / producers

- Prior: #857 (unrequested test phase in a spec-only batch; workaround `--phases`, which #1631 showed does not cover this path), #1631. `git log --format='%h %ad %s' -S 'hasUILabels' -- src/lib/workflow/phase-mapper.ts` → `14b811922 2026-03-11 refactor(#318)` only; the block predates the split.
- Producers of a phase list: `detectPhasesFromLabels`, `parseRecommendedWorkflow` (assess), `determinePhasesForIssue`, `config-resolver.ts` (`--phases`). Class: the AC states the outcome for every path into `determinePhasesForIssue`.

## Acceptance Criteria

- [ ] AC-1: For an issue labelled `frontend`, an explicit `["spec"]` stays `["spec"]`, an explicit `["spec","exec","qa"]` stays without `test`, and `--testgen` still inserts `testgen`. Evidence: `npx vitest run src/lib/workflow/phase-mapper.test.ts -t "label does not add test"` → `≥ 3 passed, 0 failed`
- [ ] AC-2: Auto-detect mode still picks the UI workflow for a UI label. Evidence: `npx vitest run src/lib/workflow/phase-mapper.test.ts -t "detectPhasesFromLabels"` → `0 failed` (constraint)
- [ ] AC-3: The changelog records the change. Evidence: `awk '/^## \[Unreleased\]/,/^## \[[0-9]/' CHANGELOG.md | grep -c '#1631'` → `≥ 1`
- [ ] AC-4: No skill-directory edits. Evidence: `git diff --name-only $(git merge-base origin/main HEAD)..HEAD | grep -cE '^(plugin/|\.claude/skills/|templates/skills/)'` → `0` (constraint)

## May touch

`src/lib/workflow/phase-mapper.ts` and `phase-mapper.test.ts`, `docs/reference/run-command.md` (phase-detection paragraph only), CHANGELOG.

## Non-Goals

- The `/test` skill and `--phases ...,test`.
- Auto-detect mode.

## Done when

A UI label never adds `test` to a phase list; the user asks for it by name.
