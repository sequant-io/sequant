# Graph 2026-10 freeze (c): follow-ups from freeze-b wave 1

**Status:** Approved by the owner 2026-10-17 ("yes to all and file"). OQ-1 to OQ-3 ruled. #1484 joined as node F on 2026-10-17 (owner: "add f"; D-9).
**Epic tag:** `graph-2026-10-freeze-c`
**Predecessor:** `docs/internal/graph-2026-10-freeze-b/` (tracker #1452). Every node here was raised during freeze-b wave 1 and ruled "file" by the owner on 2026-10-16.

## §1 Vision

Freeze-b wave 1 fixed the skills-only install's drift count (#1409), the fresh-machine worktree start (#1405) and the plugin-version doc (#1325). Its verification found the same defects one step away:
- the install scope that `update` and two other commands still ignore;
- the shell helper that still has #1405's bug;
- a re-run that forks an issue's branch when `gh` blips;
- a version file nothing checks.

This graph closes those, still without touching the frozen directories.

## §2 MVP (one sentence)

The smallest set of merges after which:
- no sequant command widens a skills-only install or tells it to (widening goes through `sequant init` only);
- a re-run reuses the issue's existing branch whatever title it is given;
- `new-feature.sh` starts from an existing PR branch;
- a stale marketplace version fails the required `test` check;
- `merge --check` reads the repo's own default branch (F, #1484).

Includes: #1482 (B), #1485 (A), #1486 (C), #1487 (D), #1488 (E), #1484 (F). No smoke node: every AC is observable in the branch's own tests (§4).

## §3 Non-goals

| Not in this graph | Why not now |
|---|---|
| Any edit under `plugin/`, `.claude/skills/`, `templates/skills/` | Plugin freeze (I-1) |
| A release | Freeze-b D-1. Installed `scripts/dev/new-feature.sh` copies and the CLI get these fixes in the first post-freeze release |
| Inferring an install scope for manifests without `groups` | Owner ruling 2026-10-16: a hand edit plus `doctor` advice (A AC-3). Inference can't tell "skipped" from "deleted" and would hide drift |
| `update --only`, or a scope filter inside `update` | #1409 Non-Goal; #1482 option A rejected (D-1) |
| `doctor`'s missing-AGENTS.md advice on a skills-only install (`doctor.ts:684`, `init --force`) and `doctor` reporting content drift at a matching version | Found during A's Phase 0, outside its remedy-text class; file if wanted (OQ-3) |
| `new-feature.sh`'s "local branch exists, no worktree" divergence | Found during C's Phase 0; separate divergence (OQ-3) |
| Codex reading `~/.codex` `mcp_servers` | Not a node: a checklist line on the open Codex gate issue #1060 (R-1). opencode is already isolated by a per-run `XDG_CONFIG_HOME` (`opencode.ts:677-685`) |
| Editing `.github/workflows/*.yml` | Freeze-b D-7: `ci.yml` produces the required checks |

## §4 Architecture as observed (2026-10-16, `main` @ 085748480)

- **Install scope:** `getInstallScope` (`src/lib/manifest.ts:74`) is the one reader of `groups`. `scopedRemedy` (`sync.ts:107`) gives the partial-install fix text. `checkAndWarnSkillsOutdated` (`sync.ts:939`, `:954`) and `getSkillsInstallStatus` (`version-preflight.ts:146`) use it. The plain-sync fast path (`sync.ts:580`) and `doctor.ts:649` don't, and `mcp/server.ts:46` hardcodes "run `sequant update`".
- **Measured** (dev CLI, temp repo, `init --manifest-only` + `sync --only skills`):
  - Plain `sync` at a matching version prints `12 file(s) differ — run \`update\` or \`sync --force\`` and exits 1.
  - `doctor` prints `run: sequant sync` beside a banner saying `sync --only skills`.
  - `sync --only skills` at a version mismatch rewrites stale skills, resets the marker, keeps `groups: ["skills"]` and writes nothing outside `.claude/skills/`.
  - `update --yes` installs hooks and settings, and since #1477 it records a full install.
- **Branch naming:** `ensureWorktree` names the branch `feature/${n}-${slugify(title)}` (`worktree-manager.ts:987-988`) and looks up only that name.
  - `getIssueInfo` (`batch-executor.ts:318-351`) returns `Issue #N` on any `gh` failure except not-found; #1257 kept that silent.
  - Every consumer already matches by issue number: `listWorktrees`, `resolveIssueWorktree`, `worktree-discovery.ts:75`, `merge-check/index.ts:143`, `pr-status:132`, `checkout-lock:182`.
  - **Reproduced:** `ensureWorktree(1305, "Issue #1305")` beside a real-title worktree cut `feature/1305-issue-1305` from `main`.
- **`new-feature.sh`:** checks `refs/heads/<branch>` only, then branches from `origin/<base>`.
  - **Reproduced** on a fresh clone with a pushed PR branch: the worktree started at `origin/main`.
  - It is a bash port by design: it runs in non-Node repos and can be installed as a copy.
  - Six earlier divergences were each closed by a parity test.
- **Marketplace version:** written by `release.sh:93` and `prepare-marketplace.ts:143`. Checked by nothing: `ci.yml:271` and `plugin-install-test.yml:66` check only structure. `scripts/plugin-mcp-pin.test.ts` already parses both files and runs in the `unit` project (`npm test`, the required `test` job).
- **Phases run 2.19.0 from npm** (freeze-b I-6). That doesn't matter here: every AC is a test or a grep run on the branch, and none asserts a phase agent's own runtime.
- **In-flight neighbours:**
  - Freeze-b W2 is fully merged: #1406 (91fb05211), #1456 (PR #1478, 9835fd17d; edits `doctor.test.ts`), #1454 (PR #1481, 72be9f2de), #1460 (PR #1483, de03af8cd; `worktree-manager.ts`). A's and D's freeze-b edges are satisfied. Before filing, rerun A's and D's Evidence filters on `main` at de03af8cd, because both nodes were planned on 085748480.
  - graph-2026-10-consolidation (#1470) lands after 2.20.0. Its C-5 (#1475) edits `worktree-manager.ts`, and C-4 (#1474) edits `batch-executor.ts:1041`.

## §5 Invariants

- **I-1:** No merge changes `plugin/`, `.claude/skills/` or `templates/skills/`. Before every merge, `git diff --name-only origin/main...HEAD | grep -E '^(plugin|\.claude/skills|templates/skills)/'` prints nothing.
- **I-2:** Runs launch through MCP `sequant_run`, one issue per call. Never a backgrounded Bash `sequant run` (#856).
- **I-3:** Stop at PR. The owner consents to each merge.
- **I-4:** Gate-test ACs ship with a recorded mutation result (CLAUDE.md, Testing). Until #1465's fix ships in a release, marker text contains no `}`.
- **I-5:** Phases never run the full suite. Full-suite evidence is CI's.
- **I-6:** A test-filter Evidence clause says "≥ 1 passed, 0 failed". A `-t` filter that matches nothing reports every test skipped and exits 0, so "passes" would pass before the fix exists (found in this plan's Phase 0).

## §6 Per-node design

| Node | Input | Output | Main failure mode | Done when |
|---|---|---|---|---|
| B #1482 | a `groups: ["skills"]` manifest | `update` refuses, writes nothing, names `sync --only skills` | the refusal sits after `syncSequantMcpPin`, so `.mcp.json` is written before the refusal | AC-1 to AC-4 pass; #1477's widening test is rewritten |
| A | a scoped install, an old-style skills-only manifest | every skills fix message goes through `scopedRemedy`; one `doctor` advisory line | a second scope check beside `scopedRemedy`; or the advisory fires on a pruned full install (`ai-devtools-weekly` has settings and agents but no hooks, so all three must be absent) | AC-1 to AC-4 pass |
| C | a fresh clone with `origin/<branch>` | the script starts from `origin/<branch>`, matching `resolveBranchStartRef` on 5 fixtures | parity tested only on the happy path | AC-1 to AC-4 pass |
| D | title `Issue #N` or a retitle, with an existing `feature/N-*` | the existing branch is reused; two or more candidates fail loudly | lookup by prefix matches `feature/12-*` for issue 1 (needs `feature/1-` with the dash) | AC-1 to AC-4 pass |
| E | `marketplace.json`, `package.json` | a unit test comparing the versions; the doc names it | the test indexes `plugins[0]` instead of finding `sequant` | AC-1 to AC-3 pass |
| F #1484 | a repo whose default branch isn't `main` | one base ref resolved per `merge --check` run and used at all four sites; a failed `filesModified` diff becomes an error finding | an empty diff read as "no changes" (today's silent `[]`) | AC-1 to AC-3 pass |

## §7 Decisions

- **D-1: #1482 takes option B** (owner, 2026-10-16). `update` refuses on a partial scope and names `sync --only skills`. Rejected:
  - A (filter inside `update`): a second apply path for partial installs.
  - C (wording only): the documented upgrade command would still widen without asking.
- **D-2: Old-style skills-only manifests get a hand edit plus `doctor` advice** (owner, 2026-10-16). The runner hand-added `"groups": ["skills"]` to the owner's two affected repos (uncommitted there). Rejected: inference in `getInstallScope`, and a migration inside `sync` (both hide drift on a pruned full install); a new flag (it would serve two repos).
- **D-3: C ports the logic to bash and adds a behavioural parity test.** This is the class's convention (#826/#847/#871, #910, #1145, #1199). Rejected: the script calling the TS. It runs in non-Node repos, is installed as a copy with no `node_modules/sequant`, and no CLI command creates worktrees.
- **D-4: D names the branch from git refs for the issue number**, in this order: an existing worktree, then a local `feature/N-*`, then `origin/feature/N-*`. Rejected:
  - state.json, because the stray run overwrites it (`batch-executor.ts:1166`);
  - the PR's `headRefName`, because it needs the `gh` call that just failed.
- **D-5: E adds a unit-test assertion, not a CI step.** `ci.yml` is off-limits (freeze-b D-7), and `npm test` already runs in the required `test` job.
- **D-6: A runs after B.** Both edit `sync.install-scope.integration.test.ts` (B rewrites #1477's `update` test there, A adds plain-sync cases) and CHANGELOG. A also runs after #1456 (PR #1478 edits `doctor.test.ts`; merged at 9835fd17d). Rejected: parallel, which gives test-file conflicts for no gain on a two-node chain.
- **D-9: #1484 joins as node F after approval** (owner, 2026-10-17: "add f"). Its ACs were rewritten before it joined: one resolver call per run passed to all four sites, a named `master`-default integration test, and a named failed-diff unit test. Re-checked on e80353212: no commit since de03af8cd touches `src/lib/merge-check/`, AC-1's grep prints 4 lines, and both test filters match nothing, so every Evidence check fails before the fix. Its file scope is disjoint from every other node, so it runs alone as W3.
- **D-8: OQ rulings** (owner, 2026-10-17): OQ-1 keep the scope (A gains AC-5 and AC-6); OQ-2 keep D AC-3; OQ-3 file the three side finds as standalone issues outside the graph, so they don't count against its scope.
- **D-7: D is blocked by #1406 and #1460 (both merged; #1460 at de03af8cd)**, which edit `worktree-manager.ts` and its tests. #1469 and #1475 edit the same code without an edge, so they are merge-order members only.

## §8 Conventions

- One line per AC with a trailing `Evidence:` clause, written as a command QA runs verbatim. Gate-test ACs carry `mutation-verified`. Every body is parsed with `parseAcceptanceCriteria` + `isGateTestEvidence` before filing (done: 19 ACs across 5 nodes, all with evidence; F's 3 ACs were parsed when it joined, AC-2 and AC-3 as gate tests).
- Every test-filter Evidence clause fails on today's tree (all checked on 085748480; B's filters were renamed so they don't match #1477's existing test).
- Metadata line `**Epic:** graph-2026-10-freeze-c   **Tier:** …   **Execution:** …`, then one `- **Blocked by**: #N` per edge.
- `## Non-Goals` and `## Prior fixes / producers` in every body.
- **Merge consent: stop at PR**, owner consent per merge, I-1 before each merge.
- `CHANGELOG.md` `[Unreleased]` is shared by every code node. Resolve with a local `git merge origin/main`.
- Once filed, the issue body is canonical. `issues/*.md` is the as-filed snapshot.

## §9 Open questions and owner gates

- ~~**OQ-1 (owner, before A's exec):**~~ Ruled 2026-10-17: keep the scope (D-8). on a `groups: ["skills"]` install, should a plain `sync` at a version mismatch keep the scope, or stay the widen-to-full path it is today (ADR-0015, #1409's test)? **Recommendation: keep the scope** (effective `only` = `--only` ?? manifest scope). With D-1, `update` already refuses to widen, and a plain `sync` widening silently is the same defect. Widening stays deliberate through `sequant init`: measured on a scoped temp repo, a full `init --yes` installs hooks, agents and `settings.json` and rewrites the manifest without `groups`. If ruled "keep", A gains an AC and #1409's widening test is rewritten.
- ~~**OQ-2 (owner, before D's exec):**~~ Ruled 2026-10-17: keep AC-3 (D-8). D AC-3 makes a non-dry run warn when `gh` can't read the title. This reverses #1257's deliberate silent placeholder and edits its pinned test. **Recommendation: keep AC-3.** The silence is what hid #1305's fork until QA recorded `commit: null`, and AC-1 alone wouldn't tell the user the title was never read.
- ~~**OQ-3 (owner):**~~ Ruled 2026-10-17: file, outside the graph (D-8). Filed as #1489, #1490, #1491. file the three out-of-scope finds from Phase 0, or drop them?
  - `doctor` AGENTS.md advice widening a skills-only install;
  - `doctor` not reporting matching-version drift;
  - `new-feature.sh`'s "local branch, no worktree" exit.
- ~~**R-1 (runner, at filing):**~~ Posted on #1060 (comment 6230755477), 2026-10-17. add a checklist line to #1060: "`codex exec` reads the user's `~/.codex` config, so an `mcp_servers` entry there reaches phase agents (as claude.ai connectors did before #1396). Isolate it like opencode's per-run `XDG_CONFIG_HOME`, or record why not."
