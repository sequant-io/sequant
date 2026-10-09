# Graph 2026-10 freeze: freeze-safe work while the plugin directory review is open

**Status:** Reviewed and approved by the owner, 2026-10-09. Filed the same day.
**Epic tag:** `graph-2026-10-freeze`
**Compass:** https://claude.ai/artifact/XdToSeiqCUyra7HWJFbKMj (bet 3: a stranger's first run works)

## §1 Vision

While the plugin directory review holds a merge freeze on `plugin/` and the skill trees, spend the time on what a stranger hits on a first or second run, plus the investigations that decide where the run engine goes next. Nothing in this graph edits a skill, a hook or `plugin/`.

## §2 MVP (one sentence)

The smallest set of merges that lets a stranger install Sequant from a `main` build, run one issue against a non-default base, and get a PR against that base, with the first-run messages telling them the truth, verified by a re-run of the 2026-10-09 stranger smoke test.

Includes: #1386, #1380, #1387, the re-smoke node. Supporting: #1322 (merge-gate trust), #1388, #1192 and #1344 (decisions and measurements), #929.

## §3 Non-goals

| Not in this graph | Why not now |
|---|---|
| Any edit under `plugin/`, `.claude/skills/`, `templates/skills/` | Plugin freeze (since 2026-10-08, owner-confirmed, owned by session sequant-05) |
| A release | `scripts/release.sh:82-87` stamps `plugin/.claude-plugin/plugin.json`, so a release breaks the freeze. Fixes here reach users only in the first post-freeze release (§7 D-1) |
| #1388's rollout | It edits skill text (`sequant:` prefixes). Only the spike and ADR are in scope |
| #1341, #1381, #1360, #1324, #1351, #1353, #1074, #941 | They edit skills or `plugin/`; queued for after the freeze |
| #1305, #1325 | Kept for outside contributors (`good first issue`) |
| #916, #944, #1273 | Wait for a benchmark re-baseline on Sonnet 5.5 |
| Owner gates (§9) | No agent work until the owner rules |

## §4 Architecture as observed (2026-10-09, `main`)

