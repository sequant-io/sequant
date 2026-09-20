# Handoff — guard-2026-09, wave 1

Paste into a fresh session:

```
/graph-run

Graph `guard-2026-09`. Plan: `docs/internal/graph-2026-09-guard/PLAN.md` (read §5 invariants and §8 conventions first), graph: `issue-graph.md`, Phase 0: `lab-notes-phase0.md`. Base: `origin/main` at or after `e73d0c67` (2.16.0). Read main via `git show origin/main:<file>`, never the checkout.

## Wave 1 — six nodes, no edges among them

#1104 (marker contract docs — launch FIRST, it owns the exec-skill mirrors this wave), #1086 (hermetic suite, prefix scrub — merge its PR first when consented; until then the suite is red under the orchestrator), #1095 (fast-check properties, closes #1073), #1053 (copy-mode foreign symlink), #1106 (ownership gate side b, new `ownership-gate.ts`), #1070 (post AC_NOT_MET verdicts). All mechanical tier. Every node's `## Release-graph plan — guard-2026-09` section has the file scope and the region rules; two shared files this wave: `src/lib/templates.test.ts` (#1053 appends, #1106 deletes the old block only) and `src/lib/workflow/batch-executor.ts` (#1095 `buildQaVerdictComment` only, #1070 the `postQaVerdictComment` gate only).

## Runner rules (PLAN §5, §8; constitution "Graph-run rules")

- No full suite in worktrees: agents run only the test files their ACs name; you run `npm test` once per PR from a clean shell (433 s, 322 files). Never run two suites concurrently.
- Every exec dispatch says: mutation-marker `failedTest` starts with the test file path (`<file> > <describe> > <case>`), one AC per line, single-line `-m` commits, no `Co-Authored-By`, any red test outside the diff needs an issue number and a base-vs-head result in the PR body.
- Skill edits (#1104 this wave): `npm run lint:skill-sync` must stay 44/44; no SKILL.md may contain the word relay.
- After one AC_NOT_MET bounce, read the finding and fix it yourself if small and specified; a re-dispatched exec has no-op'd twice before.
- Edit PRs/issues with `gh api -X PATCH repos/{owner}/{repo}/pulls/N -f title=…` (same for `issues/N`); `gh pr edit` fails.
- Merge-consent mode: stop at PR. No merges without the owner's explicit consent per PR. Never rebase or force-push a pushed branch.
- Do not merge dependabot #1082 (vitest 5).

## After wave 1

Wave 2: #1093 (judgment, blocked by #1104), #1096 (judgment), #1097 (blocked by #1053, #1106), #1069 (after #1070 merges). Wave 3: #1094 (blocked by #1093), #1087 (blocked by #1096), #1098 (blocked by #1093), then gate #1109 (owner applies the ruleset). Wave 4: gate #1110 (canary required, `next` soak, promote). Record each wave in `issue-graph.md` under an execution-record heading, resolve OQs in PLAN §9 with strikethrough + evidence, and append new lessons to the constitution's "Graph-run rules".
```
