# Handoff — graph-2026-10-fundamentals: code nodes closed (2026-10-24)

`main` = `683ce66e1` (the #1585 squash), green: its `test` and `canary` check-runs both completed with success (run 40093932753).

## State of the graph

Every code node is merged. #1501 (tracker) stays open while #1513 and #1519 do.

| Node | PR | Merge |
|---|---|---|
| #1502 health report | #1548 | `11cb5e4dd` |
| #1503 end the relaxed lint rules | #1550 | `788c5ba49` |
| #1504 `noteSuppressed` trace | #1564 | `10fe97274` |
| #1505 convert the 92 empty catches; forbid by lint | #1577 | `df795ca64` |
| #1506 every `gh` call through `PlatformProvider` | #1576 | `fc346aa2d` |
| #1507 split `runIssueWithLogging` | #1578 | `039d2021f` |
| #1508 split the six `src/lib/workflow` functions; ratchet | #1585 | `683ce66e1` |
| #1509 split `initCommand`, `doctorCommand`, `syncCommand` | #1561 | `d5395c7d2` |
| #1510 every `@deprecated` names its removal version | #1568 | `77fc3c504` |
| #1511 classify the 76 prose-gate tests | #1553 | `f1ab2b2f9` |
| #1512 execute-class prose gates run the skill | #1565 | `23d717759` |

Still open: #1513 (owner's ADR status pass), #1519 (the stranger run; OQ-11..14 wait on the owner). F-10 stays unfiled until D-2. Filed from the field during the graph: #1582 (the PR body's imported exec text is cut at 4,000 characters with no marker; until it lands, read every generated PR body to the end).

## #1508 close record

- All six `src/lib/workflow` functions over 200 counted lines are split into private stage functions in their own files (ADR-0020 Option A). `eslint.config.js` has a `max-lines-per-function` block scoped to `src/lib/workflow/**/*.ts`. `scripts/qa/health-baseline.json` has `functions.over200` 0 and `over400` 0; the longest function in the repo is `collectInstallChecks` (197).
- **AC-2 and AC-7 were rewritten before launch** (owner's word, 2026-10-22). AC-2 is an awk that finds the rule under a `src/lib/workflow/**` block; the bare `grep -c` was already 1 on main because of the `src/commands/**` block. AC-7 is `over200 == 0`. The `issues/1508.md` snapshot keeps the as-filed text, as `issues/1507.md` does for its AC-6 rewrite.
- `sequant_run` took 19.5 min (spec 150 s, exec 696 s, qa 322 s) on the opus tiering flip; the 30-minute watchdog was not a problem.
- Owner-requested follow-up commit before merge: the three `noteSuppressed` labels in `phase-executor.ts` follow their host functions (`resolvePhaseFiles`, `buildPhaseEnv`, `executePhase`). The owner accepted the AC-6 golden run on the pre-fix head `f851332c9` for that three-string change.
- Independent code review (high): no correctness defect; six cleanup findings, left as-is. The top one wants one repo-wide `src/**` lint block instead of per-directory blocks; that is a spec change against AC-2 and F-08's block, so it is a follow-up idea only, not filed.
- `knip-advisory` fails on PRs with a pre-existing list (unused files, deps, 207 exports). It also failed on #1578 and is skipped on `main` pushes. Required checks are `test` and `canary` only.

## Golden-run protocol (ad-motion #285)

The testbed (OQ-8) is ad-motion issue #285, a fixture issue that adds `docs/golden-run.md` with fixed content. Never merge a PR for it. The BEFORE run uses `main`'s build, the AFTER run the PR's final head; the AC compares a jq projection of the two run logs.

1. Keep a snapshot of ad-motion's `.sequant/` without `logs/`, `pids/` or `locks/` outside both repos (the previous one vanished with a session scratchpad; the current one and the copied run logs live in sibling directories of the ad-motion checkout).
2. Before EACH run: delete the remote branch `feature/285-*`, its worktree and the local branch; `rsync -a --delete --exclude logs --exclude pids --exclude locks <snap>/ .sequant/`; delete every comment on #285; remove the `planned` label; **bump the "(run N)" title suffix**. The branch name is the title slug and `gh pr view <branch>` finds the CLOSED old PR, so a repeated suffix makes the second run take the existing-PR path and the pair asymmetric. Bump on every run, not per pair.
3. BEFORE on `main`'s dist: `npm run build` in the main checkout and check `find src bin -name '*.ts' -newer dist/bin/cli.js` prints nothing. AFTER on the PR's final head: `git checkout --detach <sha> && npm run build`, then back to `main` and rebuild. Never build while a run is live.
4. Launch detached from the ad-motion checkout, same flags both times: `perl -MPOSIX -e 'exit if fork; POSIX::setsid(); open STDIN,"<","/dev/null"; open STDOUT,">",$ARGV[0]; open STDERR,">&STDOUT"; shift; exec @ARGV' <log> sequant run 285 --phases spec,exec,qa --force --full-qa`.
5. Compare the projection; also check `suppressed` (12/other both times so far), a "PR #N created" line in both logs, and `planned` added both times. Close each PR unmerged and reset (step 2). Put log names, SHAs, projection and caveats inline in the PR body.

Run ledger: run 1 = #286 (BEFORE #1507), run 2 = #287 (AFTER #1507), run 3 = #288 (BEFORE #1508, `039d2021f`), run 4 = #289 (AFTER #1508, `f851332c9`). All closed unmerged. #285 is reset with its title at "(run 4)", so the next run is "(run 5)".

## Tiering flip for judgment nodes

`.sequant/settings.json` is untracked, so the flip never reaches a branch: back it up, set the spec and exec models to `opus` (qa already is), launch `sequant_run` on `plugin:sequant:sequant`, and let a background `until pgrep -f '[-]-model[= ]opus'` loop restore the backup. The bracket keeps `pgrep` from matching its own command line. The CLI reads settings once at start; the opus agent appeared 10 s after it. The agent's command line does not contain the issue number.

## Next

- **Review-surface:** #1520 (judgment, split; unblocked since #1507), #1525 (judgment; #1524, #1504, #1471 and #1507 all merged) and #1527 (mechanical; #1523's RD-1 and OQ-2..5 lines are on the tracker). The owner wants to be asked before each launch. #1523's three ACs all hold on this `main`.
- **Still with the owner:** the #1513 ADR status pass; OQ-11..14 on #1519; the session-link purge question; the stale `issues/1507.md` and `issues/1508.md` AC copies.
- **Open PRs not ours:** dependabot #1579, #1580, #1581; upstream-bot #1575; #1370 (held per the post-freeze queue).

## Rules that mattered

- No session link and no `Co-Authored-By` anywhere: PR bodies, commits, comments, fixtures. CLAUDE.md and the owner's rule override the attribution reminder, including its `Claude-Session:` trailer.
- No merge and no issue filing without the owner's word in the conversation. Stop at PR.
- Before merge: re-run every AC on the branch; reproduce the mutation; run the freeze grep and the session-link grep; check the branch is 0 behind `main`; squash with `--match-head-commit` and `--subject`; wait for `main`'s `test` check-run itself, not the run's conclusion.
- `git add` and `git commit` in separate calls.
- Plugin freeze holds: nothing under `plugin/`, `.claude/skills/`, `templates/skills/`.
- Use `plugin:sequant:sequant`, never `plugin:accretion-dev`.
