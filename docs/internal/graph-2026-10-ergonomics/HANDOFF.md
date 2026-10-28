# Handoff — graph-2026-10-ergonomics: W0 merged (2026-10-27)

`main` = `ba5510b53` (the #1620 squash), green on `test` and `canary` (run 40645730073).

## State of the graph

| Node                | PR    | Merge       | Verdict → runner work                                                                                                                                      |
| ------------------- | ----- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1602 tracker docs  | #1607 | `15e352cd5` | reopened after the merge auto-closed it; stays open until #1606 lands                                                                                      |
| #1603 hook channels | #1618 | `ec15551b4` | `AC_MET_BUT_NOT_A_PLUS` → re-init notice when `.claude/hooks` already exists beside a hook plugin (mutation-verified test); `PluginHookChannel` file-local |
| #1604 mutation CLI  | #1620 | `ba5510b53` | `AC_MET_BUT_NOT_A_PLUS` → `check` restores by patch when the runner throws (test); three exports file-local; ADR renumbered 0022 → 0023                    |

Open: #1605 (W0b, blocked by #1521), #1606 (W1, blocked by #1605 and the plugin freeze lift). Repo-local, outside the graph: #1599, #1600, #1601.

## How W0 ran

- One `sequant_run` over MCP (sequant 2.20.0 npm pin) with both issues, all phases. Tier: `.sequant/settings.json` `run.phases` flipped to opus for spec and exec before the call and restored once the `sequant run` process was up; the 2.20.0 SDK children show no `--model` flag in `ps`, so the tier was confirmed from the run log's `phases[].model` (all `claude-opus-5-5`).
- Context comments on both issues named the founding doc, the freeze scope, the suite-once rule for the exec **and qa** phases, and the gate-test marker rule. Neither phase hit the 30-minute wall (exec 1245 s and 1576 s).
- Worktrees were bootstrapped by a background loop; the first `npm ci` in the #1603 worktree failed during sequant's own provisioning and succeeded on retry.
- Every AC command was executed by the runner in the worktrees before and after the fix commits. Both binaries were built and smoked: `doctor` on this checkout fails the new row live, naming the repo `settings.json` and the plugin cache's `hooks/hooks.json`; `sequant mutation begin|check|render --help` parse and `begin`/`render` run.
- `health-advisory` was red on both PRs from one new unused export each; fixed in the runner commits. `knip-advisory` is red on every PR and is not a required check.

## Decisions execution forced

- **D-4.2** (founding doc §6): parallel nodes collide on ADR numbers; the number is assigned at merge and the second PR renumbers.
- **OQ-1, OQ-2** resolved by the code; **OQ-3** (spec comment's visible part) waits for #1605.
- #1604 keeps the agent-typed exec markers as a second producer until #1606 swaps the skills (spec OQ-1 on #1604); the state file under `.sequant/mutations/<N>.json` is the first producer and `createPR` dedupes.
- The #1603 spec derived AC-6 (`sync` and the drift scan honour `"hooks": "plugin"`) and chose to read project-level `enabledPlugins` too.

## Next

1. **W0b — #1605** once #1521 merges (both edit `buildQaVerdictComment`). Mechanical tier. Launch with the default policy.
2. **W1 — #1606** after #1605 and the owner lifts the plugin freeze. Judgment tier; `Execution: split` (skills plus `lint:skill-gates`). It also removes the hand-typed marker path (#1604 OQ-1).
3. Owner-local, still owed from the 2026-10-26 audit: `/reload-plugins` so the `sequant-dev@my-mods` plugin cache drops its `hooks/` (until then `sequant doctor` fails the Hook channels row on this checkout, correctly), rotate the OpenRouter key, decide on the 30-day transcript retention.

## Rules that mattered

- Consent was per wave: "merge if ready" covered #1598 and #1607; W0 merged only after an explicit answer.
- `gh pr update-branch` refused the second PR (adjacent ADR README rows); the merge happened in the worktree with both rows kept, pushed, and CI watched by SHA before `gh pr merge --squash --subject`.
- The CHANGELOG `merge=union` attribute merged cleanly; the duplicated `### Added` under `[Unreleased]` predates this graph and was left alone.
