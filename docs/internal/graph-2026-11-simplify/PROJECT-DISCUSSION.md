# graph-2026-11-simplify: sequant 3.0, cut to the parts the measurements support

**Status:** plan, 2026-11-04, awaiting the owner's plan review. Nothing filed. Phase-0 measurements were taken on `main` at `31c6f8bdc` (tagged `research-baseline-2026-11-03`, the build every executor-swap run used) and on this checkout's `.sequant/metrics.json` and hook logs, on 2026-11-04. Issues are in `issues/` with placeholder numbers (`#S-NN`); the map and the DAG are in `issue-graph.md`; the Evidence run record is `phase0-evidence.md`.

**Sources.** The research knowledge base `admarble/smpl-sequant` (private): `claims/evidenced-answer-2026-11-03.md` (the synthesis of nine experiments and 172 scored runs), `plans/2026-11-03-simplification-proposal.md` (the seven kept parts, the three bins, D-1..D-8 with the owner's answers) and `decisions/log.md` (no fork, the tag, the downstream pin). Numbers below that come from those files say so; every other number was measured today with the command beside it.

## §1 Vision

Sequant measured level with a native Claude Code recipe on every pre-registered measure: recall on three held-out fixtures, and verified acceptance criteria on 15 replayed real issues across three executor swaps (E2 0.900 vs 0.917, E2b 0.983 vs 0.993, E2c 0.756 vs 0.844; all null), at 1.9 to 4.6 times the native arm's estimated cost (synthesis, "The one-paragraph answer"). What it measurably adds is narrow: the issue as the unit of work, spec's AC extraction and file list, an independent per-AC check, the per-AC table on the PR, a verdict that refuses, one fix pass on the gaps the verdict names, and a person at the merge. The owner adopted that shape on 2026-11-03.

This graph moves `main` toward it as far as the plugin freeze allows: it removes the zero-use surface D-1 names, stops the quality loop when the verdict refuses twice, stops the docs claiming a second look the measurement did not find, labels the two measured-against modes as experimental, and keeps the per-AC check from running Evidence that reaches production. It ships as 3.0, after the two downstream repos that call `npx sequant` unpinned are pinned. It also starts the two measurements that later cuts wait on: #1068's pre-registration and the hook precision sample.

## §2 MVP (one sentence)

The smallest change to `main` that makes sequant 3.0 publishable: the D-1 surfaces gone from code, help and docs; a quality loop that halts on a second consecutive `AC_NOT_MET`; no doc claiming the ready gate's second look; `--chain` and multi-issue runs warning with their measured rates; Evidence that names an env file, a production CLI or a live URL handed to a person instead of run; one smoke run of a `main` build; and the harness and matcha-maps pinned to 2.20.0. Human approval at exactly: every merge (stop-at-PR), the hook precision labels (#S-09), the #1068 pre-registration (#S-08), the smoke read (#S-10), the pin (#S-11) and the release (#S-12).

Includes: #S-00 to #S-12. #S-08 and #S-09 are off the release path by design (§8, reachability).

## §3 Non-goals

| Not in this graph | Why not now |
|---|---|
| Any edit under `plugin/`, `.claude/skills/`, `templates/skills/` | the plugin freeze holds (D-7: "not yet"); I-1 |
| Cutting qa, exec or fullsolve sections | waits for #1068's result, and the skill text waits for the lift (D-4, D-7) |
| Running #1068 | D-4 says pre-register now; the run is the owner's call once the estimate exists (§10) |
| Any hook change, including blocking needs-human Evidence in `pre-tool.sh` | D-5: no hook moves until the precision number exists |
| Removing `/test`, `/testgen`, `/reflect` skill text, `--ready-gate`, `sequant ready`, chain or multi-issue code | D-1 keeps `/test`; `/reflect` text is skill prose (frozen); D-2 keeps the ready gate's loop; D-3 keeps the chain code |
| Changing `maxIterations`' default (3) | D-2: keep 3, add the halt |
| The ready gate's own loop stopping on a repeated `AC_NOT_MET` | D-2 keeps the gate's loop as is; the halt is `sequant run`'s quality loop only |
| `run.denyPaths` / `--deny-path` (#1641 ask 2), the README security section (#1028, #1641 ask 1) | D-8 chose the pending-row route; the deny list and the docs stay on #1641 and #1028 |
| #1640, #1642, #1626's label fix, #1630 | open, related, not in D-1..D-8; listed in `issue-graph.md` as review candidates (RQ-2) |
| A fork | owner, 2026-11-03: no fork; the measured build is tagged |
| Pinning repos other than the harness and matcha-maps | §4: three repos already hold `sequant@^2.17.0`, which 3.0 cannot satisfy; the rest are not production executors |

## §4 Architecture as observed (2026-11-04)

**Phase 0 here is not a scratch install.** The foundation is sequant itself, and its behaviour was observed in E2c (30 runs at `31c6f8bdc` on a private mirror of matcha-maps, 2026-11-02 to 11-03) and in E7 (the ready gate on fixture #34). Today's pass re-measured usage and traced every call path a node touches.

**Usage, `.sequant/metrics.json`** (453 runs, 2026-01-21 to 2026-10-28; `python3` over `runs[]`, counting `flags[]` and `outcome`):

| Surface | Runs using it | Note |
|---|---|---|
| `--model-ladder`, `--escalate-effort`, `--stacked`, `--reflect`, `--full-qa`, `--ready-gate` | 0 each | `--policy` 98 (replay-shaped, 10-27 inventory) |
| `--chain` | 9, of which 3 `success` | #604 (2026-05): 2 of 7 |
| multi-issue (`issues.length > 1`) | 87, of which 41 `success` (47.1%) | single-issue 366, 301 `success` (82.2%); all runs 342 of 453 (75.5%) |
| `--quality-loop` | 121 | `qaIterations` ≥ 3 in 11 rows |

The metrics `source` is `run` on every row, so MCP use cannot be told apart (10-27 inventory). The MCP server is in use by the owner's graphs; `sequant_run` exposes a `fullQa` parameter (`src/mcp/tools/run.ts:655`), which #S-03 removes.

**Call paths the nodes touch:**
- **The divergence halt is dead without a ladder.** `batch-executor.ts` halts after `DIVERGENCE_SUSPECT_HALT_THRESHOLD = 2` consecutive divergence-suspect iterations, but its comment says the block is "reachable only with a ladder configured: `iterationStartSnapshot` is null otherwise". D-1 removes the ladder. So the #1162 rule (D-2) cannot be had by keeping that block; it needs its own counter on the QA verdict, and it must land before the ladder goes (#S-01 → #S-02). `divergence-halt.ts` (157 lines) is also imported by `ready-gate.ts`, `log-writer.ts`, `run-log-schema.ts` and `types.ts`, so it stays; the `SPEC_DIVERGENCE` halt (which fired without a ladder in E2) must survive #S-02.
- **`qa-stagnation.ts`** (#581) already stops a QA re-run at the same SHA with no diff (`SAME_SHA_NO_PROGRESS`, `LOOP_NO_DIFF`). It does not stop a loop that keeps producing diffs at a refusing verdict, which is #1162's pattern (four passes, four `AC_NOT_MET`).
- **The ladder and escalation** are 605 + 116 lines (`model-ladder.ts`, `effort-escalation.ts`), with flags on both `run` and `ready` (`bin/cli.ts:442,450,670,676`), settings `run.modelLadder` and `effortEscalation` (`settings.ts:644,653`), and optional fields in three schemas (`state-schema.ts:106-112`, `run-log-schema.ts` `ladder_halt` and `escalationHistory`, `metrics-schema.ts:87`). Pre-3.0 logs on disk carry those fields.
- **Unknown settings keys warn, they do not fail** (`settings.ts:879` detects them before Zod; `KNOWN_KEYS.run` lists `modelLadder` and `fullQa`). Removing a key from `KNOWN_KEYS` turns an existing setting into a generic "unknown key" warning; #S-02 and #S-03 make that warning name the removal.
- **`--reflect`** is read in one place, `run-display.ts:297`, which calls `run-reflect.ts` (291 lines). **`--stacked`** implies `--chain` (`run.ts:67-74`) and threads through `worktree-manager.ts` and `batch-executor.ts:1406`; the chain code stays (D-3).
- **The `/test` label auto-add** is one block, `phase-mapper.ts:200-208` in `determinePhasesForIssue`, which runs on explicit `--phases` lists too (#1631). `detectPhasesFromLabels` (`:73`) picks the UI workflow in auto-detect mode and is a different path.
- **Prompts are built in `src/`.** `getPhasePrompt` (`phase-executor.ts:1460`) appends a `promptContext` block in a sentinel; today only the loop phase gets one (`batch-executor.ts:2774`, `ready-gate.ts:936`). The qa prompt template is `phase-registry.ts:286`. So a code-only change can hand the qa agent a list of ACs not to run; whether the agent obeys it over the frozen skill's §6h (which says run every Evidence line) is unverified until the smoke (OQ-3).
- **`AcStatus` already has `pending`** (`ac-status.ts:24`), and the parser maps `PENDING` and `⚠` to it, so a pending row needs no new status.
- **Ready-gate docs** claim the second look in seven places (`run-ready-gate.md:3,7,29`, `ready-command.md:3,21`, the `run-command.md:258` heading "Ready Gate (post-QA second look)", whose anchor `run-ready-gate.md:62` links, and `run-command.md:279`). E7 measured +0.025 over the first verdict, null by #1344's rule (synthesis, Q1).

**Hook log (D-5).** The 10-27 inventory counted 538 pre-tool blocks for 2026-10-06 to 10-27 in `~/.sequant/logs/claude-hook.log`. That file rotates (keep 500 lines past 1,000, `pre-tool.sh:151`), and E2c's runs filled it: it now holds 442 blocks from 2026-11-02 and 11-03 only. Two plugin-data logs hold older blocks. Frozen copies taken today, so the frame stops moving:

| Copy under `~/.sequant/hook-log-freeze-2026-11-04/` | Blocks | Span | Top rules | sha256 (first 12) |
|---|---|---|---|---|
| `sequant-home.log` | 442 | 11-02 to 11-03 (E2c, sandboxed) | staged-secret 186, sensitive-file 186, worktree-boundary 62 | `f3f1e3855e98` |
| `plugin-sequant-dev.log` | 136 | 10-09 to 10-26 | env-dump 63, force-push 28, no-changes 24 | `d3381e5daee1` |
| `plugin-sequant.log` | 85 | 09-18 to 11-03 | no-changes 38, env-dump 20, commit-format 9 | `0d5d04096e34` |

663 blocks over 14 rules. A plain random 50 would be mostly E2c's two secret rules; #S-09 stratifies.

**Downstream callers.** `~/Projects/harness/scripts/launch.sh:24` runs `nohup npx sequant run …` unpinned, from inside the matcha-maps checkout, which has no `sequant` dependency; the harness CLAUDE.md names "Sequant 2.20, run as `npx sequant run`". A published 3.0 becomes their executor on the next launch. `sequant-landing`, `workout` and `workout-admin` declare `"sequant": "^2.17.0"`, which 3.0 does not satisfy. Fourteen other local repos have a `.sequant/` directory and no dependency (counted by a loop over `~/Projects/*/.sequant`); none is a production executor today. `npm view sequant dist-tags`: `latest` and `next` both 2.20.0.

**Platform contract.** Ruleset `CC` (id 12393605) active: `test` and `canary` required. Actions: `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false`; no node opens a PR from Actions. Label `graph-2026-11-simplify` does not exist; #S-00 creates it. `/release` Step 6 lands through a PR (#1131).

**Seams.** This graph owns: the quality-loop halt, the removals, the warning, the Evidence-reach classifier and its prompt block. It does not own: the QA skill's table layout (frozen; `buildQaVerdictComment` is #1605's), the per-AC producer (#1525, merged; #S-07 adds one field), the ready gate's loop.

## §5 Invariants

- **I-1 Plugin freeze.** No PR in this graph touches `plugin/`, `.claude/skills/` or `templates/skills/`. Each code node carries the constraint AC `git diff --name-only $(git merge-base origin/main HEAD)..HEAD | grep -cE '^(plugin/|\.claude/skills/|templates/skills/)'` → `0`.
- **I-2 Old records still read.** A 3.0 build reads every pre-3.0 run log, metrics row and state file without a validation error. Removed features stop writing their fields; the schemas keep reading them (optional, `version: 1` unchanged).
- **I-3 Outcome ACs where the class recurs.** #S-01, #S-02, #S-04 and #S-07 each have two or more prior fixes or producers (their `## Prior fixes / producers` blocks); their ACs state what must hold on every path.
- **I-4 Run the Evidence, don't reason it.** Every command was run on `main` `31c6f8bdc` on 2026-11-04; `phase0-evidence.md` records each as fails-today, constraint or not-runnable.
- **I-5 Stop-at-PR.** The runner opens PRs; the owner consents per merge. No standing consent (RQ-4).
- **I-6 Nothing private is published.** Hook-log lines, fixture ground truth and matcha-maps content stay in `admarble/smpl-sequant` or on this machine. Sequant's tracker and docs get counts, commit hashes and file names only.
- **I-7 Gate-test ACs carry their mutation record** (CLAUDE.md). `isGateTestEvidence` classifies six ACs as gates, all in runner nodes that change nothing in sequant's tree and run no `/qa` phase (#S-08 AC-2 and AC-5, #S-10 AC-1 to AC-4); each body says so. No code node has a gate AC; #S-02 still records a mutation run for its legacy-log test.

## §6 Per-node design

| Node | Inputs | Outputs | Failure modes | Done when |
|---|---|---|---|---|
| #S-00 tracker | this directory | docs PR, label, D-1..D-8 posted | docs PR conflicts with another graph's docs PR | directory on `main`, label exists, decisions on the tracker |
| #S-01 repeat halt | the quality loop in `batch-executor.ts`, `divergence-halt.ts`'s bundle | a verdict-repeat counter independent of `ladderState`; `ac_not_met_repeated` halt reason in the run log | halting the ordinary first `AC_NOT_MET → /loop → re-QA` cycle; a null verdict counted as a refusal | two consecutive `AC_NOT_MET` stop the loop with no ladder configured, and one does not |
| #S-02 ladder + escalation out | §4's list | modules, flags, settings, docs gone; schemas still read old fields | removing the `SPEC_DIVERGENCE` halt with the ladder; breaking old logs | no file imports either module; old logs parse |
| #S-03 flags out | `--stacked`, `--reflect`, `--full-qa`, `run.fullQa`, MCP `fullQa` | flags, setting, MCP param, `run-reflect.ts` gone | `--chain` broken with `--stacked`'s removal | `run`/`ready` help shows none; chain tests green |
| #S-04 label auto-add out | `phase-mapper.ts:200-208` | no label adds `test` to a chosen phase list | removing `detectPhasesFromLabels`' UI workflow by mistake | `--phases spec` on a `frontend` issue plans `spec` only |
| #S-05 ready-gate docs | three docs pages | the seven claims gone; mechanism described; anchor fixed | a broken link to the old anchor | grep finds none of the seven |
| #S-06 experimental warning | `run.ts` | one dated warning for `--chain`, one for multi-issue | stale numbers | warning printed with the measured counts and their date |
| #S-07 Evidence reach | issue ACs, `getPhasePrompt` | `classifyEvidenceReach`; qa prompt block; run log `acs[].reach`; terminal "needs a person" lines | false positives on a URL in a grep pattern; the agent ignoring the block (OQ-3) | classifier fixture green; qa prompt carries the block |
| #S-08 #1068 pre-reg | fixture #34, #1272's rules, E6/E6b costs | a pre-registration committed in smpl-sequant, a hash comment on #1068 | ground truth leaking into the comment | committed, owner-approved, comment carries no identifier |
| #S-09 hook precision | the frozen logs | a 50-row labelled sheet (private), counts in `docs/evidence/` | sample dominated by two rules | precision per rule published as counts |
| #S-10 smoke | a `main` build after #S-01..#S-07 | a smoke report on the tracker | a needs-human command executed; the halt not reached (honest SKIP) | owner answers the smoke question |
| #S-11 pin | `launch.sh`, harness CLAUDE.md, matcha-maps | both run 2.20.0 by name | a lockfile bump shipping to production | `grep` shows the pin; the owner signs the route |
| #S-12 release | `main` after everything | `sequant@3.0.0` on `next`, then `latest` on the owner's word | publishing before the pin | `npm view` shows 3.0.0 |

## §7 Decisions

The owner's answers of 2026-11-03 (proposal, "Owner answers"), verbatim:

- **D-1:** F-10 removes the model ladder and effort escalation (model-ladder.ts, effort-escalation.ts and their flags), --stacked, --reflect and /reflect (the skill text after the freeze lifts), --full-qa, and /test's label auto-add (#1631). The /test skill stays.
- **D-2:** keep maxIterations 3 and halt when AC_NOT_MET repeats (the #1162 rule); the ready gate keeps its loop and drops its second-look claim from the docs.
- **D-3:** --chain and multi-issue runs are marked experimental, with a warning that names the measured success rates; the code stays.
- **D-4:** pre-register #1068 now for qa's sections on fixture #34, with the cost estimated before any run; exec and fullsolve later.
- **D-5:** hand-label 50 of the 538 pre-tool blocks before any hook change.
- **D-6:** a new graph, graph-2026-11-simplify, whose founding doc cites the synthesis and links the nodes that already exist in #1501, #1523 and #1602 rather than moving them.
- **D-7:** not yet; src/ and bin/ work and #1068 go first under the freeze, and the lift stays with the plugin directory review.
- **D-8:** an Evidence line that names an env file, a production CLI or a live URL becomes a pending row with the command shown, run by a person (as #1630 proposes for CI).

Plan-time decisions (each with what lost):

| ID | Decision | Rejected |
|---|---|---|
| P-1 | "Repeats" means two consecutive QA verdicts in one run's quality loop are both `AC_NOT_MET`; any other verdict, or no verdict, resets the count. The halt fires before the second `/loop` spawn | counting non-consecutive refusals (a loop that recovers then regresses is not #1162's pattern); halting on the first `AC_NOT_MET` (kills E7's 8-of-8 one-pass fix) |
| P-2 | The halt is its own counter, not the divergence block with the ladder condition dropped | reusing `consecutiveDivergenceSuspect` (it counts diff-producing iterations and is fed only with a ladder; #S-02 deletes its feed) |
| P-3 | #S-01 lands before #S-02 | one combined node (the halt is a behaviour change, the removal is mechanical; separate verdicts) |
| P-4 | Schemas keep reading removed fields; writers stop writing them | a schema `version: 2` (every reader changes for no reader's benefit) |
| P-5 | A removed settings key loads with a warning that names its removal and the 3.0 changelog entry | a hard error (a repo with `modelLadder` set would stop running on upgrade) |
| P-6 | "Label auto-add" means the insertion block in `determinePhasesForIssue`; `detectPhasesFromLabels`' UI workflow in auto-detect mode is unchanged | removing label detection altogether (D-1 names the add, and auto-detect mode is opt-in through settings) |
| P-7 | The D-3 warning prints fixed, dated counts from §4 (sequant's own metrics to 2026-10-28) | reading the user's metrics live (a new user has none, and an old user's rate measures their repo, not the mode) |
| P-8 | Evidence reach is classified in code and handed to the qa agent through `promptContext`; the terminal summary prints each needs-human AC with its command; the skill's §6h text changes after the lift | a hook that blocks the commands (D-5); waiting for the lift to do anything (D-7 puts `src/` first) |
| P-9 | "Needs a person" = an `--env-file` flag or a `.env` path; a first word in a fixed production-CLI list (`vercel`, `supabase`, `netlify`, `fly`, `heroku`, `wrangler`, `railway`, `aws`, `gcloud`, `az`); or an `http(s)` URL whose host is not `localhost`, `127.0.0.1`, `0.0.0.0` or `[::1]` | a configurable list (new surface; add one when someone asks) |
| P-10 | The #1068 pre-registration lives in smpl-sequant as `experiments/E8-qa-leave-one-out.md`; #1068 gets the commit hash and the cost estimate | writing it in sequant (fixture #34's ground truth must not reach a shared page, I-6) |
| P-11 | Hook blocks are sampled stratified by rule across the three frozen logs (proportional, at least 2 for any rule with 2 or more blocks), with a fixed seed; the runner proposes labels and the owner confirms each | a plain random 50 (about 28 would be E2c's two secret rules); the owner labelling from scratch (50 rows of context reading) |
| P-12 | The smoke runs on `admarble/notes-fixture` with two new smoke issues, from a `main` build, launched by `launchctl submit` as `run <B> <A> --chain` (B first, since `--chain` halts on A's designed failure), under E2c's `sandbox-exec` deny profile as it stands: it denies the matcha-maps checkout, seed and worktrees, `~/.claude/secrets.env`, every `.env.local` under the home directory and the Vercel token directory; the smoke's `notes-fixture-worktrees` paths are outside it (read 2026-11-04) | the ad-motion testbed (#1507's) has no Evidence that reaches outside the worktree, and a needs-human AC on a real repo is the risk the node exists to remove |
| P-13 | 3.0 goes to `next` first and `latest` on the owner's word, as the release checklist does | publishing straight to `latest` |

## §8 Issue conventions

- One line per AC with a trailing `Evidence:` clause; `## Non-Goals` in every body; edges as `- **Blocked by**: #S-NN` list items under the metadata line, substituted to real numbers in one `gh issue edit` pass after filing (`perl -pi -e`, never BSD `sed`), then grepped for leftover `#S-\d`.
- Tiers: `judgment` for #S-01, #S-02, #S-07, #S-08, #S-10; `mechanical` for the rest. Execution: `sequant_run` for code nodes, `split` where a behaviour AC needs the smoke, `runner` or `owner` for the rest.
- **Merge consent:** stop-at-PR (I-5) unless the owner grants standing consent at review.
- **Repo prep:** none new; the constitution, `worktree_setup.sh` and commit hooks are in place from earlier graphs.
- **Reachability:** every node is on the path to #S-12 except #S-08 and #S-09, which serve D-4 and D-5 (the measurements later cuts wait on) and block nothing in this graph.
- **Shared merge points:** `bin/cli.ts` (#S-02, #S-03: one `.option(` block removed per flag, nothing else), `src/lib/settings.ts` `KNOWN_KEYS` (#S-02, #S-03), `batch-executor.ts` (#S-01, #S-02, #S-07: sequenced), `src/commands/run.ts` (#S-03, #S-06: sequenced), `docs/reference/run-command.md` (#S-02, #S-03, #S-05, #S-06: each edits only its own rows or section), `CHANGELOG.md` (`merge=union`; each node adds its own `### Removed` or `### Changed` line under `[Unreleased]`).

## §9 Open questions

| ID | Question | Resolved by |
|---|---|---|
| OQ-1 | Does any MCP caller pass `fullQa`? Metrics cannot say (`source` is `run`) | #S-03: a grep of the owner's harness and graph docs at exec. The MCP input schema strips unknown keys (no `.strict()`), so a caller still passing `fullQa` would be ignored silently, and the grep is the only check |
| OQ-2 | Do the 11 runs with `qaIterations` ≥ 3 contain two consecutive `AC_NOT_MET`? If none did, the halt has never been the binding stop | #S-01: count from the run logs at exec, recorded in the PR body (no AC depends on it) |
| OQ-3 | Does the qa agent obey a prompt block telling it not to run an Evidence line, while the skill's §6h says run each one? | #S-10: the smoke's transcript grep |
| OQ-4 | Which E6/E6b cost per `/qa` run sets #1068's estimate, and how many sections does the leave-one-out cover? | #S-08 |
| OQ-5 | Do any of the fourteen `.sequant/` repos without a dependency need a pin? | #S-11: the owner names them or none |
| OQ-6 | Does the smoke's needs-human AC end as `NEEDS_VERIFICATION` or as something else, given the frozen skill decides the verdict? | #S-10 records it; a wrong verdict is a post-lift skill fix, not a reopen |

## §10 Parked directions

- **Post-freeze:** the `/reflect` skill text (D-1); §6h's handling of needs-human Evidence in the qa skill (D-8's skill half); the qa cuts #1068 chooses; #1622, #1606, #1459, #1455, #1400, #1457.
- **After #S-08:** running #1068 (owner's word, at the estimate); exec and fullsolve by the same method (D-4, "later").
- **After #S-09:** any hook change, with the precision per rule as its input.
- **After a tally:** the test-tautology detector (#940 closed; the false-positive tally the inventory asked for does not exist yet).
