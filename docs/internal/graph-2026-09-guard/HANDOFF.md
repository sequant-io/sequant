# Handoff — guard-2026-09, wave 2

Wave 1 + #1096 ran 2026-09-20 (record in `issue-graph.md` §Execution record). Seven PRs are open and verified; **nothing merges without the owner's consent per PR.** Merge order: #1113 (#1086, makes the suite hermetic) first, then any order; #1111 before #1117 if both are ready (shared `templates.test.ts`, trial merge clean). Do not merge #1082.

Paste into a fresh session once the wave-1 PRs it depends on have merged:

```
/graph-run

Graph `guard-2026-09`. Plan: `docs/internal/graph-2026-09-guard/PLAN.md` (§5 invariants, §7 D-13..D-18, §8 conventions), graph: `issue-graph.md` (read the wave-1 execution record), Phase 0: `lab-notes-phase0.md`. Base: `origin/main` after the wave-1 merges. Read main via `git show origin/main:<file>`, never the checkout.

## Wave 2 — frontier as of the merges

#1093 (judgment — strong policy flip; blocked by #1104 = PR #1112), #1097 (mechanical; blocked by #1053 = PR #1111 and #1106 = PR #1117), #1069 (mechanical; after #1070 = PR #1118 merges, same `batch-executor.ts`). #1096 is already merged-or-open (PR #1116) so #1087 (wave 3, blocked by #1096) can join this wave once #1116 merges. Every node's `## Release-graph plan — guard-2026-09` section has the file scope.

## Runner rules (PLAN §5, §8; constitution "Graph-run rules" incl. the 2026-09-20 additions)

- No full suite in worktrees, for exec AND qa: post a qa-addressed note on each issue before dispatch (the qa skill runs `npm test` and dies on the 30-min wall under 5+ agents). You run `npm test` once per PR from a clean shell, one at a time, foreground, `timeout 590`, output to a file (350–405 s idle).
- `sequant_run` with N issues runs 3 at a time. Spawn mechanical nodes first, then flip `.sequant/settings.json` to the strong policy for #1093, spawn, verify `--model opus` in `ps`, restore byte-equal.
- A recorded AC_NOT_MET with empty gaps/findings: read `errorContext.stdoutTail` in the run log; the parser takes the first `Verdict:` mention (#1119). After one real bounce, fix small specified findings yourself.
- Mutation markers: `failedTest` starts with the test file path; classify with `parseMutationMarkers` before opening the PR. Doc-gate tests in `scripts/` must call a production function (tautology detector). One AC per line, single-line `-m` commits, no `Co-Authored-By`, red tests outside the diff need an issue number + base-vs-head.
- Skill edits (#1093 this wave): `npm run lint:skill-sync` 44/44 (45 if #1104 added a file — check), no SKILL.md contains the word relay.
- Edit PRs/issues with `gh api -X PATCH repos/{owner}/{repo}/pulls/N -F body=@file`; `gh pr edit` fails. The pre-tool hook needs `cd /literal/worktree && git commit …` — a leading variable assignment makes it read staging from the main checkout.
- Merge-consent mode: stop at PR. Never rebase or force-push a pushed branch (the qa phase rebases onto origin/main itself — #1069 fixes that; expect it).

## After wave 2

Wave 3: #1094 (blocked by #1093), #1087 (blocked by #1096), #1098 (blocked by #1093), then gate #1109 (owner applies the ruleset). Wave 4: gate #1110. Record the wave in `issue-graph.md`, resolve OQs in PLAN §9 with strikethrough + evidence, append lessons to the constitution's "Graph-run rules".
```
