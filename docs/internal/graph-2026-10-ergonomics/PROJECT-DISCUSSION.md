# graph-2026-10-ergonomics: contracts that exist only as prose move into code sequant owns

**Status:** founding doc, 2026-10-26. Evidence in `phase0-evidence.md` (cited as E-N). Issues in `issue-graph.md`.

## §1 Thesis

A session audit (E-1..E-4) found that the friction a sequant user feels day to day is not in the phases. It is in four contracts between sequant and the person driving it, each of which exists today only as prose in a skill, in CLAUDE.md, or in the owner's memory:

1. **Who owns the hooks in this checkout** (E-1). Two delivery channels, no arbiter, so both run.
2. **What counts as a verified mutation** (E-2). A procedure the agent performs by hand and then describes in a marker it also types by hand.
3. **How a skill talks to the human** (E-3). Decisions as prose lists, waiting as foreground sleeps, results as 10k-character comments, completion without a link.
4. **When a branch may die** (E-4). Already in code; the repo setting that depends on it was never flipped.

The pattern is the one #823, #939 and #1512 already named: prose that describes a behaviour is not the behaviour. The fix each time was to give the behaviour one owner in TypeScript and have the skill call it. This graph applies that rule to the four contracts above. It is deliberately not a list of patches: each node is the owner of one contract, and the skill edits (frozen until the plugin-directory review closes) are a single node at the end that only swaps prose for calls.

## §2 Constraints

