# guard-2026-09 — the bug-prevention guard set

Planned 2026-09-20 on `origin/main` `e73d0c67` (sequant 2.16.0). Companion to
`../graph-2026-09-w2/PLAN.md`; conventions inherited from graph-2026-09 §8
unless restated in §8 below. Lab notes: `lab-notes-phase0.md`. Graph:
`issue-graph.md`. Every node is already filed; this plan stamps and re-orders,
it does not re-file.

## §1 Problem statement

Sixteen bugs were filed between 2026-09-10 and 09-18. On 09-18 each was
classified by `git log -S` on its code path.

| # | Class | Introduced by / surfaced by | Pattern |
|---|---|---|---|
| #1064 | regression | #981 `strip_comments` (from the #763 chain) | other case untested (`-F -` heredoc) |
| #1030 | regression | #1011 template walk | other case untested (`.opencode/` route) |
| #1054 | regression | #1032 `timeout` wrapper | field only (stock macOS) |
| #1053 | regression | #990 copy mode | other case untested (foreign symlink present); field only |
| #1076 | driver gap | Codex `workspace-write` excludes `.git` | contract never stated |
| #1079 | driver gap | Codex sandbox offline | contract never stated |
| #1087 | driver gap | Codex `turn.failed` typed `unknown` | silent non-action (`--auto-wait` never engages) |
| #1032 | latent | #1060 dogfood | silent non-action (stranded phase) |
| #1044 | latent | #1060 dogfood | parser tested on one shape |
| #1069 | latent | #1059 qa run | silent rewrite of pushed history |
| #1070 | latent | #1059 qa run | silent non-action (AC_NOT_MET never posted) |
| #1071 | latent | 12-repo field sync | other case untested (init on initialized) |
| #1073 | latent | #1059 qa run | parser tested on one shape |
| #1078 | latent | downstream project | other case untested (modified settings.json) |
| #1084 | latent | downstream project | field only (stale local sequant) |
| #1086 | latent | #1060 gate run 3 | dismissed as "pre-existing" in #1036/#1042/#1048 for a week |

