# Handoff — guard-2026-09, wave 3

Wave 2 ran and **merged** 2026-09-20 (record in `issue-graph.md`; main at `5917cf8c`). Wave 3 is unblocked. Do not merge #1082.

Paste into a fresh session:

```
/graph-run

Graph `guard-2026-09`. Plan: `docs/internal/graph-2026-09-guard/PLAN.md` (§5 invariants, §7 D-13..D-21, §8 conventions), graph: `issue-graph.md` (read both execution records), Phase 0: `lab-notes-phase0.md`. Base: `origin/main` at or after `5917cf8c`. Read main via `git show origin/main:<file>`, never the checkout.

## Wave 3 — two nodes, then the owner gate

#1094 (mechanical; hook golden corpus — `--harvest` is a maintainer step on the local machine, the exec-skill `--diff` step needs only the committed corpus; exec `SKILL.md` ×3) and #1098 (mechanical; downstream canary in `.github/workflows/ci.yml` + `next` soak in the release skill ×3). Both edit skills: run them sequentially or accept a skill-mirror merge round. Then gate #1109: the owner applies `scripts/ruleset-main.sh --print` by hand (required context is `test`, strict up-to-date) — nothing else runs until it is applied. Wave 4: gate #1110.

## Runner rules (PLAN §5, §8; constitution "Graph-run rules" incl. the 2026-09-20 additions)

- No full suite in worktrees, for exec AND qa: post a qa-addressed note on each issue before dispatch (held in wave 2: zero phase deaths). You run `npm test` once per PR from a clean shell, one at a time, foreground, `timeout 590`, output to a file (350–405 s idle).
- Real-git fixtures set `user.name`/`user.email` right after init/clone (D-20); emulate CI with `user.useConfigOnly=true` before pushing.
- `sequant_run` runs 3 at a time; flip `.sequant/settings.json` to the strong policy only for judgment nodes (none in wave 3), verify `--model` in `ps`, restore byte-equal.
- A recorded AC_NOT_MET with empty gaps/findings: read `errorContext.stdoutTail` (#1119). After one real bounce, fix small specified findings yourself; verify AC text literally before widening a fix (D-21).
- Mutation markers: `failedTest` starts with the test file path; classify with `parseMutationMarkers` before opening the PR. Doc-gate tests in `scripts/` must call a production function. One AC per line, single-line `-m` commits, no `Co-Authored-By`, red tests outside the diff need an issue number + base-vs-head (`scripts/settle-against-base.sh` once #1093 merges).
- Skill edits: `npm run lint:skill-sync` 0 diverged, no SKILL.md contains the word relay. The pre-tool hook needs `cd /literal/worktree && git commit …`.
- Merge-consent mode: stop at PR. Never rebase or force-push a pushed branch (after #1069 merges the qa phase merges instead of rebasing pushed branches).

## After wave 3

Gate #1109 (owner), then wave 4 gate #1110 (canary required, `next` soak, promote). Record the wave in `issue-graph.md`, resolve OQs in PLAN §9, append lessons to the constitution.
```
