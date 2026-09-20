# Handoff — guard-2026-09, wave 2

Wave 1 + #1096 ran and **merged** 2026-09-20 (record in `issue-graph.md` §Execution record; main at `88588262`). All wave-2 blockers are on main. Do not merge #1082.

Paste into a fresh session:

```
/graph-run

Graph `guard-2026-09`. Plan: `docs/internal/graph-2026-09-guard/PLAN.md` (§5 invariants, §7 D-13..D-18, §8 conventions), graph: `issue-graph.md` (read the wave-1 execution record), Phase 0: `lab-notes-phase0.md`. Base: `origin/main` after the wave-1 merges. Read main via `git show origin/main:<file>`, never the checkout.

## Wave 2 — four nodes, all unblocked on main `88588262`

#1093 (judgment — strong policy flip; `settle-against-base.sh`, ruleset payload, skill lines ×3 mirrors), #1097 (mechanical; writer state matrix, read-only on the writers), #1069 (mechanical; `rebaseBeforePR` → merge, `batch-executor.ts` call site), #1087 (mechanical, wave 3 pulled forward: codex usage-limit mapping — flip #1096's two `it.fails` cases to `it` and own the AC-3 mutation record, D-17). No shared files among the four except #1093 and nothing else touching skills this wave. Every node's `## Release-graph plan — guard-2026-09` section has the file scope.

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
