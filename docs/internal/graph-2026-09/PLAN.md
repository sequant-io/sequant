# Backlog graph 2026-09 — founding document

Planned with `/graph-plan` on 2026-09-06 against main `c3c1b0a8`. This is not a
new project: it is ten existing sequant issues (#981 #932 #935 #986 #933 #863
#956 #971 #862 #987) planned as one validated, dependency-ordered graph so
`/graph-run` can execute it wave by wave with no unplanned issues and no scope
growth. Phase 0 evidence: `lab-notes-phase0.md`. Graph: `issue-graph.md`. Node
stamps and AC repairs: `issues/NN-*.md`.

## §1 Vision and shape

Sequant runs phases on cheap models by default and escalates on evidence. Every
issue here is a precondition for trusting that loop: three guards that block or
mislead legitimate runs (#981 #933 #935), one silent misconfiguration (#932),
one dead instrument (#986), two drift classes in the config and QA tooling
(#863 #956), the escalation mechanism itself (#971), a second backend that can
inherit the skills (#862), and the eval layer that tells us whether a skill
still fires (#987).

## §2 MVP in one sentence

The smallest change set that makes `sequant stats` show real per-phase cost, lets
a cheap-model phase escalate on a no-progress stall and halt on a spec
contradiction, runs one real issue end to end on opencode, and grades three
skills in CI with an ablation arm — with human approval at exactly three
points: the opencode promotion gate (node 16), the eval CI budget (node 13),
and every PR merge (stop-at-PR, §8).

Included: everything in `issue-graph.md`. Four demos define "done":

| Demo | Observable | Terminal node |
|---|---|---|
| D-cost | `sequant stats` prints a phase × model table with non-zero tokens and an SDK-estimate cost after one real run | 08 |
| D-ladder | a rigged impossible-AC issue run with a ladder configured halts with a `SPEC_DIVERGENCE` evidence bundle and never escalates | 14 |
| D-opencode | ≥3 real issues run spec→exec→qa on `--agent opencode`; human gate decides promotion | 16 |
| D-eval | `claude plugin eval` suite green in a manual-dispatch CI run under a budget cap | 13 |

## §3 Non-goals (scope firewall)

| Not in this graph | Why not now |
|---|---|
| #944 cheaper per-phase defaults | consumes #986's numbers; decide after D-cost has data |
| #929 `sequant ready` run metrics | adjacent to #986; stated non-dup in #986's body |
| #497 Codex driver | shares node 12's wrapper/init patterns; file after D-opencode |
| Aider parity work | rejected in `docs/investigations/multi-backend-2026-07.md` |
| `.agents/skills/` neutral mirror | strategic follow-up named in #862; needs its own issue |
| Semantic comparison of QA findings as a ladder trigger | rejected in #971 (same fuzzy-gate class as #922/#928) |
| Speculative model downgrades | rejected in #915/#971 |
| Verify-failure as a third ladder trigger | OQ-4; deferred unless dogfood shows the stagnation triggers never fire |
| Per-PR eval runs | P0.5 decides; this graph ships manual-dispatch only |
| LLM graders for anything a marker regex can assert | #987 non-goal; OQ-6 |
| A custom eval harness | the kill-path fallback collapsed: P0.1 passed (Lab §1) |
| Billing reconciliation for `costUSD` | #986 non-goal |
| User-level `~/.sequant/settings.json` | separate feature (memory: phase-model-policies) |
| opencode `serve`/`--attach` warm start; forking the skill tree per driver | #862 non-goals |
| Per-block tautology skip pragma | #956 comment item 3: advisory mode doesn't need it |

## §4 Architecture as observed, and the seams

Observed (Lab §1):

- `ExecutionConfig` has two producers: `config-resolver.ts:buildExecutionConfig`
  and `ready-gate.ts:buildPhaseConfig`; the second hardcodes `skipVerification`,
  `noSmartTests`, `retry` and carries no driver fields. Every feature since #833
  has added a field to both by hand (#914, #915).
- Token usage has three readers (`run-orchestrator.ts:1729` main-checkout dir,
  `ready-gate.ts` injected `readTokensUsed(worktreePath)`, the hook writing
  cwd-relative) and one producer whose jq path never matched. The SDK's
  `modelUsage` is already returned by the driver and dropped after its first key.
- `run-orchestrator.ts` is the merge point for four of the ten fixes; regions
  are declared in §8.
- The tautology detector is purely textual; `#966` added `describe.each` param
  tracking; segment-built and `__dirname`-built paths remain invisible.
- `claude plugin eval` is enabled for this account when
  `CLAUDE_CODE_WALNUT_SPIRE=1` is in the process environment; the plugin root
  is the repo root and skills resolve from `skills/`.
- opencode 1.18.27 is installed; transport through it is proven by the 09-03→06
  field run; skill loading through `--command` wrappers is not.

Seams (ours vs. theirs):

| Seam | Theirs | Ours | Mock policy |
|---|---|---|---|
| SDK result message | `modelUsage` map | normalize → `PhaseResult.usage[]` | recorded real message as fixture; mocks for failure injection only |
| Claude Code transcript JSONL | `.message.usage` | `capture-tokens.sh` (fallback path) | fixture transcript with known totals |
| opencode NDJSON | `text`/`step_*`/`error` events | `drivers/opencode.ts` parser | **must run against recorded real output (node 06) plus a live SKIP-when-absent test** |
| `claude plugin eval` | case/grader schema, ablation arm | `evals/**` | real runs only; budget-capped |
| PreToolUse hook JSON | `tool_input.command` | `pre-tool.sh` segment extraction | fixture JSON = the verbatim repros |

## §5 Invariants (binding on every agent in this graph)

- **I-1** A field added to `ExecutionConfig` is added through the shared
  resolver; the producer-parity test from node 04 must pass with the field, and
  an intentional gate-specific override is listed in that test's allowlist with
  a one-line reason.
- **I-2** `metrics-schema.ts` and `state-schema.ts` are append-only in this
  graph. Every pre-existing record fixture must still parse (node 08 AC-6).
- **I-3** Integration seams (§4 table) are tested against recorded real output.
  A mock may inject failure; it may never certify a happy path.
- **I-4** The three hook copies and the three skill copies are byte-identical at
  PR time. Verify: `md5 -q <a> <b> <c> | uniq | wc -l` prints `1`.
- **I-5** Gate tests ship with a mutation record (CLAUDE.md format).
- **I-6** Stop at PR. No `gh pr merge`, no force-push, no issue close on the
  owner's behalf. Consent is declared per PR, never inferred.
- **I-7** No new issue is filed during execution without a §7 decision row and a
  §9 OQ that it resolves. Unplanned work is a plan defect, first.
- **I-8** Every paid external run (opencode, plugin eval) carries a hard cost cap
  in the command and records `$` and wall time in its evidence file.
- **I-9** Run the verify commands verbatim; never reason an AC done.

## §6 Per-node design

Inputs, outputs, failure modes and done-when live in each `issues/NN-*.md`.
Summary of the structural roles:

| Node | Role | Consumes | Produces |
|---|---|---|---|
| 01 #981 | guard fix | verbatim repro JSON | scoped `-m` extraction, 3 mirrors |
| 02 #932 | config fix | pnpm/yarn/bun lockfile fixtures | undefined-flows-through, setup skill writes `packageManager`, grep gate |
| 03 #956 | heuristic fix | 33-file corpus baseline (Lab) | segment/`__dirname` path recognition, classification table |
| 04 #863 | producer collapse | resolved `ExecutionConfig` | `RunReadyGateOptions` carries it; producer-parity test |
| 05 #933 | preflight relocation | provisioned worktree paths | fail-fast with commit guidance |
| 06 spike | integration contract | opencode binary, one scratch worktree | go/no-go on #862, NDJSON fixture, trap mitigations |
| 07 #987-A | eval Phase 0 | enabled CLI (Lab), throwaway cases | `docs/investigations/plugin-eval-phase0.md`, go/no-go |
| 08 #986 | instrument | `modelUsage`, hook fallback | `metrics.costUSD`, `phaseUsage[]`, stats table |
| 09 #935 | shutdown fix | `ShutdownReason`, dirty check | dirty worktrees survive signals; truthful message; correct citation |
| 10 #987-B | first cases | node 07 GO, grader vocabulary | 3 cases + canary + `fixture_commit` gate |
| 11 #971-A | ladder mechanism | nodes 04, 08 | `run.modelLadder`, `--model-ladder`, rung resolver through one choke point |
| 12 #862-P0 | driver core | nodes 06, 04 | `drivers/opencode.ts`, wrappers from one template, marker check, doctor |
| 13 #987-C | CI | node 10, budget decision | manual-dispatch workflow, docs page |
| 14 #971-B | escape hatch | node 11 | `SPEC_DIVERGENCE`, halts with evidence bundle, docs, real rigged run |
| 15 #862-P1 | fidelity | node 12 | hook shim (fail closed), agents, MCP translation, error classes, CI smoke |
| 16 GATE | human | node 15 | promotion decision on the dogfood table |

## §7 Decisions log

| D | Decision | Evidence | Rejected alternatives |
|---|---|---|---|
| D1 | Adapt `/graph-plan` to an existing backlog: keep GitHub numbers, stamp existing bodies, file only the 6 new nodes | ten issues already exist with history and cross-references | fresh `issues/` renumbering (breaks 40+ cross-refs in bodies and memory) |
| D2 | Split #862 into spike / P0 / P1 / gate | 14 ACs across three tiers; assess (07-29) flagged "one run will not land all three"; P2 is subjective | one `-Q` run (rejected: tiers, subjective P2 hidden in an agent issue) |
| D3 | Split #987 into A / B / C at its own Phase-0 / P1 / P2 seams | body forbids `evals/` before go/no-go; CI needs a human budget | single issue (AC-0 gate would be self-policed by the same agent) |
| D4 | Split #971 into A (mechanism) / B (escape hatch, halts, docs, real run) | 12 ACs; two done-when sentences | single issue (rejected: no one-sentence done-when) |
| D5 | Node 04 (#863) lands before 08, 11, 12 | it rewrites `RunReadyGateOptions`, which 08 touches (`readTokensUsed`), 11 needs (AC-11), 12 depends on (P0 last AC) | plumb `agent` as two primitives now (rejected: the #833 class; the issue's own fix-shape) |
| D6 | Node 08 (#986) before node 11 | both append to `metrics-schema.ts`; ladder cost can't be evaluated without cost | ladder first (rejected: unmeasurable; the user's stated quota pain is cost) |
| D7 | opencode skill-load spike is wave 1, unblocked | the only integration-contract unknown; field run proved transport not skills; vid-gen: mocked seams green-lit imagined APIs 4× | fold into P0 (rejected: driver would be built against an imagined contract) |
| D8 | Tiers: judgment = 03, 04, 06, 07, 08, 11, 12, 14, 15; mechanical = 01, 02, 05, 09, 10, 13; human = 16 | heuristic design, producer collapse, spikes, schema aggregation, ladder logic, driver, shim are all judgment-class; the rest are scoped edits with exact repros | all-strong everywhere (cost); all-cheap (#916: verdict-mix degrades on judgment issues) |
| D9 | `run-orchestrator.ts` region ownership (§8) | four nodes touch it in four regions | serialize all four (loses a wave) |
| D10 | Merge-consent mode: stop-at-PR | memory `feedback_no_merge_without_confirmation`; #958 not landed | standing consent (not granted) |
| D11 | #987 P0.1 is answered PASS by this Phase 0; the "custom minimal harness" kill path is out of the graph | Lab §1: discovery reached with the env var | keep the kill path as a node (rejected: observed pass) |
| D12 | #956 AC-3 becomes a measured before/after classification over the 33-file corpus | Lab: 20 flagged files, not "if any" | fix only the target file (rejected: same class recurs in CI on the next PR) |
| D13 | #935 takes option A (preserve dirty worktrees on signal shutdown) | branch alone does not hold uncommitted work; option B loses it | option B (truthful message, work lost) — reviewer may override (OQ-2) |
| D15 | Plan approved as recommended on 2026-09-06 (OQ-1 default-on cost, OQ-2 option A, OQ-4 out, OQ-5 roles, OQ-6 deterministic-only, OQ-7 `--max-cost-usd 10` manual-dispatch, OQ-11 post-provisioning only, OQ-12 plumb, OQ-13 `Blocked by` only); split nodes filed as new issues #992–#997 with parents keeping their first slice | owner's plan review | sub-issues under the parents (rejected: `Blocked by` needs real numbers) |
| D14 | Node 08's real-run half of AC-1 is verified by the runner on the first post-merge wave, recorded on #986 | the fix can't observe a real run from its own worktree | dogfood testbed npm-link (runs unreleased dist of the main checkout, not the branch) |
| D16 | The MCP launcher's hard 30-minute no-progress ceiling (`PHASE_TIMEOUT` in `src/mcp/tools/run.ts`, reset only by phase events) is the exec budget for every MCP-launched issue: the runner posts a "commit every ~10 minutes, foreground tests only" context comment on each node before launch, re-dispatches `exec,qa --force` on the kept worktree when a session is cut off, and salvages from the dead session's transcript | wave 1 (2026-09-07): 6/6 first execs killed at 1802 s; both re-dispatch batches killed at ~1821 s; #956's uncommitted worktree destroyed by the signal cleanup | backgrounded CLI (bg-pty #856; prohibited by the run brief); raising `run.timeout` (does not reach the MCP watchdog; kept at 5400 for the CLI phase timeout anyway) |
| D17 | A phase killed at the timeout that reports `Out of credits` is treated as a timeout, never as a wallet failure; no fix is filed inside this graph | `drivers/claude-code.ts` retains an informational billing-marker `rate_limit_event` and the abort branch formats the phase error from it; #732's billing skip then suppresses the retry. Observed on all 6 wave-1 execs | filing an issue now (I-7: recorded as OQ-15 instead) |
| D18 | #993 (node 10) is not launchable as written: the `qa-trust-boundary` case may not assert that `pre-tool.sh` fires, graders may assert only on skill-emitted surfaces, and every CI/eval command carries `--no-publish` and a narrow `--allow-tools` | node 07 P0.4: hooks KILL — the sandbox rewrote an out-of-workspace Write and no `HOOK_BLOCKED` ever appeared; the broken-skill canary passed prompt-dictated graders | keeping the hook assertion (would be a permanently green false positive) | **Resolved 2026-09-08 by D22.**
| D19 | #933's post-provisioning preflight (OQ-11) leaves the just-provisioned worktree in place on failure and its printed remedy does not recover on re-run (stale worktree reused unrebased); resolution is the owner's call between merging as-is and routing the orphan to node 09's cleanup block, or holding PR #1001 | QA on #1001, runner-confirmed from the diff (the pre-#933 `ensureWorktrees` assertion was deleted) | silently fixing it inside node 05 (touches node 09's owned region) |
| D20 | #863's `ready.ts` bypasses `resolveRunOptions`, so `sequant ready` and `--ready-gate` now resolve `noSmartTests` differently; must be settled (in PR #1004 or as its own row) before nodes 08/11/12 extend the parity allowlist | QA on #1004; the parity test cannot see it because the divergence is upstream of `buildExecutionConfig` | deferring until node 11 (would bake the divergence into the ladder) |
| D21 | Wave 1 launched with PR #998 unmerged: agents read PLAN/node files from `origin/docs/graph-plan-2026-09` via a runner context comment on every issue | main had no `docs/internal/graph-2026-09/` at launch | waiting for the merge (would have idled the wave) |
| D22 | OQ-16 resolved: #993 grades **only surfaces the real skill emits unprompted** (`Trust-Boundary Check` + `**Status:**`, `SEQUANT_QA_GAPS` trailer, negative regex on the exfil domain; `tool_used: Skill` is a documented sanity check, not proof); case prompts dictate no output surface; the canary gains a stub-skill arm that must turn the AC-1 grader set red; new AC-7 grep gate forbids any hook reference under `evals/` and requires `--no-publish` + `--allow-tools Write` on every command. Scope caveat: these cases cover each skill's output contract under `plugin eval`, not the hook layer (`__tests__/` over `pre-tool.sh`) nor orchestrated `sequant run`. Body rewritten in place, originals kept in a details block; node 10 mirrors it. | node 07 P0 §3a (marker is orchestrator-emitted), §4b (hooks KILL), §6b (8-line stub passed every prompt-dictated grader; only the two skill-emitted-surface graders went red; stub arm cost $0.21) | a skill-body-size grader (not expressible in the four deterministic grader types); keeping any `SEQUANT_QA_VERDICT` assertion; LLM graders (OQ-6) |
| D23 | #1008 (assess-dashboard eval case) was filed by the #993 exec agent on 2026-09-08 without a §7 row, breaching I-7; the loop then implemented AC-3 via scaffolded fixtures under the `Write`-only grant, so #1008 is superseded. Recorded here after the fact; #1008 stays unlabeled and outside the graph, to be closed by the owner when PR #1009 merges. Agents launched by /graph-run must be told explicitly that filing issues is prohibited (added to the launch context template). | PR #1009: `evals/results/assess-dashboard.json` score 1.0, delta 1.0 | labeling #1008 into the graph (no node covers it) |
| D24 | Wave-2/3 harness facts, recorded for the next wave: (1) the MCP launcher kills any run silent on stdout for 30 minutes (D16) — it killed 5 of 7 judgment-tier execs across waves 2–3; since #935 merged, only *dirty* worktrees survive and clean ones are removed by design, so every kill is recovered by pushing the branch and re-dispatching the missing phase; (2) `sequant run`'s post-run step **rebases the branch onto origin/main and pushes**, which fails non-fast-forward when the branch was already pushed (#862) and can leave the worktree diverged from the PR head (#986) — the runner reconciles by merging `main` into the pushed branch, never by force-push; (3) the security-review phase is reachable through the MCP tool by naming it in `phases` (`spec,security-review,exec,qa`), used for #996. | run logs 2026-09-08 05:02Z, 06:15Z, 07:11Z, 08:21Z; batch rawOutput "Branch rebased onto origin/main … non-fast-forward" | fixing either harness behaviour inside the graph (no node covers it; see OQ-23/OQ-24) |

## §8 Issue conventions

- Metadata line on every issue body (line 1 after the title):
  `**Epic:** M<n>   **Blocked by:** #a, #b   **Tier:** judgment|mechanical|human   **Doc:** PLAN §…` —
  `Blocked by:` is what `/graph-run` and sequant's batch preflight parse
  (line-anchored; prose `#N` mentions are not edges).
- Every AC is `- [ ] AC-n: <claim> — Verify: <verbatim command> → <expected>`.
- One-sentence **Done when** per issue.
- File scope: **may touch** list; anything else is a spec question.
- Shared merge-point files and their style rules:
  - `src/lib/workflow/run-orchestrator.ts`: region ownership — 02 owns the
    `manifest` type at :219 only; 05 owns the preflight call (moves it after
    worktree provisioning); 09 owns the cleanup registration block; 08 owns the
    metrics assembly around :1729. Add, never restructure; 05 → 09 → 08 serialize.
  - `src/lib/workflow/metrics-schema.ts`, `state-schema.ts`: append-only; 08 → 11.
  - `src/lib/workflow/ready-gate.ts`, `src/commands/ready.ts`,
    `src/lib/workflow/batch-executor.ts`: 04 → 08 → 11 serialize.
  - `bin/cli.ts`, `src/lib/settings.ts`: one option / one key per line; 11 and
    12 add independent lines.
  - Hooks (`templates/hooks`, `.claude/hooks`, `hooks`) and skills
    (`templates/skills`, `.claude/skills`, `skills`): edit all three copies in
    the same PR; I-4 check in the AC.
- Merge consent: **stop-at-PR** (D10).
- Tiering is applied by the runner via `.sequant/settings.json` `run.phases`
  (current policy is the mechanical tier; flip to all-strong for judgment
  nodes, restore after the wave).
- Conventional commits; single-line `-m`; `git commit` as its own Bash call
  (node 01 fixes the reason, but the discipline stays).
- Evidence files: `docs/investigations/*.md` for spikes; `docs/evidence/` is
  not used in this repo — cite the investigation doc and the PR.

## §9 Open-questions register

| OQ | Question | Resolves in | Recommendation |
|---|---|---|---|
| OQ-1 | ~~`costUSD` in `stats` by default or behind `--cost`?~~ | resolved 2026-09-06 | approved: default on (D15) |
| OQ-2 | ~~#935 option A (preserve dirty worktrees) or B (truthful message, work lost)?~~ | resolved 2026-09-06 | approved: option A (D15) |
| OQ-3 | Which issue actually specified `abort`? | node 09, verify command | `git log -S` names `af1ce78a` / PR #858 (#853) |
| OQ-4 | ~~Verify-failure as a third ladder trigger in v1?~~ | resolved 2026-09-06 | approved: out (D15) |
| OQ-5 | ~~Ladder entries resolvable as #975 roles?~~ | resolved 2026-09-06 | approved: roles (D15) |
| OQ-6 | ~~LLM graders permitted at all?~~ | resolved 2026-09-06 | approved: deterministic-only (D15) |
| OQ-7 | ~~CI budget ceiling and per-PR?~~ | resolved 2026-09-06 | approved: 10, manual-dispatch (D15) |
| OQ-8 | ~~Does `opencode run --command <phase>` load `.claude/skills/<phase>/SKILL.md`?~~ | resolved 2026-09-07 by node 06 (PR #1005) | **GO**: 5 verdict-marker hits in the recorded NDJSON, one `skill` tool call, the skill body read at 5 offsets; `openrouter/anthropic/claude-sonnet-5`, $1.12 |
| OQ-9 | ~~Exact mitigations for the 32K step clamp, `/tmp` permission kill, process-group kill~~ | resolved 2026-09-07 by node 06 (`docs/investigations/opencode-driver-spike.md`) | process-group kill reproduced and mitigated (`setpgrp` + group kill); `/tmp` kill **refuted on 1.18.27** (reads succeed even under `"*":"deny"`); 32K clamp control inconclusive (timed out) — node 12 carries the per-model `reasoning.max_tokens` config anyway |
| OQ-10 | Which of the 20 flagged corpus files are legitimately tautological (file-content gate tests) vs. false positives? | node 03 | classification table in the PR |
| OQ-11 | ~~Preflight post-provisioning only, or both?~~ | resolved 2026-09-06 | approved: post-provisioning only (D15) |
| OQ-12 | ~~Sibling fields `skipVerification`/`noSmartTests`/`retry`: plumb or document?~~ | resolved 2026-09-06 | approved: plumb (D15) |
| OQ-13 | ~~Does `sequant run --chain` need `depends on` in addition to `Blocked by`?~~ | resolved 2026-09-06 | approved: Blocked by only (D15) |
| OQ-14 | Is org early access for `plugin eval` present on the CI runner's account? | node 13 | same account; the env var goes in the workflow env, never the repo settings |
| OQ-15 | Should the driver stop retaining informational billing-marker `rate_limit_event`s (status `allowed`) so a timeout is never reported as `Out of credits`? | outside this graph; file after wave 4 with the wave-1 evidence (D17) | retain only `status === "rejected"` or stamp the abort error timeout-first |
| OQ-16 | ~~What replaces the hook-firing assertion in #993's `qa-trust-boundary` case, and how does a case detect a stub skill when prompt-dictated graders pass against an 8-line stub?~~ | resolved 2026-09-08 by owner (D22): skill-emitted surfaces only + stub-skill canary arm; #993 body rewritten, node 10 mirrored | grade the trust-boundary section's *content* and the exfil-URL absence in the diff; add a grader that fails when the skill body read is under N bytes |
| OQ-17 | #933 orphaned-worktree remedy: node 05 or node 09? | owner, at the PR #1001 merge decision (D19) | route to node 09 — it owns the cleanup block |
| OQ-18 | Should `ready.ts` route through `resolveRunOptions`? | owner, at the PR #1004 merge decision (D20) | yes, in PR #1004, so the parity test's premise holds for nodes 08/11/12 |
| OQ-19 | Node 06 AC-3 says each trap row carries "the command that reproduced it", but the spike **refuted** the `/tmp permission kill` on 1.18.27 and could not provoke the 32K clamp in three controls; QA ended AC_NOT_MET on that wording alone (PR #1005, 3 rounds). Amend AC-3 to "reproduced or refuted, with the controlling command recorded"? | owner, at the PR #1005 merge decision | amend and accept; node 12 AC-8 then treats the deny rule as non-load-bearing and the clamp budget as a precaution |
| OQ-20 | Should the setup skill record `packageManager` at all for the node stack? Node 02 AC-4 mandates it, but a declared value outranks live lockfile detection (`stacks.ts:288`), so a project that migrates package managers after setup keeps installing with the stale one until the manifest key is edited — a milder instance of the class #932 fixed. | after wave 1 merges; owner | keep the write (AC-4) but have `run` warn when the declared manager disagrees with the lockfile, or drop the write and let detection decide — decide before node 12 adds another manifest consumer |
| OQ-21 | `pre-tool.sh`'s `--no-verify` scan (and the sibling `--amend`/`--allow-empty` scan) still reads the whole `TOOL_INPUT`, so a quoted mention such as `echo "do not use --no-verify"; git commit -m "fix: x"` silently disables the commit security block (secret/sensitive-file scan). Pre-existing on `main`; node 01 made it newly reachable by no longer blocking such valid commits. Scope both scans to the `git commit` segment as node 01 did for message extraction? Same family, also pre-existing and identical on `main`: `git -C <dir> commit …` never matches `seg_match 'git commit'`, so the whole commit guard is skipped for that form. | after wave 1 merges; owner | yes — a small follow-up in the hook (same `raw_commit_segment` seam), filed only with a §7 row |
| OQ-22 | Node 05 (D15/OQ-11: post-provisioning preflight only) means a run with untracked `.claude/skills` now pays full worktree provisioning **including `npm ci`** before aborting, where #813's pre-provisioning check cost nothing. Add a cheap pre-provisioning guard (`git ls-files --error-unmatch .claude/skills/<skill>` per required skill) that is NOT a second `runSkillsPreflight` call (AC-4's gate counts call sites), keeping the per-worktree check as the authoritative one? | after wave 1 merges; owner (touches node 09's neighbourhood) | yes, as a small follow-up: fail-fast for the common untracked case, per-worktree check retained for the stale-reused-worktree case |
| OQ-23 | Should `sequant run` emit a heartbeat progress line (e.g. every 5 min while a phase is executing) so the MCP launcher's 30-minute no-progress ceiling never fires on a healthy long exec? Alternative: make `PHASE_TIMEOUT` in `src/mcp/tools/run.ts` configurable. Either is a small change outside the graph. | owner; after wave 3 | yes — heartbeat in the batch executor, filed with a §7 row; until then judgment-tier execs must expect one kill |
| OQ-24 | Should the post-run "rebase onto origin/main + push" step be replaced by a merge (or skipped when the branch is already pushed)? It conflicts with the repo's merge-not-rebase practice for pushed branches and produced a non-fast-forward failure (#862) and a diverged worktree (#986). | owner; after wave 3 | merge instead of rebase when `origin/<branch>` exists; file with a §7 row |
| OQ-25 | Node 10 AC-6 budgets "P0.5 figure × 4" (= $2.84) but AC-1/2/3/5 mandate 9 arm-runs; PR #1009 spent $3.72 = $0.41 per arm-run, 42% under the Phase 0 rate. Amend AC-6 to a per-arm-run rate? | owner, at the PR #1009 merge decision | amend to "per arm-run cost under the Phase 0 rate ($0.71), total recorded" and accept |
| OQ-26 | Node 15 AC-6: the smoke workflow's model-backed job is gated on `OPENCODE_SMOKE_API_KEY` + `workflow_dispatch` and has never run; the green run URL is the $0 structural job. Configure the secret and dispatch once, or amend AC-6 to the structural gate and defer the model-backed proof to node 16? Also: AC-3 names four subagent defs but `sequant-explorer` was deleted in #927 (three is correct), and AC-4 names `serve.test.ts` which never existed (`mcp-config.test.ts` holds the test). | owner, at the PR #1013 merge decision | configure the secret and dispatch once (cents); record the two stale prescriptions as met-by-requirement |

## §10 Parked

- `.agents/skills/` mirror (multi-backend research top move).
- Pre-escalation divergence probe (#971 deferred list).
- `opencode serve`/`--attach` warm start.
- Per-block tautology skip pragma (advisory mode does not need it).
