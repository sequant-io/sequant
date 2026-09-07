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
| OQ-8 | Does `opencode run --command <phase>` load `.claude/skills/<phase>/SKILL.md`? | node 06 = #992 | unknown — the spike exists for this |
| OQ-9 | Exact mitigations for the 32K step clamp, `/tmp` permission kill, process-group kill | node 06 | record the config verbatim; node 12 consumes |
| OQ-10 | Which of the 20 flagged corpus files are legitimately tautological (file-content gate tests) vs. false positives? | node 03 | classification table in the PR |
| OQ-11 | ~~Preflight post-provisioning only, or both?~~ | resolved 2026-09-06 | approved: post-provisioning only (D15) |
| OQ-12 | ~~Sibling fields `skipVerification`/`noSmartTests`/`retry`: plumb or document?~~ | resolved 2026-09-06 | approved: plumb (D15) |
| OQ-13 | ~~Does `sequant run --chain` need `depends on` in addition to `Blocked by`?~~ | resolved 2026-09-06 | approved: Blocked by only (D15) |
| OQ-14 | Is org early access for `plugin eval` present on the CI runner's account? | node 13 | same account; the env var goes in the workflow env, never the repo settings |

## §10 Parked

- `.agents/skills/` mirror (multi-backend research top move).
- Pre-escalation divergence probe (#971 deferred list).
- `opencode serve`/`--attach` warm start.
- Per-block tautology skip pragma (advisory mode does not need it).
