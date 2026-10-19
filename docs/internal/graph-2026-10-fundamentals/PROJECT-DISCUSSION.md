# graph-2026-10-fundamentals — founding document

**Status:** approved and filed 2026-10-18 as #1501 (tracker) and #1502–#1513; F-10 (removals) unfiled until D-2. Sources: five session assessments of 2026-10-16/17 (orgs research, AI-quality evidence, surface-usage audit, testing research, fix-seam audit), which live in the planning session's scratchpad and are **not landed in the repo**; every number used here was re-measured on 2026-10-18 by `fnlen.mjs` (this directory, run from the repo root) or by the commands in §4. Phase-0 measurements were taken on `main` at 96990daab. The Evidence commands in `issues/` were run on that tree on 2026-10-18; `phase0-evidence.md` records each result as fails-today, constraint (holds on `main` by construction), or not-runnable-at-plan-time (needs a PR, a runner input or an owner answer).

## §1 Vision

The repo has the fundamentals most solo projects lack (strict TS, ADRs, threat model, SECURITY, gitleaks, Scorecard, Dependabot, canary, next-before-latest, seven lint gates, red-main revert). What it lacks is narrow and measurable: four workflow files absorb most fixes because their functions are hundreds of lines long, dropped errors leave no trace, the subprocess seam is the one seam tested through mocks, prose gates assert wording instead of behaviour, nothing removes code, and the institutional knowledge sits in a per-machine memory. This graph installs **ratchets** so none of those numbers can rise again, and pays the one-time cleanups needed to set each ratchet at zero.

## §2 MVP (one sentence)

The smallest set of changes that makes `main` carry a committed health baseline, a CI job that fails any PR raising a baseline number, a run log that counts the errors it chose to drop, and no function over 200 counted lines in `src/lib/workflow` or `src/commands` — with human approval at exactly: every merge (stop-at-PR), the removal list (D-2), the mutation-mandate scope (D-3), and the incident content (D-5).

Includes: health report + baseline + advisory CI (F-01); lint tightening and dead-export reporting (F-02); suppressed-error trace (F-03, F-04); `gh` seam through one provider with captured fixtures (F-05); function splits (F-06, F-07, F-08); deprecation lifecycle (F-09); prose-gate audit and conversion (F-11, F-12); incidents + ADR authority (F-13); the stranger run, the graph's only non-dogfood evidence (F-14, #1519, joined 2026-10-18). Owner-gated removals (F-10) are in the graph but file only when D-2 answers.

## §3 Non-goals