Cross-cutting: six "the other case was never tested", five found only in the
field, three silent non-actions, one three-fix regression chain in
`pre-tool.sh` (#763 → #981 → #1064), and one unverified "pre-existing" claim
that shipped three times.

## §2 MVP in one sentence

The smallest guard set that makes `main` unable to go red silently and gives
each of the four bug classes one mechanical test that fails before the field
does, with human approval at exactly two gates: the `main` ruleset change
(G-1 = #1109) and the npm `next` → `latest` promotion (G-2 = #1110).

Includes: the six guard issues, the two follow-ups, the four open bugs whose
fixes the guards need or whose class the graph must not leave silent, and the
two gates. Thirteen nodes plus two gates.

## §3 Non-goals (scope firewall)

| Not now | Why not now |
|---|---|
| auto-revert bot on red `main` | a human reverts; the rule fixes the order, not the actor (D-1) |
| whole-tree StrykerJS | 10³ mutants on a 1.6k-line bash hook and a 2k-line executor is a week of CPU for a signal #1094 gets from a corpus (D-2) |
| macOS / Windows canary runners | ubuntu canary first; #1054 is the only macOS-only bug and its guard is the corpus, not a runner (D-3) |
| hook-array merge of `.claude/settings.json` | rejected by the owner in #1090 D-1; `settings.local.json` is the extension point (D-4) |
| qa with diff+ACs only, 2–3 independent passes | not filed 09-18; needs the #1067 outcome graders to measure (parked §10) |
| a guard for the "qa phase git/posting" class (#1069, #1070) | two instances; Phase 0 found no third (D-6) |
| fixing #1089 | filed 09-18 after the classification; not a member of the 16 |
| merging dependabot #1082 (vitest 5) | #1095 pins to the major on `main`; the bump is its own change (D-7) |
| `#1104` item 3 (Malformed vs Failed marker status) | parked with a trigger (D-8, OQ-7) |

## §4 Architecture as observed, and the seams

- **`main` protection.** Ruleset `CC` (id 12393605) is `active` with rules
  `deletion` + `non_fast_forward` — and `conditions.ref_name.include` is `[]`,
  so it targets no ref. Classic branch protection returns 404. `main` is
  unprotected in practice, not just under-protected. (Lab §1)
- **Suite hermeticity.** `vitest.config.ts` has `globalSetup` only, no `env`
  or `setupFiles`. `SEQUANT_RELAY=true` fails the relay-hook AC-7 test;
  `SEQUANT_ORCHESTRATOR`/`SEQUANT_WORKTREE` alone do not, in a clean shell
  (Lab §2, same null result as 09-18). Fix owner: #1086.
- **Hook corpus sources.** `.sequant/logs/run-*.json` holds phase summaries
  only — zero `command` strings across 93 files. The real sources are the
  Claude Code transcripts (`~/.claude/projects/<slug>/*.jsonl`: 5,601 Bash
  `tool_use` blocks, 5,519 distinct) and the hook's own log
  (`~/.sequant/logs/claude-hook.log`: 603 `BLOCKED [rule] <redacted cmd>`
  lines). Both are machine-local; the harvest is a maintainer-run step and
  the committed corpus is the artifact. (Lab §3) Fix owner: #1094 (AC-1
  source line rewritten; threshold 150 stays).
- **Ownership policy as landed** (`src/lib/templates.ts` on `origin/main`):
  `OWNERSHIP_RULES` → `user-owned`: `.claude/memory/constitution.md`,
  `.sequant/settings.json`, `AGENTS.md`; `merge`: `.mcp.json`,
  `.opencode/opencode.json`, `.gitignore`; `sequant-owned`:
  `.claude/settings.json`, `.opencode/`, `.codex/`,
  `.sequant/settings.reference.md`, default. `TEMPLATE_ROUTES` maps
  `templates/scripts/` → `scripts/dev/` (symlink on POSIX, copy on Windows /
  `--no-symlinks`), `templates/skills/` → `.claude/skills/`,
  `templates/agents/` → `.claude/agents/`, `templates/settings.json` →
  `.claude/settings.json`; `mcp.json`, `relay/`, `opencode/`, `codex/` → null.
  #1097's cells assert these, not the pre-#1090 draft.
- **Driver registry.** `src/lib/workflow/drivers/index.ts` `DRIVERS` map
  (claude-code, aider, codex, opencode). `codex` and `opencode` binaries are
  installed on the planning host. #1096 enumerates from `DRIVERS`.
- **qa phase seams.** `batch-executor.ts:1758` gates the verdict comment on
  `result.success` (#1070). `rebaseBeforePR` (`worktree-manager.ts:1418`,
  called at `batch-executor.ts:2242`) is the rewrite site (#1069).
  `parseQaSummary` (`phase-executor.ts:586`) table-only regex (#1073);
  `buildQaVerdictComment` (`batch-executor.ts:772`) prints the pair
  unconditionally.
- **Skill mirrors.** exec/qa/release skills exist ×3 (`.claude/skills/`,
  `skills/`, `templates/skills/`), byte-identical, `npm run lint:skill-sync`
  44/44. Hook ×3 (`.claude/hooks/`, `hooks/`, `templates/hooks/`).
- **Test layout.** vitest projects `unit` and `integration`; a file without
  `.integration.` gets the 5 s timeout. `scripts/*.test.ts` hold the skill
  gate tests (`lint-skill-gates.test.ts`, `check-skill-sync.test.ts`); there
  is no `scripts/__tests__/`. Issues that name `scripts/__tests__/…` are
  restated to `scripts/<name>.test.ts`.
- **`.github/`.** No `PULL_REQUEST_TEMPLATE.md`. CI job names: `test`
  (matrix), plus a build job.

## §5 Invariants (binding on every agent in this graph)

- I-1 **No full suite in a worktree.** Run only the test files the AC names.
  The runner runs `npm test` once per PR from a clean shell.
- I-2 **A red test outside the diff needs an issue number** in the PR body
  (PR #1101 rule). Until #1093 lands the script, attach the base-vs-head
  result by hand.
- I-3 **Skill mirrors stay byte-identical** (`lint:skill-sync` 44/44) and no
  SKILL.md contains the word relay or `SEQUANT_RELAY` (integration guard
  AC-16, `relay-skill-grep.integration.test.ts`).
- I-4 **Mutation markers:** `failedTest` starts with the test file path
  (`<file> > <describe> > <case>`), else §6i reports Failed.
- I-5 **One AC per line, ids `AC-N` only.** Commits single-line `-m`, no
  `Co-Authored-By`, never rebase or force-push a pushed branch, never merge
  without explicit consent.
- I-6 **Integration seams run real:** #1096 sandbox probes, #1098 npm install
  + MCP handshake, #1093 script against a real temp repo. Mocks only for
  failure injection.
- I-7 **Read `origin/main` via `git show`,** never the main checkout.
- I-8 **Nothing merges #1082.** #1095 targets vitest 4.x.

## §6 Per-node design

Inputs → outputs → failure mode → done-when. Full ACs live on the issues.

| Node | Owns | Produces | Fails when | Done when |
|---|---|---|---|---|
| #1104 | marker contract docs | CLAUDE.md template line, exec-skill section ×3, gate test in `scripts/` | mirrors diverge; test matches whole file | AC-1..4 green, mutation recorded with file prefix |
| #1086 | suite env scrub | prefix scrub in vitest config/setup | scrub is a list; a test that needs the var can't stub it | AC-1 under all four vars + `SEQUANT_RELAY=true` |
| #1095 | parser properties | fast-check dep, 4 property files, `parseQaSummary` checklist + consistency | flaky seeds; touches `batch-executor.ts` outside `buildQaVerdictComment` | 8+ properties, #1073 closed |
| #1053 | copy-mode symlink | `copyTemplates` replaces foreign link; doctor hint; dry-run line | regular file also replaced | AC-1..3 tests green |
| #1106 | ownership gate side (b) | per-site scan in new `src/lib/ownership-gate.ts` + `.test.ts` | edits `templates.test.ts` beyond deleting the old block | 3 synthetic cases + real writers pass |
| #1070 | post AC_NOT_MET | gate on parsed verdict | posts on unparseable verdict | comment posted for a failing verdict in test |
| #1093 | merge gate + proof script | `scripts/settle-against-base.sh` + test, ruleset payload script, skill rules, red-main rule | script loses work; ruleset applied by an agent | AC-2..7 green; G-1 handoff written |
| #1096 | driver conformance | `describe.each` over `DRIVERS`, adapters, docs page | hand-written driver list; mocked sandbox | all drivers pass or skip with reason |
| #1097 | writer state matrix | table-driven suite over writers × states × policies | any `todo`/`skip`; policies not the landed ones | every cell green incl. the three named cells |
| #1069 | qa merge-not-rebase | `rebaseBeforePR` merges when `@{u}` exists | rewrites pushed SHAs | test: pushed branch keeps SHAs |
| #1094 | hook golden corpus | `hook-corpus.jsonl` ≥150, snapshot test, `--harvest`/`--diff`, exec-skill step | corpus from run logs (empty); secrets in corpus | `--diff origin/main` prints `0 verdict changes` |
| #1087 | codex error mapping | `BillingError`/`RateLimitError` from `turn.failed` | #1096 AC-3 fixture drifts from run-2 text | #1096 `codex errors` green + AC-4 |
| #1098 | downstream canary + next soak | canary job, fixture project, release-skill `--soaked` | fixture mocks npm; hook fixture assumes merge | canary green on the PR; G-2 handoff written |
| G-1 | owner: apply ruleset | ruleset with `~DEFAULT_BRANCH`, required `test`, strict | — | `gh api` shows the rule |
| G-2 | owner: canary required + `next` soak | ruleset adds canary; soak across local repos; promote | — | `latest` moved with the soak record on the issue |

## §7 Decisions log

- **D-1** Human reverts red `main`; no bot. Rejected: auto-revert action
  (needs write token on `main`, and every "flaky" revert would need the same
  settle proof anyway).
- **D-2** Diff-scoped verdict corpus for the hook, not Stryker. Rejected:
  whole-tree mutation (cost, and bash has no Stryker).
- **D-3** ubuntu canary only. Rejected: macOS runners now (10× minutes; one
  macOS-only bug in 16).
- **D-4** `.claude/settings.json` is sequant-owned; project hooks live in
  `settings.local.json` (owner, #1090 D-1). #1097 AC-5 and #1098's fixture
  step are restated accordingly.
- **D-5** G-1 and G-2 are their own issues. #1093 AC-1 becomes "emit the
  ruleset payload"; the `gh api -X PUT` is G-1's. #1098 AC-1 becomes "the
  canary job exists and passes on the PR"; requiring it is G-2's.
- **D-6** No guard for the qa-phase git/posting class. Phase 0 found no
  third instance; #1069/#1070 ride as mechanical leaves because the runner
  needs the AC_NOT_MET comment to see its own verdicts.
- **D-7** #1095 pins fast-check config to vitest 4.x; #1082 stays open.
- **D-8** #1104 takes items 1–2 only. Item 3 (Malformed vs Failed) is parked:
  file it if a marker still classifies `test_not_in_diff` on a PR opened
  after #1104 merged (OQ-7).
- **D-9** #1106 moves the side-(b) scan into `src/lib/ownership-gate.ts` +
  `ownership-gate.test.ts`; its only `templates.test.ts` edit is deleting the
  old block, so #1053's appended cases merge cleanly in the same wave.
- **D-10** #1095 AC-3 lives in `parseQaSummary` (return no counts when
  inconsistent); the only `batch-executor.ts` edit allowed is the presence
  guard inside `buildQaVerdictComment`, disjoint from #1070's hunk.
- **D-11** #1094's harvest reads Claude Code transcripts and
  `claude-hook.log`, redacts, and commits the corpus; run logs are not a
  source. Rejected: generating commands (that is #1095's class, and the
  hook's input space is observed, not synthetic).
- **D-12** Research basis, cited once here: merge-commit gating (Uber
  SubmitQueue, Shopify merge queue) → #1093/G-1; hermetic tests (Google) →
  #1086; fresh-context review and mechanically verified "pre-existing"
  claims (Cross-Context Review, Transluce) → #1093 script; differential /
  golden-corpus testing (Csmith, EMI) → #1094; property-based tests
  (fast-check; Ravi & Coblenz OOPSLA'25) → #1095; state-matrix tests
  (TigerBeetle assertion density) → #1097; downstream canary (Amazon
  one-box, Kayenta) → #1098; diff-scoped mutation (Google TSE'21) → the
  mutation-marker gate already in CLAUDE.md, documented by #1104.

- **D-13** (exec, 2026-09-20) An AC that names a nonexistent command is edited by
  the runner on the issue, with a comment, when the intent is unambiguous —
  #1104 AC-4 `lint:skills` → the three real `lint:skill-*` gates. Rejected:
  bouncing to the owner for a script name.
- **D-14** (exec) A doc-gate test in `scripts/` must call a production
  function, or the tautology detector's CLI test fails the full suite; regex
  literals with braces inside `it()` truncate the detector's block. #1104's
  gate test runs the documented example through `parseMutationMarkers`.
- **D-15** (exec) Fixtures never `rmSync` a real-repo path they did not
  create (#1053 doctor fixture guarded with `existsSync`).
- **D-16** (exec) Once failing verdicts post (#1070), every test context that
  reaches `runIssueWithLogging` carries a mocked poster by default.
- **D-17** (exec) #1096 AC-3's mutation is recorded as not applicable while
  the usage-limit cases are `it.fails`; #1087 flips them and owns the record.
- **D-18** (exec) A recorded qa verdict with empty gaps/findings that
  contradicts the transcript's final `### Verdict:` heading is a parser
  artifact (#1119), not a bounce; the runner reads
  `errorContext.stdoutTail` before any re-dispatch.

## §8 Issue conventions

- Stamp: `## Release-graph plan — guard-2026-09` with
  `**Graph:** guard-2026-09   **Tier:** …   **Wave:** N`, `**May touch:** …`,
  then `- **Blocked by**: #N` items directly under it. Existing ACs kept;
  only the ACs named in `issue-graph.md` §Edits are rewritten.
- Tiers: judgment for #1093 and #1096; mechanical for the rest.
- **Merge-consent mode: stop at PR.** No standing consent for this graph.
- Runner rules (from the pre-2.16.0 run): no full suite in worktrees; after
  one AC_NOT_MET bounce the runner fixes a small specified finding itself;
  `gh api -X PATCH repos/{owner}/{repo}/pulls/N -f title=…` and the same for
  issues, never `gh pr edit`; every exec dispatch restates I-4 until #1104
  merges; #1093/#1094/#1104 edit skills, so I-3 is checked on each.
- `Blocked by` edges are hard dependencies only. Wave numbers carry the
  soft ordering (file sharing, suite hygiene).

## §9 Open-questions register

- ~~**OQ-1**~~ **Resolved 2026-09-20** — #1086 AC-5 record on PR #1113: in the worktree both single vars reproduce (`ORCHESTRATOR` alone breaks batch-executor, `WORKTREE` alone breaks prompt-wait — the reverse of the issue's table; Phase 0 saw 1 passed each). The prefix scrub is correct either way; `main` is unchanged. Original: Why do `SEQUANT_ORCHESTRATOR` / `SEQUANT_WORKTREE` alone not
  reproduce in a clean shell when the issue says they do? → #1086 records
  the combined-env result; the prefix scrub is correct either way.
- **OQ-2** Canary wall time under the 6-minute budget on ubuntu? → #1098
  AC-6 measures; full local suite wall time in Lab §5.
- **OQ-3** Does the `codex exec --json` stream carry `rate_limits`? → #1087
  (message-text mapping does not depend on it).
- **OQ-4** Corpus refresh cadence when the sources are machine-local? →
  #1094 documents `--harvest` as a maintainer step; the exec-skill `--diff`
  step needs only the committed file.
- **OQ-5** fast-check under vitest 5 after #1082? → parked; #1082's own PR.
- **OQ-6** Strict up-to-date vs merge queue for a solo maintainer? → G-1
  decides; recommendation strict (no queue latency, no extra runners).
- **OQ-7** Does documenting the marker prefix stop the malformed markers?
  → measured on the first three gate PRs after #1104; trigger for D-8.
- **OQ-8** Does the previous-minor npm install in #1098 need a network
  allowance in CI beyond what `npm ci` already has? → #1098 fixture.

## §10 Parked

- qa receives diff+ACs only, 2–3 independent passes (needs #1067 graders).
- #1104 item 3 (D-8).
- macOS/Windows canary runners (D-3).
- `Manifest.files` population (from the wave-2 plan §10, unchanged).
