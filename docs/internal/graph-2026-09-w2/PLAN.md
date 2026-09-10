# Wave 2 — sync ownership, fresh-session QA, public trust contract

Planned 2026-09-09 on main `70815921` (sequant 2.14.0). Companion to
`../graph-2026-09/PLAN.md` (complete: 15/16 merged, #997 deferred). This is a
small graph: three frontier nodes (the wave), a security tail, two human gates,
and the edge that unblocks #944. Conventions are inherited from graph-2026-09
§8 unless restated in §8 below. Lab notes: `lab-notes-phase0.md`.

## §1 Vision and shape

Three unrelated pressures, one wave:

- **Ownership.** `sequant sync` still destroys downstream-owned tracked files
  after the #988 fix (v2.13.1): a hand-maintained `AGENTS.md` becomes a copy of
  `CLAUDE.md`, and `scripts/dev/*.sh` symlinks are re-pointed at whichever
  package ran the command (#990, #991). The last open file class from the
  2026-09-06 incident.
- **Fresh eyes.** Orchestrated QA resumes the implementer's session (median
  142k tokens of the author's transcript) as a side effect of #674; the
  fresh-session study found fresh QA catches a would-ship bug 44% of the time
  (#982). Full-weight QA exists (#683) but only `sequant ready` can reach it.
- **Readable trust.** The prompt-injection posture is real (16 deterministic
  hook guards, a required Trust-Boundary Check, an eval case with deterministic
  graders) and unreadable: no `SECURITY.md`, no threat model, no standards
  mapping (#980).

And the lever behind #944: #986 made per-run cost visible for the first time
(Lab §2). #982 moves the QA cost baseline, so #944 measures after it, not beside
it.

## §2 MVP in one sentence

The smallest change set that makes `sync` never clobber a user-owned tracked
file, makes orchestrated QA start from a fresh session, and publishes a
mechanically-gated `SECURITY.md` + threat model — with human approval at exactly
two gates: the security decisions (trusted publishing, standards wording,
landing ride-along) and the field verification that also records the
post-#982 cost baseline for #944.

Includes: nodes 01–03 (wave 1), 04–05 and 07 (security tail), gates 06 and 08.

## §3 Non-goals (scope firewall)

| Not now | Why not now |
|---|---|
| gitignoring `scripts/dev/` | changes what a fresh clone gets; #991 deferred it explicitly → OQ-1 |
| fresh session for exec/loop | anchoring is intentional there (#982 non-goal) |
| `run.fullQa` default-on | opt-in first; revisit after gate 08 (#982 non-goal) → OQ-3 |
| editing `canResume` | driver ability contract (I-3) |
| populating `Manifest.files` | never populated today (Lab §1); a template-wide drift feature, not this wave → §10 |
| new containment mechanisms | #934's scope; the threat model documents what exists |
| model-level injection defenses, network-egress sandboxing | upstream layers; the threat model names whose layer owns them |
| any hook or skill edit | no node touches them; a diff there is a scope violation (I-4) |
| #944 adoption itself | edge only (node 08 → #944); measured, not planned here |
| #929, #941, #919 | D10 |
| `/fullsolve` changes, plugin-conditional delegation | #982 non-goal |

## §4 Architecture as observed, and the seams

- **Template sync seam** (node 01). `src/lib/templates.ts` — copy/symlink
  dispatch `:663-682`, `symlinkDir` `:473-507` (target =
  `relative(dirname(dest), src)`), `CUSTOMIZABLE_FILES` `:238`,
  `getTemplatesDir` `:122-134` (env override returned verbatim) →
  `src/commands/sync.ts` — AGENTS.md regeneration `:498-512`, preserved report
  `:386`, `--force` `:371` → `src/lib/agents-md.ts` — `generateAgentsMd`
  (`:88-118`), `checkAgentsMdConsistency` (`:152-178`) →
  `src/commands/doctor.ts` — AGENTS.md check `:320-360`.
  `src/commands/init.ts` — `--no-agents-md` `:807-828`, `GITIGNORE_ENTRIES`
  `:101`. `Manifest.files` declared, never written.
- **Phase dispatch seam** (node 02). `src/lib/workflow/batch-executor.ts`
  captures `resumeHandle` after spec (`:1142`) and every phase (`:1653`) and
  offers it to every `executePhaseWithRetry` (`:1122`, `:1638`, `:1957`). Spec
  runs in the main checkout; exec/qa/loop in the worktree.
  `drivers/claude-code.ts:59-62` decides resumability (same driver, byte-equal
  cwd) — so qa is the phase that reliably resumes.
- **Config seam** (node 02). `src/lib/settings.ts` run schema (`:510` region,
  interface `:163`) → `src/lib/cli-flags.ts` / `bin/cli.ts` (one `.option()`
  per line; `run` options around `:291`) → `src/commands/run.ts` →
  `src/lib/workflow/config-resolver.ts` `buildExecutionConfig` (`:530`) →
  `src/lib/workflow/phase-executor.ts` env (`:1323-1328`, `SEQUANT_FULL_QA`).
  `ready-gate.ts:760` is ExecutionConfig producer #2 (#833) — read-only here.
  MCP: `src/mcp/tools/run.ts` zod schema `:505-530`, tool description `:536`.
- **Trust seam** (nodes 03–07). `templates/hooks/pre-tool.sh` (16 distinct
  `HOOK_BLOCKED` guards), `templates/skills/qa/SKILL.md` §6f (`:2378`) +
  `references/fixtures/injection-issue-body.md`, gate test
  `src/lib/__tests__/trust-model-skill.test.ts`, eval case
  `evals/qa-trust-boundary/` (graders `exfil-absent`, `trust-boundary-status`,
  `skill-fired`, `qa-gaps-marker`; results in `evals/results/`),
  `.github/workflows/plugin-eval.yml` (manual dispatch, API-key secret). All
  read-only for node 03; node 04 adds cases beside the existing one.

## §5 Invariants (binding on every agent in this graph)

- **I-1 stop-at-PR.** No agent runs `gh pr merge`. Every PR waits for the owner.
- **I-2 ownership.** sequant never rewrites a tracked file whose content differs
  from what sequant last generated unless `--force`; every such decision is
  visible in `--dry-run` before any write. Node 01 establishes it for
  `AGENTS.md` and `scripts/dev/`; it binds all later template work.
- **I-3 driver contract.** `canResume` is the driver's ability; orchestration
  policy is expressed at the dispatch site, never by editing the driver.
- **I-4 three copies.** Hooks and skills exist in three mirrored dirs; no node
  in this wave edits them. A diff there fails QA on scope.
- **I-5 honest trust copy.** Architecture claims only; never immunity claims.
  Every defense names its enforcer (path + anchor) or is listed under residual
  risk. Counts (guards, vectors) are computed from source, not typed.
- **I-6 gate tests.** Scoped to the delimited region they assert; each carries a
  `Mutation-verified:` record in the PR body (CLAUDE.md).
- **I-7 verify verbatim.** Every AC ships with its command and expected
  observable; QA runs it as written and does not reason an AC done.
- **I-8 runner discipline.** Never background `sequant run` (#856). Commit a WIP
  every ~10 minutes in exec (the MCP path kills a 30-minute no-progress phase).
  `run.timeout` ≥ 3600 for nodes 03 and 04. Real filesystem for the symlink
  tests; real `buildExecutionConfig` for the wiring tests — mocks are for
  failure injection only.

## §6 Per-node design

| Node | Inputs | Outputs | Failure modes | Done |
|---|---|---|---|---|
| 01 `#990` (absorbs #991) | templates dir; project tree; existing `AGENTS.md` / `scripts/dev` | marker header on generated `AGENTS.md`; preserve/regenerate decision; symlink target preferring `node_modules/sequant`, else copy with one-line reason; `--dry-run` + `doctor` visibility | legacy `AGENTS.md` without marker → treated user-owned (hint once); Windows → copy path unchanged; no local `node_modules/sequant` → copy | I-2 holds for both file classes |
| 02 `#982` | `settings.run.fullQa`, `--full-qa`, MCP `fullQa` | qa dispatched without a resume handle (first and re-QA alike); `SEQUANT_FULL_QA=1` when opted in from any of the three entry points | ready-gate regression (AC-5 guards it); silent no-op flag (AC-3 traces bin → env) | qa never resumes; `fullQa` reachable from CLI, settings, MCP |
| 03 `#980` P0 | hooks, skills, CI files as the source of truth | `SECURITY.md`; `docs/THREAT-MODEL.md` (surfaces, defenses table with deterministic/model-dependent class, residual risks, OWASP Agentic Top 10 table); README link line; gate test resolving every citation | a defense without a resolvable enforcer → must move to residual risk; typed counts drift from source (AC-4 recomputes) | every row resolves; tests mutation-verified |
| 04 `#980` P1a | `evals/qa-trust-boundary/` (existing) | two new cases (PR-comment, tool-output vectors) with the same deterministic grader shape; per-vector record `{vector, decision, reason_code, fixture_commit}`; one recorded run per case | rebuilding the harness (D11 forbids); a vector whose only tool surface can't be graded deterministically → documented as not-gradeable, not faked | three vectors graded deterministically with records |
| 05 `#980` P1b | — | OpenSSF Scorecard workflow (pinned action) + README badge; initial score + top-3 remediations as an issue comment | badge URL not resolving until first run | workflow green, badge renders, comment posted |
| 06 GATE | `docs/THREAT-MODEL.md`, `SECURITY.md`, README diff (from 03) | three decisions: trusted publishing (AC-6), exact standards phrase (AC-7), landing ride-along | — | decisions recorded on the gate issue |
| 07 `#980` P2 | gate 06 decisions | provenance via trusted publishing **or** the decision paragraph; README + marketplace "Security model" section; banned-phrase gate | wording drifts into an immunity claim (gate test) | AC-6/AC-7 closed per 06 |
| 08 GATE | a downstream project with a hand-maintained `AGENTS.md` and sibling-checkout symlinks; one `sequant run --full-qa` | field evidence for I-2 (`sync --dry-run`, `sync`, `doctor` transcripts); qa-start context and `metrics.costUSD` for the post-#982 baseline, recorded on #944 | I-2 fails in the field → node 01 reopens; qa resumed → node 02 reopens | #944 unblocked with a recorded baseline |

## §7 Decisions log

| # | Decision | Evidence | Rejected alternatives |
|---|---|---|---|
| D1 | #990 and #991 are one node/one PR (node 01); #991 closes into #990. | Both edit `templates.ts`; both are "sync writes something the downstream user did not ask for" from the same incident. | Two parallel nodes (`templates.ts` collision); two sequenced PRs (two review cycles for one contract). |
| D2 | Generated-vs-owned detection is an in-file marker: first line `<!-- sequant:agents-md v=<pkg> h=<sha1 of the body> -->`. No marker, or body hash ≠ `h=` → user-owned → preserved. Consequence: every pre-existing `AGENTS.md` (none carry a marker today) is treated as user-owned until `sync --force` once; documented in the changelog (node 01 AC-8). | `Manifest.files` is never populated (Lab §1); the marker is self-describing and survives a missing manifest. | Populate the manifest (a template-wide feature → §10); diff against every prior rendered version (impossible without every historical template). |
| D3 | Symlink policy: prefer `<project>/node_modules/sequant/templates/scripts` when present; otherwise, if the resolved templates dir is under a `/_npx/` segment or outside the project tree, copy and print one line naming `--no-symlinks`. | The four-row table in #991; only the local-dependency target survives `git clone && npm install`. | Always copy (loses #107's auto-update for the recommended install); gitignore `scripts/dev` (changes fresh-clone contents → OQ-1). |
| D4 | QA-resume drop is orchestration policy at the dispatch site; `canResume` untouched. | #982's design; I-3. | Special-casing qa inside the driver (couples policy to one driver). |
| D5 | #980 is split: P0 (AC-1..3) is node 03 and stays on #980; AC-4 → node 04; AC-5 → node 05; AC-6/7 → gate 06 then node 07. | Seven ACs across docs + CI + release with three embedded human decisions; the issue's own scope note names this split. | One node (hides subjective ACs and a release-flow change inside an autonomous run). |
| D6 | `doctor` respects ownership: a user-owned `AGENTS.md` is reported as preserved and never told to `sync --force`. | `doctor.ts:320-360` today recommends the destructive command (Lab §1). | Leave `doctor` alone (it would advise the exact command node 01 exists to make safe). |
| D7 | Merge consent: stop-at-PR for every node. | graph-2026-09 D10; project rule. | Standing consent (not granted). |
| D8 | Tiers: 01, 02, 05, 07 mechanical (current `run.phases`); 03, 04 judgment (all-strong for the node, restore after); 06, 08 human. | 03 makes public security claims whose classification must be right; 04 designs graders. | Everything mechanical (a wrong "deterministic" label is a public misstatement). |
| D9 | #944 gets `Blocked by: <gate 08>` and is not re-planned here. | #982 moves the QA cost baseline; #944's 09-06 reframe wants cost-per-converged-issue. | Run #944 in this wave (collides with 02 on `types.ts`/`ready-gate.ts`; measures a moving baseline). |
| D10 | Excluded: #929 (reserved #997 dogfood sample), #941 (`settings.ts`/`sync.ts`/`qa/SKILL.md` collisions), #919 (`batch-executor.ts` collision; race tests need their own slot). | Lab §1. | — |
| D11 | Node 04 extends `evals/qa-trust-boundary/` (plugin-eval cases with deterministic graders) rather than writing a new script; the issue-body vector counts as done by #987. #980 AC-4 is corrected on the parent to say so. | Lab §1: `exfil-absent` + `trust-boundary-status` graders, recorded run, `fixture_commit` gate already exist. | A standalone script (duplicates the harness, two sources of truth for "never acted on"). |
| D12 | Wave 1 = nodes 01, 02, 03 launched in parallel; 04/05 follow 03; 07 follows 06; 08 follows 01+02. | Scopes in §8 are pairwise disjoint for 01/02/03 except one-line merge points. | A four-node wave with #919 (shares `batch-executor.ts`). |
| D13 | Gate 08's downstream is `sequant-io/sequant-landing`; its committed npx-cache symlink target is node 01's verbatim `_npx` fixture (AC-5). A hand-maintained pointer-style `AGENTS.md` is committed to landing before the gate so both file classes are exercised on one real tree. | Landing's `scripts/dev/new-feature.sh` → `../../../../.npm/_npx/38ae72183b73fa32/node_modules/sequant/templates/scripts/new-feature.sh`, tracked, manifest `files: {}` (OQ-7). | This repo (no `AGENTS.md`; `scripts/dev` gitignored and in-tree — exercises neither class); a synthetic testbed (loses the real-tree evidence; feedback: synthetic fixtures hide false negatives). |

## §8 Issue conventions

Inherited from graph-2026-09 §8 (metadata line, `Blocked by:` line-anchored,
`AC-n — Verify:` form, one-sentence Done-when, may-touch scopes, single-line
`git commit`), plus:

- Label: `graph-2026-09-w2` on every node, including the gates.
- Metadata line: `**Epic:** W2   **Blocked by:** …   **Tier:** …   **Doc:** W2 PLAN §…`.
- Shared merge-point files and their rules:
  - `bin/cli.ts`: 01 adds one `.option()` line on `sync`; 02 adds one on
    `run`. Independent lines; add, never restructure.
  - `README.md`: 01 edits sync-section lines only; 02 adds one row to the
    `run` flags and one settings-key line; 03 adds one link line only; 05 adds
    the badge line; 07 adds the "Security model" section. 03 → 05 → 07
    serialize.
  - `CHANGELOG.md` `[Unreleased]`: one bullet per node, append-only.
  - `src/lib/templates.ts`, `sync.ts`, `init.ts`, `doctor.ts`, `agents-md.ts`:
    node 01 only. `batch-executor.ts`, `config-resolver.ts`, `settings.ts`,
    `cli-flags.ts`, `run.ts`, `mcp/tools/run.ts`: node 02 only.
    `ready-gate.ts`, `drivers/*`: nobody (regression tests only).
  - `evals/`: node 04 only. `.github/workflows/`: node 05 only.
- Tiering is applied by the runner via `.sequant/settings.json` `run.phases`
  (D8). Restore the mechanical policy after a judgment node.
- Merge consent: stop-at-PR (D7).
- Parent issue handling: #980 keeps node 03's slice and gets its AC-4 text
  corrected (D11); nodes 04, 05, 07 and gates 06, 08 are new issues; #991 is
  closed with a pointer to #990; #944 gets its `Blocked by:` line.
- Evidence: `docs/investigations/*.md` for anything measured; gate 08's
  transcripts go to `docs/investigations/wave2-field-verification.md`.

## §9 Open-questions register

| # | Question | Resolved by | Options |
|---|---|---|---|
| OQ-1 | Should `init` add `scripts/dev/` to `.gitignore`? Changes what a fresh clone gets; #991 deferred it. | owner, after gate 08's field read | keep tracked (copies/links visible in review); gitignore (no churn, but a clone must run `sequant sync`) |
| OQ-2 | Does the post-loop re-QA go back through the `batch-executor.ts:1638` phase loop or a separate dispatch? Node 02 AC-1 must cover both. | node 02 spec — Verify: `grep -n "executePhaseWithRetry(" src/lib/workflow/batch-executor.ts` and name every site that can dispatch `qa` | — |
| OQ-3 | Flip `run.fullQa` default-on? | after gate 08 (one dogfooded batch) | stay opt-in; flip with a changelog note |
| OQ-4 | Trusted publishing with provenance, or keep the interactive 2FA publish and record the decision? | gate 06 | migrate (`/release` skill change); keep + decision paragraph in the threat model |
| OQ-5 | Exact public phrase for standards alignment ("mapped to OWASP Top 10 for Agentic Applications (2026)" is the candidate). | gate 06 | — |
| OQ-6 | Does node 04's third vector (tool-output injection) have a deterministic tool surface to grade, given prose-format cases grant a fixed tool set? | node 04 spec | grade a `Write`/`Bash` call carrying the payload; if none is reachable, document the vector as structurally unreachable rather than fake a grader |
| OQ-7 | ~~Which downstream project supplies gate 08's real-world sample (needs a hand-maintained `AGENTS.md` and sibling-checkout symlinks)? Human dependency.~~ **Resolved 2026-09-09 (D13): `sequant-io/sequant-landing`.** Its committed `scripts/dev/*.sh` links target `../../../../.npm/_npx/38ae72183b73fa32/node_modules/sequant/templates/scripts/…` (the npx-cache row, observed via the GitHub contents API); manifest 2.13.0, `files: {}`. It has no `AGENTS.md` — a hand-maintained pointer-style one is committed there before gate 08 (node 08 prerequisite). This repo was rejected: no `AGENTS.md`, and `scripts/dev` is gitignored and points inside the tree (the shape D3 leaves alone). | resolved | — |
| OQ-8 | The exact ten category names of the OWASP Top 10 for Agentic Applications (2026) were not fetched this session. | node 03 spec — pin the list from the OWASP source, cite its URL in the doc; the AC-3 test asserts 10 rows | — |
| OQ-9 | Where does the marketplace README copy originate (`scripts/prepare-marketplace.ts` copies a tree; the README source for `dist/marketplace/external_plugins/sequant/README.md` was not traced)? | node 07 spec | — |

## §10 Parked

- Populating `Manifest.files` so `sync` can detect drift for every template
  file (would generalize I-2 beyond the two classes fixed here).
- `run.fullQa` default-on (OQ-3).
- gitignoring `scripts/dev/` (OQ-1).
- A `sequant doctor` check that recomputes the threat model's counts against
  the installed hooks (would extend node 03 AC-4 from CI to downstream).