| Not in this graph | Why not now |
|---|---|
| Any edit under `plugin/`, `.claude/skills/`, `templates/skills/` | plugin freeze (I-1) |
| Changing the CLAUDE.md mutation rule | owner's; it caught #830; D-3 only scopes which tests it binds |
| Async I/O (#506), in-process MCP (#508), AsyncSubprocess abstraction | execution-layer redesign; consolidation graph excluded it too |
| Removing commands/flags/settings/drivers/skills without D-2 | product decision, not engineering |
| A `git` wrapper or fake | git is already tested against real repos in 80 files; not the mocked seam |
| Coverage thresholds | coverage has never been measured; adding a threshold before a baseline is a number without a reason |
| Harness self-editing (Harness², arXiv 2610.14224) | its library is never pruned; defers accretion rather than solving it |
| A contrast gate on skill-prose edits (D-7) | skill work; lives with the post-freeze queue #1455, #1457–#1459, #1461 |
| Claiming fewer escaped defects | unmeasurable here: zero external users, no effect sizes in the literature |

## §4 Architecture as observed (2026-10-18)

Measured on `main` 96990daab with `fnlen.mjs` (TypeScript AST), ESLint, grep and git. Every number below is reproduced by F-01's script, which is the graph's fixture.

| Metric | Definition (what F-01 computes) | Baseline |
|---|---|---|
| functions.over400 / over200 | ESLint `max-lines-per-function` with `skipBlankLines`, `skipComments`, non-test `src/**`, `bin/**` | 4 / 12 |
| functions.longest | same counting: `runIssueWithLogging` is 1,049 counted lines (1,620 raw AST span) | batch-executor.ts |
| functions over 200, by name | workflow: `runIssueWithLogging` 1,049, `RunOrchestrator.run` 646, `ensureWorktree` 393, `executePhaseWithRetry` 262, `runReadyGate` 253 (ready-gate.ts), `executePhase` 233, `ClaudeCodeDriver.executePhase` 230 (drivers/claude-code.ts); commands: `initCommand` 588, `doctorCommand` 555, `syncCommand` 325, `updateCommand` 256, `readyCommand` 206 | 7 + 5 |
| emptyCatch.total / byFile | AST `CatchClause` whose block has zero statements (comments don't count), non-test src | 119; batch-executor 25, conventions-detector 6, state-hook 6, project-name 5 |
| childProcessMockFiles | test files containing `vi.mock("child_process")` or `"node:child_process"` | 31 (6 reference `gh` inside the mock) |
| ghCallFilesOutsideProvider | non-test files containing `spawnSync(\s*"gh"` other than `platforms/github.ts` | 3 files, 4 sites (batch-executor ×2, chain-preflight, merge-check/report) |
| proseGate.files / lines | test files containing the literal `SKILL.md` and `toContain`/`toMatch` | 76 / 30,461 |
| testRatio28d.sum / median | lines added to test paths ÷ lines added to `src|bin|scripts` over non-merge commits on `main` in 28 days; per-commit median over commits with src > 0 | 2.54 (23,405 / 9,217 over 176 commits); 2.32 (n = 93). Report-only: excluded from `--check` because the window slides daily (D-6) |
| deprecatedWithoutRemoval | `@deprecated` JSDoc tags in non-test src not followed on the same line by `remove in v<major.minor>` | 18 of 18 (two mention a version loosely, none in this form) |
| harness.claudeMdLines / skillLines / memoryFiles | `wc -l CLAUDE.md`; sum of `.claude/skills/*/SKILL.md`; files in the project memory dir (local-only metric, reported when the dir exists) | 25 / 15,542 (19 files) / 253 |
| ADR status without actor | `**Status:** Accepted` lines not matching `Accepted (owner, YYYY-MM-DD)` | 11 of 16 |

**Seams observed:**
- Run log: assembled and written by `src/lib/workflow/log-writer.ts` (`fs.writeFileSync` at :448), validated by `run-log-schema.ts` (`version: 1`, optional fields keep the version). Readers: `src/commands/logs.ts`, `src/mcp/tools/logs.ts`, `src/mcp/tools/run.ts`, `src/lib/run-logs.ts`. **#1471 owns the readers** (`commands/logs.ts`, `mcp/tools/logs.ts`, `run-logs.ts`); the writer and schema are free.
- `GitHubProvider` is constructed inline at 7 sites (`new GitHubProvider()`), never injected; `PlatformProvider` interface exists (`fetchIssue`, `postComment`, `addLabel`, `removeLabel`, `createPR`, `getPRStatus`, `postPRComment`, `checkAuth`, `getIssueComments`). The 4 stray `gh` call sites are `gh issue view --json` ×3 and `gh pr comment` ×1, all expressible through the interface.
- ESLint: one `no-restricted-syntax` rule at `error`; a second block with the same rule at another severity replaces it rather than adding to it (flat-config semantics). `no-empty` ignores comment-only blocks by design. The selector `CatchClause > BlockStatement[body.length=0]` was probed and flags comment-only catches (lintprobe/, 2026-10-18).
- Consolidation scopes (verified from issue bodies): #1471 → `phase-executor.ts`, `run-logs.ts`, `commands/logs.ts`, `commands/stats.ts`, `mcp/tools/{logs,run}.ts`, `merge-check/index.ts`, `cli-ui/format.ts`; #1472 → drivers, `ring-buffer.ts`, `process-group.ts`, `mcp/tools/run.ts`; #1475 → `worktree-manager.ts`, `run-orchestrator.ts`, `lib/locks/`, `commands/locks.ts`. **`batch-executor.ts`, `log-writer.ts`, `run-log-schema.ts`, `chain-preflight.ts`, `merge-check/report.ts`, `platforms/*`, `src/commands/{init,doctor,sync,update}.ts` are in no consolidation node.**
- Platform contract: `main` ruleset requires `test` and `canary` only; new advisory jobs never block a merge. Actions token is read-only and cannot approve PRs; no node opens PRs from Actions. Label `graph-2026-10-fundamentals` does not exist (tracker creates it).
- Command splits have tests to preserve: `init.test.ts` + 3 integration files, `doctor.test.ts` + 2, `sync.test.ts` + 2, `update.test.ts` + 1. `runIssueWithLogging` is exported and referenced 115 times in `batch-executor.test.ts`.

## §5 Invariants

- **I-1 Plugin freeze.** No PR in this graph touches `plugin/`, `.claude/skills/`, `templates/skills/`. Checked by the Evidence in every node's Non-Goals.
- **I-2 Measurement ACs, not gate tests.** A node's ACs read a number from F-01's report or run an existing command. New tests are allowed only where an AC needs behaviour (F-03 fault injection, F-05 fixtures); a test that gates a claim carries the CLAUDE.md mutation record as usual. `isGateTestEvidence` classifies six ACs as gates (F-01 AC-3, F-04 AC-4, F-05 AC-2/3/5, F-10 AC-2); each issue names them so the PR carries the `SEQUANT_MUTATION` record §6i expects.
- **I-3 Refactor nodes add no test lines.** F-06, F-07, F-08: `git diff --numstat <merge-base>..HEAD -- '*.test.ts' '*.test.tsx' | awk '{a+=$1} END{print a+0}'` → `0`, and every existing test passes unchanged.
- **I-4 The baseline only moves down, in the PR that earns it.** `scripts/qa/health-baseline.json` is regenerated with `--write-baseline` only in a PR whose diff lowers a metric; a PR that raises one fails the advisory (blocking once W2 lands, D-A).
- **I-5 Launch order.** This graph launches after #1470 closes (D-1 default); W2 waits on #1471 and #1475 by file scope.
- **I-6 Stop-at-PR.** The runner opens PRs; the owner consents per merge. No standing consent.
- **I-7 Nothing is removed and nothing from memory is published** without D-2 / D-5 answered on the tracker.
- **I-8 Run the Evidence, don't reason it.** Every AC's command is run verbatim by QA. At plan time each was run on `main` 96990daab and classified in `phase0-evidence.md`: fails-today, constraint (holds on `main` by construction), or not runnable until a PR, runner input or owner answer exists.

## §6 Per-node design

| Node | Inputs | Outputs | Failure modes | Done when |
|---|---|---|---|---|
| F-00 tracker | this directory | docs-only PR, label, D-1..D-7 answered | docs PR conflicts with another graph's docs PR | directory on `main`, label exists, decisions recorded |
| F-01 health report | source tree, git history | `scripts/qa/health-report.ts`, `health-baseline.json`, advisory CI job, release-checklist line | metric definition drifts from §4; script slow (>60 s) | `--json` prints every §4 metric, `--check` exits 1 on a raised metric |
| F-02 lint + knip | eslint.config.js, package.json | three rules at `error`, knip devDependency + config + advisory job | knip baseline noisy (barrel exports) | `npm run lint` green with no `warn` relaxation; knip job reports |
| F-03 suppressed-error trace | batch-executor's 25 empty catches, log-writer, schema | `suppressed.ts` helper, `suppressed` field in run log, batch-executor converted | helper itself throws; schema version bump by accident | run log carries counts; fault-injection tests pass |
| F-04 remaining catches + display | 94 empty catches, `commands/logs.ts` (after #1471) | zero empty catches, selector at `error`, `sequant logs` prints the count | a catch that was load-bearing becomes noisy | `emptyCatch.total` = 0; lint green |
| F-05 gh seam | 4 stray sites, 6 gh-mocking tests | all `gh` through `PlatformProvider`; `FakeGitHubProvider` + captured fixtures; capture script | fixture drift (same failure as the mocks) → capture script re-run is the remedy, dated | `ghCallFilesOutsideProvider` = 0; no test mocks child_process to fake `gh` |
| F-06 split `runIssueWithLogging` | 1,620-line function, 115 test references | stage functions ≤ 200 counted lines | behaviour change hidden by mocks → golden run on testbed | batch-executor has no function over 200; tests unchanged; golden run identical |
| F-07 split workflow functions + ratchet | `run`, `ensureWorktree`, `executePhaseWithRetry`, `executePhase`, `runReadyGate`, `ClaudeCodeDriver.executePhase` | ≤ 200 each; `max-lines-per-function: 200` for `src/lib/workflow` | conflicts with #1471/#1475 → sequenced after them | `functions.over200` = 0 in workflow; rule in config |
| F-08 split command functions | `initCommand`, `doctorCommand`, `syncCommand`, `updateCommand`, `readyCommand` | ≤ 200 each; rule for `src/commands` | integration tests use inquirer mocks that are order-sensitive | `functions.over200` = 0 in commands; tests unchanged |
| F-09 deprecation lifecycle | 18 `@deprecated` tags | each names `remove in vX.Y`; `lint:deprecations` in CI; CONTRIBUTING rule | choosing versions is a product call → default next minor, owner may bump on the PR | lint exits 0 |
| F-10 removals | D-2 list | one PR per cluster | a "dormant" flag has an undocumented user | each named surface gone, CHANGELOG `Removed`, tests green |
| F-11 prose-gate audit | 76 files | `prose-gates.md` table: execute / checksum / keep + command per execute row | classification disagreement → owner reads the table (D-3) | every file classified |
| F-12 prose-gate conversion | F-11 table, D-3 | execute-class gates run the skill's command; checksum-class deleted | mutation record missing on a converted gate | `proseGate.files` ≤ keep + execute; records present |
| F-13 incidents + ADR authority | D-4, D-5, four memory files | `docs/incidents/TEMPLATE.md`, approved incident docs, ADR README rule, `lint:adr-status` | publishing something confidential → owner reviews every line before the PR is marked ready | template exists; README names the authority; lint green after the owner's reclassification pass |
| F-14 stranger run (#1519, joined 2026-10-18) | `sequant-example` copied per episode, npm `next`/`latest`, a knowledge-free tester on a non-Claude model, a scoped token | one eight-section report per episode in `docs/evidence/stranger-runs/`; transcripts as CI artifacts only | tester self-reports success → ground truth is `gh pr view`, never the claim; S2 looks green and is not → verdict `silent-wrong` from QA-count vs PR-diff disagreement; cost runaway → per-episode cap | S1–S3 report accepted with the owner's rubric fields filled and S2's silent-wrong recorded |

## §7 Decisions

| ID | Decision | Rejected alternatives |
|---|---|---|
| D-A | ACs are measurements against F-01's report; the advisory job turns blocking after W2 | gate tests per node (rejected: produces the 3× test growth the graph exists to stop); blocking from day one (rejected: W0 lands before any cleanup, every PR would fail) |
| D-B | The empty-catch selector lands at `error` in F-04, with all conversions, no warn phase | warn then error (rejected: one `no-restricted-syntax` rule holds one severity; a second block overrides, not adds); `no-empty` (rejected: ignores comment-only blocks by design) |
| D-C | The health report is a repo script under `scripts/qa`, same pattern as `tautology-detector-cli.ts` | extend accretion (rejected: personal side project outside the repo; re-fix-per-file and duplicates stay there and are cited, not recomputed) |
| D-D | Provider injection by optional parameter, defaulting to `new GitHubProvider()` | module-level test setter (rejected: global state leaks across vitest forks, cf. the `process.cwd` spy incident) |
| D-E | Function length is ESLint's counted length (skip blanks and comments), so the ratchet and the metric agree | raw AST span (rejected: 6 > 400 by span vs 4 by ESLint; the lint is what blocks, so it is the number) |
| D-F | Prose gate = test file with the literal `SKILL.md` and a `toContain`/`toMatch` assertion | any `.md` literal (rejected: 104 files, includes docs and CHANGELOG tests that are not skill gates) |
| D-G | Captured fixtures are produced by a script that runs real `gh` and stamps `command` + `capturedAt`; re-capture is the fix for drift | hand-typed fixtures (rejected: the failure mode of #1229 and #1214, "don't mock types you don't own") |
| D-H | Behaviour preservation for splits = tests unchanged (I-3) + golden-run diff of the run log's phase sequence on the testbed | new characterization tests (rejected: I-3); trust the suite alone (rejected: the suite mocks the drivers) |

## §8 Conventions

- Issue bodies: metadata line `**Epic:** graph-2026-10-fundamentals **Tier:** … **Execution:** … **Blocked by:** …`, then one `- **Blocked by**: #N` list item per edge, `## Problem`, `## Acceptance Criteria` (one line per AC, trailing `Evidence:`), `## Prior fixes / producers` (or one line "isolated"), `## May touch`, `## Non-Goals`, `## Done when`.
- Placeholders `#F-NN` until filed; one `gh issue edit` pass substitutes; the issue body is canonical afterwards.
- Merge consent: stop-at-PR (I-6). Tiers: `mechanical` = runner launches with the cheap roster; `judgment` = all-strong, owner reads the diff; `split` = some evidence produced by the runner (golden runs, owner passes).
- Shared merge-point files and their style rule: `eslint.config.js` (one config block per concern, appended; never edit another node's block), `.github/workflows/ci.yml` (one job per node, appended after `tautology-advisory`), `package.json` scripts (one line per node, alphabetical among `lint:*`), `scripts/qa/health-baseline.json` (regenerated only by `--write-baseline`, I-4).
- Clusters (serialize): **batch-executor** F-03 → F-05 → F-06; **ci.yml/package.json** F-01 → F-02 → F-09 (small, append-only; parallel allowed if the runner rebases).

## §9 Open questions and owner gates

| OQ | Question | Resolves in | Default if silent |
|---|---|---|---|
| OQ-1 (D-1) | WIP limit: launch after #1470 closes, or alongside? | F-00 | after |
| OQ-2 (D-2) | Which dormant surface is removed? (usage-audit.md Tables A–G) | F-10 | none; F-10 not filed |
| OQ-3 (D-3) | Mutation mandate binds all tests, or only tests that gate a claim? Affects which checksum gates F-12 may delete | F-12 | binds gate tests only; deletion of a checksum gate needs no record |
| OQ-4 (D-4) | ADR acceptance authority and status format | F-13 | owner; `Accepted (owner, YYYY-MM-DD)` |
| OQ-5 (D-5) | Which of the four memory-only incidents may be published? | F-13 | none |
| OQ-6 (D-6) | Advisory test-lines budget per fix PR | F-01 report only | report, no gate |
| OQ-7 | Fold or decomposed? 14 files here (13 filed at launch, F-10 later); folds available: F-04→F-03, F-08→F-07 | plan review | as written |
| OQ-8 | Golden-run testbed: which repo and issue, and the credit budget for two runs per split node | F-06 | ad-motion, one closed issue re-run with `--phases spec`; owner names it on the tracker |
| OQ-9 | knip: suppress via `knip.json` ignores or a numeric baseline? | F-02 | numeric baseline in `health-baseline.json` (`unusedExports`), knip output advisory |
| OQ-10 | Does `sequant logs` show the suppressed count per issue or per run? | F-04 | per run, with by-scope breakdown |
| OQ-11 | Scratch org for the stranger run's per-episode repo copies | #1519 | a new private org, so a leaked token reaches nothing real |
| OQ-12 | Tester model through opencode | #1519 | the free probe model the opencode memory names |
| OQ-13 | Cost cap per stranger episode | #1519 | 15 USD |
| OQ-14 | Stranger-run cadence | #1519 | every `next` release before `latest` moves, plus on demand |

## §10 After this graph

D-7 (contrast-or-unverified on skill-prose edits) joins the post-freeze skill queue. #1068's ablation decides which qa-skill lines are load-bearing. The outcome window (accretion fix share, re-fix per file, `testRatio28d`) is read at the first release after W2 and again one release later; both numbers are reported on the tracker, neither is promised.