- **C-1 Plugin freeze.** No merge may touch `plugin/`, `.claude/skills/` or `templates/skills/` until the owner lifts it. Every node but the last is CLI or TS only; the last node is blocked by the lift.
- **C-2 Orchestrator vs interactive.** Under `sequant run` a phase agent must wait in the foreground (the pre-tool hook blocks `Monitor` and `run_in_background`, #1032); in an interactive session the same wait must go to the background (E-3: 48.7 min blocked). Any waiting rule is written per mode, never as one sentence.
- **C-3 One producer per artifact.** A marker, a comment layout, a hook registration each has exactly one producer in code. Skills never hand-render what a producer renders.
- **C-4 Personal tooling stays personal.** The owner's mods (`branch-watch`, `done-notify`, `sequant-progress`) and global `~/.claude/CLAUDE.md` are cited where they proved a need, never required.

## §3 Contract 1 — hook channels (E-1)

**Design.** A checkout gets sequant hooks from exactly one channel: the repo (`sequant init` writes `.claude/hooks/*.sh` and registers them in `.claude/settings.json`) or the plugin (`hooks/hooks.json`). The arbiter is `sequant doctor`, which can see both: project `settings.json` hooks and the `enabledPlugins` maps in `~/.claude/settings.json` and `.claude/settings.local.json`.

- **D-1.1** `doctor` adds a `Hook channels` check: `fail` when a repo hook registration and an enabled plugin that actually ships hooks are both present. "Ships hooks" is resolved, not guessed: the check reads `enabledPlugins`, resolves each enabled plugin's install path through `~/.claude/plugins/installed_plugins.json`, and looks for a `hooks/hooks.json` that registers `pre-tool.sh`. (A plugin named `sequant-dev@my-mods` whose `hooks/` dir was removed is therefore not a second channel.) The message names both sources and the two fixes (disable the plugin here, or run `sequant init` with the hooks group off). `pass` otherwise; `warn` when neither is present and a manifest says hooks were expected.
- **D-1.2** `init` and `update` skip the hooks group when a `sequant*` plugin is enabled, and record `"hooks": "plugin"` in `.sequant-manifest.json` so `doctor` and a later `update` know the choice was deliberate (the #1409 partial-install mechanism already carries `groups`).
- **D-1.3 Rejected:** runtime dedupe inside the hook scripts keyed on session id and a payload hash. Claude Code's hook payload carries no tool-use id, so two identical consecutive calls within the window would skip the second guard. Deterministic prevention at install plus detection in `doctor` covers the case without a race.

## §4 Contract 2 — mutation verification (E-2)

**Design.** Mutation verification becomes a two-step CLI the agent drives, and the marker becomes something only that CLI can emit.

- **D-2.1** `sequant mutation begin --issue N` refuses a dirty tree (`git status --porcelain` non-empty → exit 2 with "commit first"), records `HEAD` and a timestamp in `.sequant/mutations/<N>.json`, prints the two allowed next steps. This is the clean-tree precondition that made every wipe in E-2 possible to avoid: with it, restoring is safe by construction.
- **D-2.2** The agent applies the mutation with its own edit tools (no mutation DSL).
- **D-2.3** `sequant mutation check --issue N --ac AC-K --test <file> --name "<describe> > <case>" --mutation "<what was deleted>"` runs these steps in order and aborts at the first failure with the state file untouched: (1) no commit since `begin`; (2) `npx vitest list <file> -t <escaped name>` names exactly one test; (3) `git add -A` then `git diff --cached --binary` is captured as the mutation patch, so files the mutation created or deleted are in it; (4) `npx vitest run <file> -t <escaped name>` exits non-zero (the test fails under the mutation); (5) `git apply -R --index` of the patch, then `git status --porcelain` is empty; (6) the same `vitest run` exits 0 (the test passes without the mutation, so a broken test cannot be certified); (7) append `{ac, test, name, mutation, mutatedExit, restoredExit, ranAt, sha}`. On abort the patch stays at `.sequant/mutations/<N>.patch` for the human. Paths are resolved against the current worktree, never the main checkout.
- **D-2.4** The PR body stays the source of truth, as the owner decided on #1316 (ADR-0004): QA keeps reading `$PR_BODY`, and the marker still travels exec's Summary → `composeExecSummary` → PR body. What changes is the producer: `.sequant/mutations/<N>.json` is the receipt of a real run, and `renderMutationMarker` renders the marker from it (`sequant mutation render --issue N`, which exec pastes into its `## Summary`; interactively the same command). No skill types `<!-- SEQUANT_MUTATION … -->` by hand again. This is the delta from #1316: that investigation asked whether to move the *channel*; this node leaves the channel and fixes the *origin*.
- **D-2.5** "Run before you cite" (33 memories) is enforced for the gate-test class by construction: the record carries the real exit code of a real run. Widening to every `Evidence:` command is the backtest #939 AC-5 asked for and stays out of scope.
- **D-2.6 Rejected:** a wrapper that reverts with `git checkout -- <file>`. It is exactly what wiped #817 and friends when the precondition was missing; with D-2.1 it would be safe, but `git apply -R` of the captured patch also restores deletions and new files, which `checkout` does not.

## §5 Contract 3 — the human surface (E-3)

Three behaviours, one reference, one layout owner.

- **D-3.1 Comment layout has one owner.** `renderIssueComment({kind, headline, acTable?, sections[]})` in `src/lib/workflow/comment-layout.ts` renders: the headline line (verdict or recommendation), the AC table when present, then every other section inside one `<details><summary>` block. Every line a parser anchors on (the `QA_VERDICT` marker, per-AC status rows, `SEQUANT_MUTATION`, assess markers) stays outside the block and in its current position. `buildQaVerdictComment`, the merge-check report and the review-residue comment adopt it (TS, not frozen); because #1521 also edits `buildQaVerdictComment` and #1525 parses its output, this node lands after #1521. A hidden `sequant comment render --kind spec|qa --body-file -` subcommand exposes it to interactive skills, the way `assess-render` exposes the dashboard (#823). Target: a spec comment's visible part is the complexity line plus the AC table; a QA comment's visible part is the verdict line plus the per-AC table.
- **D-3.2 Decisions are asked, not listed.** When a skill has two or more open decisions it asks them in one `AskUserQuestion` call, recommended option first, and acts without asking on anything it already recommends. Merge consent, live or destructive writes and genuinely open calls remain questions (#955/#957). Skills gain `AskUserQuestion` in allowed-tools.
- **D-3.3 Waiting is per mode (C-2).** Under `SEQUANT_ORCHESTRATOR`: foreground, bounded, once per phase (today's exec §3 text). Interactive: `run_in_background` plus the task notification, or `sequant merge --watch` (#818), never a foreground `sleep` over 60 s. Written once in the shared reference, cited by exec, qa, merger, release.
- **D-3.4 Completion carries the link.** Every skill's final message names the PR, issue or run URL it produced. (The owner reads from a phone over remote control; "Merged?" and "where is it" were 6 of 17 corrections.)
- **D-3.5 Where it lives.** `.claude/skills/_shared/references/human-surface.md` holds D-3.2..D-3.4 and the two CLI calls from D-3.1 and D-2.4. Each skill cites it in one line. `lint:skill-gates` already checks for exact phrases; one phrase per rule is added so the citation cannot silently drop. This node is frozen (C-1) and lands last.
- **D-3.6 Rejected:** a `--collapse` flag on `gh issue comment` emulated in skill prose. Prose geometry is the #823 defect class; the renderer owns it.

## §6 Contract 4 — branch lifecycle (E-4)

Already in code: `cleanup-worktree.sh` deletes the remote branch only when the PR is `MERGED` and tolerates the branch being gone. The two incidents in memory were (a) a merge destroying a worktree with uncommitted edits (a human-timing problem the clean-tree discipline in §4 also addresses) and (b) `gh pr merge --delete-branch` run from inside a worktree. Neither is caused by GitHub's delete-on-merge. **Decision D-4.1:** no product change; the repo flips `delete_branch_on_merge` after one verifying PR and prunes the 149 merged branches. Repo-local issue, outside the graph label.

## §7 Non-goals

- Changing how phases wait under the orchestrator (#1032 stands).
- Any narrative summary generated into comments; D-3.1 only changes layout.
- Entire, the owner's shell, mods or global settings (C-4; fixed locally on 2026-10-26).
- Widening mutation verification beyond gate-test ACs (#939 AC-5).
- The upstream workflow (#1442), merge queue (#1368), auto permission mode (#1191).

## §8 Open questions for the owner

- **OQ-1** Should D-1.2 default to the plugin channel when both are available at `init` time, or ask? Proposed: skip hooks silently and print one line; `doctor` reports the choice.
- **OQ-2** D-2.3 names the test by `-t <case>`; vitest's `-t` is a regex over the full title. Proposed: escape the name and require `npx vitest list <file> -t <name>` to print exactly one test, failing `check` otherwise. Filed with this as the decision; the owner may override on the tracker.
- **OQ-3** D-3.1 visible part for spec: complexity line plus AC table, or AC table only? Proposed: both; the complexity line is one line.
