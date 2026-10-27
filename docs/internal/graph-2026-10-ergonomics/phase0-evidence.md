# Phase-0 evidence: graph-2026-10-ergonomics

Measured 2026-10-26 on the owner's machine (Claude Code 2.1.310, entire 0.11.3 → 0.12.1, sequant checkout at 7f44ec4c8). Four read-only audits ran in parallel: Claude Code transcripts (12 interactive sessions, 125 human turns), the 184 feedback/reference memories, the local environment, and the GitHub repo. Numbers below are the ones the founding doc cites; the rest live in the session.

## E-1 Hooks run twice per tool call

| Observation | Value |
|---|---|
| Checkouts where repo `.claude/settings.json` registers `pre-tool.sh` AND a `sequant*` plugin with `hooks/hooks.json` is enabled | 2 of 2 inspected (sequant: `sequant-dev@my-mods`; matcha-maps: `sequant@sequant`) |
| Same tool call logged twice at the same second in both timing logs | yes (`claude-timing.log`, repo copy and plugin copy) |
| Cost per extra copy, measured from the timing log | pre 70–120 ms, post ~40 ms |
| `sequant doctor` checks that would catch it | 0 (checks 4–5 look only at `.claude/hooks` existence and mode bits) |
| `sequant init` branches on an enabled plugin | no (`init.ts` never reads `enabledPlugins`) |

## E-2 Mutation verification is a hand procedure

| Observation | Value |
|---|---|
| Worktree or edit wipes attributed to a hand mutation (`git checkout <file>` over uncommitted work) | 5: #817, #906, #939, #1044, #1050; plus #883 (`rmSync` in a mutated cleanup path) |
| Gate PRs that tripped the hand-written marker contract | 2 of 4 (#1104); `}` in marker text parsed to nothing (#1305); markers lost through the PR-body chain four ways (#1316) |
| Code that produces a marker today | `renderMutationMarker` exists; nothing calls it from a run — the agent types the line |
| Code that proves the cited test actually ran | none; `/qa` §6i checks only that the named file is in the diff |
| Memories whose lesson is "QA claimed it without running it" | 33 of 184 |

## E-3 Skills talk to the human in prose

| Observation | Value |
|---|---|
| Human turns that were approvals | ~30 of 125 (merge consent 6, live writes 3, permission-to-start 6, enumerated "yes to all" items ~18 of which ~18 already carried "I recommend yes") |
| Owner requests for an interactive decision prompt instead of a prose list | 2 ("can you prompt the decisions in a questionnaire", "run through the decision via a question prompt") |
| Skills whose allowed-tools include `AskUserQuestion` | 3 of 20 (assess, verify, improve) |
| Corrections that were "did it happen / where is it" | 6 of 17 |
| Foreground `sleep` polls in interactive sessions | 52 calls, 48.7 min blocked (max 601 s, the Bash cap); background loops: 74 calls, 1.2 min |
| Skill text on waiting | exec §3 forbids background waits under the orchestrator (hook-enforced, #1032); no skill states the interactive rule |
| Generated comment volume | 15 issues: 50 comments, 130k chars, spec comments 4.5k–14k each, QA up to 9.6k; 0 uses of `<details>` in any skill or TS builder |
| Comment builders in TS | `buildQaVerdictComment` (batch-executor.ts:883), `merge-check/report.ts`, `review-residue.post.ts`; spec and interactive QA comments are built in skill prose and posted with `gh issue comment` (10 skills) |

## E-4 Repo-local (not portable)

| Observation | Value |
|---|---|
| CI wall clock on `main`, last 40 runs | median 8.5 min; `test` job 6.5–9.2 min; every other job ≤ 1.2 min |
| Remote branches matching a merged PR head | 149 of 164 non-main; `delete_branch_on_merge: false`; `cleanup-worktree.sh` already tolerates a missing remote branch (`git push origin --delete … \|\| true`, gated on `PR_STATUS = MERGED`) |
| Dependabot PRs closed unmerged in 60 days | 20 of 39 |
| Upstream-bot issues closed not-planned | 45 of 48; already #1442 |

## Already tracked (not re-filed)

#1442 upstream digest · #1368 merge queue · #1191 auto permission mode for spec/qa · #1361 vitest allowlist · #1513 incidents into docs.