- **Base branch:** resolved once into `ResolvedRun.baseBranch` (`run-orchestrator.ts:721`: `--base` → `settings.run.defaultBase` → `detectDefaultBranch()`). Worktree creation and `rebaseBeforePR(…, baseBranch)` (`batch-executor.ts:2586`) receive it. `createPR` does not: it only sets a base from `stackOptions.prBase` (`worktree-manager.ts:2342`), built only under `--stacked` (`batch-executor.ts:1213`). Observed in the smoke test: the private calibration fixture's smoke PR opened against `main` instead of `smoke/stranger-2026-10-09`.
- **Worktree recreate:** `ensureWorktree` (`worktree-manager.ts:842`) recreates a worktree more than 5 commits behind when nothing is uncommitted or unpushed. It deletes the local branch and rebuilds with `-b <branch> <baseRef>`, never consulting `origin/<branch>` (#1380).
- **Two worktree modules:** `worktree-manager.ts` (`sequant run`'s per-issue worktrees) and `worktree-isolation.ts` (exec's parallel subagent groups). #1192 concerns only the second.
- **Releases:** stamp `plugin/` (above).

## §5 Invariants

- **I-1:** No merge in this graph changes `plugin/`, `.claude/skills/` or `templates/skills/`. Check before every merge: `git diff --name-only origin/main...HEAD | grep -E '^(plugin|\.claude/skills|templates/skills)/'` prints nothing.
- **I-2:** Runs launch through the MCP `sequant_run` tool or `launchctl`, never a backgrounded Bash `sequant run` inside a Claude session (#856).
- **I-3:** Stop at PR. Each merge needs the owner's consent (§8).
- **I-4:** Gate-test ACs ship with a recorded mutation result (CLAUDE.md, Testing).
- **I-6:** Nodes marked `**Execution:** runner session` (#1388, #1344, #1389, and #1322's evidence) run from the runner session, never inside a `sequant_run` phase. A phase agent does not launch nested Claude sessions or run the full suite.
- **I-5:** Public docs never name the private downstream repos behind #1380 or #1203. Cite the issue number.

## §6 Per-node design

| Node | Input | Output | Main failure mode | Done when |
|---|---|---|---|---|
| #1386 | `ResolvedRun.baseBranch` | `createPR` passes `--base` | fixing `createPR` alone while another consumer keeps its own value | all three consumers (worktree, rebase, PR) receive the same resolved base, asserted by one test |
| #1380 | an existing PR branch, worktree more than 5 behind | a recreated worktree that holds the PR's commits | rebuilding from base while `origin/<branch>` exists | after any recreate with `origin/<branch>` present, HEAD contains its commits |
| #1387 | first-run CLI output | five corrected messages | fixing text while the README still disagrees | each of the five has its own test |
| #1388 | a scratch repo with no `.claude/skills/` | an answered spike and a Proposed ADR | a "works" result with hooks double-firing unnoticed | the ADR records the decision and follow-up issues are filed |
| #1322 | full-suite failure output | a classified cause and a fix | fixing the wrong cause (timeout vs shared state) | the two tests pass in 3 consecutive full-suite runs |
| #1192 | a real `WorktreeCreate` hook run | an investigation note | deciding without a real hook run | the note has `## Decision` |
| #1344 | the calibration data | a pre-registered design and a held-out fixture | a fixture at ceiling (first-verdict recall 1.0) | AC-1 and AC-2 met, or a recorded stop |
| #929 | `ReadyResult` | a metrics record with `source: "ready"` | conflating `ready` runs with `run` runs in stats | `sequant stats` shows them separately |
| R-1 re-smoke | `npm pack` of `main` after #1386, #1380, #1387 | a smoke report | passing because nothing exercised the fixes | the report shows the PR base and the init next-steps text |

## §7 Decisions

- **D-1: No release during the freeze.** `release.sh` stamps `plugin/`. Merged fixes wait on `main`; the first post-freeze release ships them. Rejected: a release that skips the plugin stamp (it would ship a plugin manifest whose version disagrees with the npm package, which `doctor` and the stale-version hook check).
- **D-2: #1386 passes the existing resolved base through; it adds no resolver.** Rejected: a new resolver in `createPR` (a second producer of the base, the class the 2026-09-30 retrospective named).
- **D-3 (accepted by the owner, 2026-10-09): #929 reuses `MetricRun` with a `source: "run" | "ready"` discriminator.** `sequant stats` filters or groups on it. Rejected: a parallel ready-specific schema (a second schema plus its own stats and dashboard support, for data that maps onto `MetricRun` with one awkward outcome mapping).
- **D-4: #1344 owns the held-out fixture; #1272 consumes it.** One fixture, one owner (anti-gap pass 4).
- **D-5: #1386 and #1380 serialize, in either order.** They share `worktree-manager.ts` but touch disjoint functions. Neither needs the other's code. Default order: #1386 first, since it is smaller and confirms the base flow #1380's OQ-2 depends on.

- **D-6: #1387 AC-1 keeps the README's install path and narrows the warning.** The local-install warning is suppressed when the project's `package.json` declares `sequant`; a stray, undeclared install still warns. Rejected: changing the README to `npx sequant@latest` only (it drops the pinned, per-project install CI users need).

## §8 Conventions

- One line per AC with a trailing `Evidence:` clause; gate-test ACs carry `mutation-verified` in the Evidence text. Every body is parsed with `parseAcceptanceCriteria` and `isGateTestEvidence` before filing.
- Metadata line `**Epic:** graph-2026-10-freeze **Tier:** …`, then one `- **Blocked by**: #N` list item per edge.
- `## Non-Goals` in every body. `## Prior fixes / producers` on every bug fix.
- **Merge consent: stop at PR**, owner consent per merge. Run the I-1 check before each merge. `main` requires `test` and `canary`, strict up-to-date (ruleset `CC`).
- The issue body is canonical once filed. `amendments/*.md` is the as-filed snapshot.

## §9 Open questions and owner gates

- **OQ-1:** Does a plugin passed through the SDK `plugins` option load under `settingSources: ["project"]`? Resolved by #1388 AC-1.
- **OQ-2:** Is the `baseRef` that `ensureWorktree`'s recreate path uses (callers at `worktree-manager.ts:1190`, `:1242`) the same value as `ResolvedRun.baseBranch`? Resolved by #1380's spec, before exec.
- **OQ-3:** Are #1322's failures load timeouts or shared-state interference (#1164: three MCP tests touch the real `.sequant/state.json`)? Resolved by #1322 AC-1.
- **OQ-4:** Can a held-out fixture get first-verdict recall below 0.90? Resolved by #1344 AC-2 (a recorded stop is a valid answer).
- ~~**OQ-5:** D-3 (#929's metrics shape).~~ Accepted by the owner on 2026-10-09: reuse `MetricRun` with `source`.
- **Runner note:** if #1368 (merge queue) lands mid-graph, the merge step changes. Re-read the `main` ruleset before each wave (`gh api repos/sequant-io/sequant/rules/branches/main`).

**Owner gates (not nodes; no agent work until ruled):** #1359 (require Gitleaks), #1361 (vitest allowlist), #1368 (merge queue), #1049 (30-minute wall design), #1026, #1027, #997, #1060, #856 (close, or keep as recurrence tracker).

## §10 After the freeze

First post-freeze release ships this graph's merges. Then, in order: #1351, #1341 and #1381, #1360 and #1324, #1388's rollout if the spike succeeds, #1353, #1074, #941.
