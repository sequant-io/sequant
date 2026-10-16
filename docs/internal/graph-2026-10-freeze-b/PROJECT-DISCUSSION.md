# Graph 2026-10 freeze (b): freeze-safe bug fixes, second batch

**Status:** Reviewed and approved by the owner, 2026-10-16. Filed the same day. **Tracker:** #1452.
**Epic tag:** `graph-2026-10-freeze-b`
**Predecessor:** `docs/internal/graph-2026-10-freeze/` (tracker #1390, 9/9 closed).

## §1 Vision

The plugin directory review still holds the merge freeze on `plugin/`, `.claude/skills/` and `templates/skills/` (since 2026-10-08; no commit has touched them since). This graph fixes the open bugs that can land without touching those directories. They are a phase-agent over-grant, an out-of-date bundled CLI, two worktree paths that lose or repeat work, an install-drift warning whose fix deletes a user file, and two small parser and dead-code fixes.

## §2 MVP (one sentence)

The smallest set of merges after which a phase agent run from a `main` build has no claude.ai connectors and runs Claude Code ≥ 2.1.296, and a worktree for an existing remote PR branch starts from that branch on a fresh machine. A runner smoke of an `npm pack` of `main` (#1451) verifies it.

Includes: #1396, #1440, #1405, #1451. Supporting: #1406 (same class as #1405), #1409, #1305, #1325, #1454, #1456, #1460 (all added 2026-10-16).

## §3 Non-goals

| Not in this graph | Why not now |
|---|---|
| Any edit under `plugin/`, `.claude/skills/`, `templates/skills/` | Plugin freeze (owner-confirmed, no date) |
| A release | `release.sh` stamps `plugin/` (predecessor D-1). Fixes reach users in the first post-freeze release |
| #1439 (pre-tool guard fails open) | `templates/hooks/pre-tool.sh` mirrors into `plugin/hooks/`. It's the strongest case for a freeze exception, but that's the owner's call, not a node |
| #1341, #1345, #1360, #1324, #1400, #1370, #1353, #1407 | They edit skills or `plugin/`, or are marked "after the freeze" |
| #1293 (`--frontier`) | A 10-AC feature, not a bug; it would double the graph. Offered to the owner at review (§9 OQ-4) |
| Folding #1445 into #1440 | #1445 merges first, on its own (D-2) |
| The Codex and opencode drivers' MCP exposure | #1396 Non-Goal; check separately |

## §4 Architecture as observed (2026-10-16, `main` @ ad71b341)

- **Phase agents' CLI:** `drivers/claude-code.ts:130-158` calls the SDK `query()`. The lockfile pins `@anthropic-ai/claude-agent-sdk` 0.3.289. Its `manifest.json` says it bundles Claude Code **2.1.289**. Dependabot PR #1445 moves only `package-lock.json` to 0.3.296 (bundled CC 2.1.296); `package.json` stays `^0.3.289`. **Measured:** with #1445's tree, `npm ci` and `npx tsc --noEmit` both exit 0.
- **MCP servers in a phase agent:** the driver passes `options.mcpServers` from `getPhaseMcpServersConfig` (`src/lib/mcp-config.ts:114`, #936 allowlist). It sets neither `strictMcpConfig` nor `settings`. **Measured 2026-10-16** (`query()` aborted at `system/init`, `settingSources: ["project"]`, one dynamic server passed, an account with connectors):

  | Option | CC 2.1.289 | CC 2.1.296 |
  |---|---|---|
  | none | 5 `claudeai` servers (Docs, Gmail connected) | same |
  | `strictMcpConfig: true` | only the passed server | same |
  | `settings: { disableClaudeAiConnectors: true }` | only the passed server | same |
  | both | only the passed server | same |

  Probe script and raw output: `evidence/probe-1396.mjs`, `evidence/probe-1396.md`. #1396's AC-1 evidence still comes from #1451, through the real driver.
- **Worktrees:** `ensureWorktree` (`worktree-manager.ts:898`) checks branch existence with a local-only `show-ref refs/heads/<branch>` (`:1078`). `computeWorktreeBaseRef` (`:826`) returns a non-default bare base unchanged, while `countCommitsBehind` (`:244`) compares against `origin/<base>`.
- **Install drift:** `computeContentDrift` (`src/commands/sync.ts:228`) counts template changes with status `new` or `modified` over the whole template set. `.sequant-manifest.json` has `files: {}` and no install-scope field. It's read or written by 11 non-test modules (`init`, `sync`, `update`, `doctor`, `status`, `run`, `run-manifest`, `version-preflight`, `skills-commit-state`, `manifest`, `bin/cli.ts`).
- **Mutation markers:** `/qa` §6i calls `parseMutationMarkers` through `npx tsx` (`qa/SKILL.md` §6i). It doesn't embed the regex, so #1305 needs no skill edit.
- **`plugin-version-sync.ts`:** imported only by its own test. `ci.yml`'s `Validate plugin.json structure` step (`:219`) checks versions inline.
- **`main` ruleset:** `test` + `canary` required, strict up-to-date. No merge queue (#1368 not applied).

## §5 Invariants

- **I-1:** No merge changes `plugin/`, `.claude/skills/` or `templates/skills/`. Before every merge: `git diff --name-only origin/main...HEAD | grep -E '^(plugin|\.claude/skills|templates/skills)/'` prints nothing.
- **I-2:** Runs launch through MCP `sequant_run` or `launchctl`, never a backgrounded Bash `sequant run` inside a Claude session (#856).
- **I-3:** Stop at PR. The owner consents to each merge.
- **I-4:** Gate-test ACs ship with a recorded mutation result (CLAUDE.md, Testing).
- **I-5:** Phase agents never run the full suite (it hits the 30-minute wall). Full-suite evidence is CI's.
- **I-6:** Evidence from a real phase agent's `system/init` comes from a `dist/` build of the branch, run by the runner. MCP `sequant_run` phases run the npm-pinned server (2.19.0, SDK 0.3.289), not the branch, so a phase can't observe its own fix.
- **I-7:** Public docs never name the private fixture repos. Cite the issue number.

## §6 Per-node design

| Node | Input | Output | Main failure mode | Done when |
|---|---|---|---|---|
| #1440 | `main` after #1445 merges (lockfile 0.3.296) | `package.json` floor `^0.3.296`, one README line | the floor stays `^0.3.289`, so a fresh install can resolve the old CLI | `npm ls` shows ≥ 0.3.296 and the range floor matches |
| #1396 | the driver's `query()` options | `settings: { disableClaudeAiConnectors: true }` (D-3) | a spread later in the options object (`env`, `mcpServers`) overrides `settings`, or a future second call site omits it | the one `query()` call passes it, asserted by a test, and #1451's init shows no `claudeai` server |
| #1405 | no local `<branch>`, existing `origin/<branch>` | a worktree from `origin/<branch>`; no repeat recreate | AC-3's "abandoned branch" check adds a `gh` call per worktree on the hot path (#1322's lesson: per-worktree `gh` calls made run time scale with load) | AC-1..AC-3 pass; spec names where the abandoned-branch check runs (recreate and first-creation paths only, not every `ensureWorktree`) |
| #1406 | a bare non-default base | one ref for creation, staleness and `sequantBaseRef` | fixing `computeWorktreeBaseRef` while `countCommitsBehind` keeps its own resolution | one test asserts all three consumers see the same ref |
| #1409 | a skills-only install | drift scoped to what was installed; a remedy that only rewrites skills | patching the remedy text without recording scope (the issue's own Open question) | AC-1..AC-3 pass under the owner's OQ-1 ruling |
| #1305 | a marker whose fields contain `}` | a round-tripping marker | fixing the PR-body entry point and not the exec-output one | both entry points round-trip a brace-bearing marker |
| #1325 | an unused module | the module and its test deleted; the doc names the real check | deleting the module while the doc still cites it | `git grep checkVersionSync` is empty and `plugin-updates.md` names `ci.yml`'s step |
| #1451 | `npm pack` of `main` after #1440, #1396, #1405 | a smoke report | passing because nothing exercised the fixes | the report shows a phase init with no `claudeai` server, `claude_code_version` ≥ 2.1.296, and a fresh-clone worktree on an existing PR branch whose HEAD equals `origin/<branch>` |

## §7 Decisions

- **D-1: No release during the freeze** (inherited). Rejected: a release that skips the plugin stamp (the plugin manifest would disagree with the npm version).
- **D-2: Dependabot PR #1445 merges first; #1440 then raises the floor and adds the doc line.** The runner merges #1445 (owner consent, I-3) before launching #1440. #1445 already carries the lockfile bump and its `@hono/node-server` and `zod` siblings; regenerating the lock from `main` inside #1440 would leave those behind, and Dependabot would reopen. Rejected: #1440 superseding #1445 (it couldn't, for the reason above). `^0.3.289` already admits 0.3.296, so the order leaves no inconsistent window.
- **D-3: #1396 uses `disableClaudeAiConnectors` via the SDK `settings` option, not `strictMcpConfig`.** Both drop the connectors on 2.1.289 and 2.1.296 (§4). `disableClaudeAiConnectors` is the narrow one: it gates only auto-fetched claude.ai connectors. `strictMcpConfig` also drops project `.mcp.json`, plugin and agent-frontmatter MCP, which would silently change what #1397/#1398 (skills through a plugin) can load. Rejected: `strictMcpConfig` (wider than the bug), both (no measured gain over the narrow one).
- **D-4: No #1440 → #1396 edge.** The issue's suggestion that #1396 depends on the 2.1.290 setting change is false: the lever works on 2.1.289 (§4). They run in parallel.
- **D-5: #1405 and #1406 serialize, #1405 first.** Same file (`worktree-manager.ts`); #1405 changes `ensureWorktree`'s branch-existence check, #1406 changes `computeWorktreeBaseRef` and `countCommitsBehind`. They're disjoint functions, but #1406's AC-1 test creates worktrees through `ensureWorktree`. Rejected: parallel (merge conflicts in the shared temp-repo test harness).
- **D-6: #1305 and #1325 join this graph,** reversing the predecessor's §3 (kept for outside contributors). Both have been open 12 days as `good first issue` with no takers, and #1305 silently floors QA verdicts. Rejected: keep waiting.
- **D-7: #1325 deletes the module (AC-1's first option).** Wiring it into `ci.yml` would edit the workflow that produces the required `test` / `canary` checks (`ci.yml:24` warns a job change can brick merging). Rejected: wiring it in.

- **D-8 (2026-10-16, on adding #1454): `/assess` gets a library function now and its wiring after the freeze.** `assess/SKILL.md` Step 5 builds the collision inputs in prose and calls the pure functions in `assess-collision-detect.ts`, so passing open-PR data in is a skill edit. #1454 ships the function and its tests; `sequant merge --check` (CLI) gets the full feature. Rejected: making the existing pure functions fetch PRs themselves (it hides network I/O inside functions the skill treats as pure, and still wouldn't print without a skill change to read the new result).

- **D-9 (2026-10-16, on adding #1460): #1460 makes `detectDefaultBranch` take an optional `cwd`, and is blocked by #1406.** `detectDefaultBranch()` (`worktree-manager.ts:180`) runs git in `process.cwd()`. Called from `resolveBaseRef(cwd)` as-is, it reads the wrong repo whenever the two differ, and #1460's AC-2 temp-repo test could only pass by patching `process.cwd`, which the forks pool leaks across test files. The optional parameter defaults to `process.cwd()`, so existing callers don't change. It edits `worktree-manager.ts`, so #1460 joins that cluster after #1406. Rejected: a second default-branch lookup inside `phase-executor.ts` (a second producer of the default branch, the class #1460 itself names); calling `detectDefaultBranch()` with no `cwd` (wrong repo, untestable without a `process.cwd` patch).

## §8 Conventions

- One line per AC with a trailing `Evidence:` clause. Gate-test ACs carry `mutation-verified` in the Evidence text. Every amended body is parsed with `parseAcceptanceCriteria` + `isGateTestEvidence` before filing.
- Metadata line `**Epic:** graph-2026-10-freeze-b   **Tier:** …   **Execution:** …`, then one `- **Blocked by**: #N` list item per edge.
- `## Non-Goals` (that casing) in every body. `## Prior fixes / producers` on every bug fix.
- **Merge consent: stop at PR**, owner consent per merge, I-1 check before each merge.
- `CHANGELOG.md` `[Unreleased]`: every code node touches it until #1370 lands after the freeze. Expect trivial conflicts; resolve with a local `git merge origin/main`.
- An Evidence grep over docs names the page (`docs/guides/mcp-integrations.md`), never all of `docs/`: this graph's own `docs/internal/graph-2026-10-freeze-b/` quotes every symbol its ACs grep for, so a tree-wide grep passes or fails on the plan, not the change (CLAUDE.md, Testing).
- Once filed, the issue body is canonical. `issues/*.md` is the as-filed snapshot.

## §9 Open questions and owner gates

- ~~**OQ-1 (owner, before #1409's exec):**~~ **Ruled 2026-10-16: record it** (the owner approved the plan with the recommendation; #1409 AC-4 as filed). does an install record its scope in `.sequant-manifest.json` (for example a `groups` field written by `init` and `sync --only`), or is scope worked out from what exists on disk? **Recommendation: record it.** Inference from disk can't tell "deliberately skipped" from "deleted by accident", and the manifest already has an unused `files` map. Recording it changes a file 11 modules read, so `src/lib/manifest.ts` owns the format and every other module reads it through `getManifest`.
- **OQ-2 (#1405 spec):** where does AC-3's abandoned-branch check run, and does it need `gh`? A local `git` check (for example, `origin/<branch>` already merged into `origin/<base>`) may answer it without a network call.
- ~~**OQ-3:** does any driver code path build `query()` options separately?~~ No: `src` has one `query()` call (`drivers/claude-code.ts:130`, the only SDK import), checked 2026-10-16. A future second call site would need the option too; AC-2's test asserts on the one site.
- ~~**OQ-4 (owner, at review):** add #1293 (`--frontier`) as a node?~~ **Ruled 2026-10-16: no**; it stays out of this graph.
- **Runner note:** if #1368's merge queue lands mid-graph, re-read the `main` ruleset before each wave.

**Owner gates (not nodes):** #1439 (freeze exception?), #1359 (Gitleaks required; its earliest date, ~2026-10-14, has passed), #1361, #1368.

## §10 After the freeze

The first post-freeze release ships both freeze graphs' merges. Then the predecessor's §10 queue, with #1439 first.
