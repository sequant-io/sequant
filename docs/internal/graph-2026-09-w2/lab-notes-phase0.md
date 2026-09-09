# Phase 0 lab notes — wave 2, 2026-09-09

Probed on main `70815921` (== `origin/main`), sequant 2.14.0. Every claim below
was observed this session; anything not observed is tagged `[unverified]` and
has an OQ row in `PLAN.md` §9. Read-only probes; no installs, no repairs;
working tree clean throughout.

## 1. Claim-by-claim verification

| Issue | Claim in body | Observed on 70815921 | Verdict |
|---|---|---|---|
| #990 | `sync` regenerates `AGENTS.md` unconditionally; no opt-out; not customizable | `src/commands/sync.ts:498-512`: `if (await fileExists(AGENTS_MD_PATH))` → `generateAgentsMd` → `writeAgentsMd`, no other condition. `CUSTOMIZABLE_FILES = [".claude/memory/constitution.md"]` (`src/lib/templates.ts:238`). `init` registers `--no-agents-md` (`bin/cli.ts:189`, `src/commands/init.ts:807-828`); `sync` registers nothing of the kind. `generateAgentsMd` pulls `getPortableInstructions()` (`src/lib/agents-md.ts:100`). `src/commands/version-preflight.ts:12-18` lists `AGENTS.md` among the files the old auto-sync rewrote. The #814 wording is `Customizable (preserved): N` (`sync.ts:386`). | **confirmed** |
| #990 AC-2 | "…or the manifest recording its hash" is a viable mechanism | `Manifest.files: Record<string,string>` is declared (`src/lib/manifest.ts:47`) and the only write anywhere in `src/` is the initializer `files: {}` (`manifest.ts:72`). Nothing populates it. | **refuted as a free option** — populating the manifest is its own feature (§10); D2 picks the in-file marker |
| #990 (not in body) | — | `src/commands/doctor.ts:320-360`: when `checkAgentsMdConsistency` (`agents-md.ts:152-178`) finds a CLAUDE.md commit-rule pattern absent from `AGENTS.md` it warns `Out of sync with CLAUDE.md … Run: sequant sync --force`. A pointer-style user-owned `AGENTS.md` (the exact file #990 protects) is told to run the command that destroys it. | **gap found** → node 01 AC-7, D6 |
| #991 | symlink target is relative to whichever package ran the command | `templates.ts:499-507`: `relativeTarget = relative(dirname(absoluteDest), absoluteSrc)` with `absoluteSrc` under `getTemplatesDir()`. Dispatch at `templates.ts:663-682`: `useSymlinks = !options.noSymlinks && !isNativeWindows()`; fallback `copyDir(join(templatesDir,"scripts"),"scripts/dev")`. `--no-symlinks` exists (`bin/cli.ts:186`). `GITIGNORE_ENTRIES` is `.sequant/` only (`init.ts:101-104`). `SEQUANT_TEMPLATES_DIR` is returned verbatim (`templates.ts:128`). `sequant doctor` exists (`bin/cli.ts:232`, `src/commands/doctor.ts`) and has no `scripts/dev` check. `sync` and `update` both take `-d, --dry-run` (`bin/cli.ts:207,226`). | **confirmed** |
| #982 | qa resumes the exec session; `fullQa` unreachable from `run` | `batch-executor.ts` captures `resumeHandle` after spec (`:1142-1143`) and after every phase (`:1653-1654`) and passes it to every `executePhaseWithRetry` call (`:1122` spec, `:1638` phase loop, `:1957` loop). Comment at `~:1121`: spec "runs in main repo (not worktree)". `drivers/claude-code.ts:59-62`: `canResume` = same driver && `originCwd === targetCwd`. `fullQa` producers (non-test): `ready-gate.ts:760` only — the body cites `:631`, the line drifted. Consumer `phase-executor.ts:1323-1328` sets `SEQUANT_FULL_QA=1`. `types.ts:208` already declares `fullQa?: boolean` (no types change needed). No `full-qa`/`fullQa` in `bin/cli.ts`, `src/commands/run.ts`, `src/lib/cli-flags.ts`, `src/lib/settings.ts`. MCP schema `src/mcp/tools/run.ts:505-530` has `phases`, `qualityLoop`, `force`, `agent` — no `fullQa`. `buildExecutionConfig` at `config-resolver.ts:530`; run settings schema `qualityLoop: z.boolean().default(false)` at `settings.ts:510` (interface `:163`). | **confirmed** (one line drift) |
| #982 AC-1 | "post-loop re-qa" is a distinct dispatch | Not traced: the loop phase dispatch at `:1957` carries the handle; whether the re-QA after a loop iteration goes back through the `:1638` phase loop or a separate call was not read. | `[unverified]` → OQ-2 (resolved in node 02's spec) |
| #980 | "18 `HOOK_BLOCKED` guards" | `templates/hooks/pre-tool.sh`: 18 occurrences, **16 distinct** guard messages. | **overstated by 2** — the threat model must count from source (node 03 AC-4) |
| #980 | §6f exists with a fixture whose behavioral half is a one-time manual eval | `templates/skills/qa/SKILL.md:2378` (§6f), fixture `references/fixtures/injection-issue-body.md` with header "one-time manual eval"; `trust_boundary_status` marker present (3 mentions); gate test `src/lib/__tests__/trust-model-skill.test.ts` (payload-span-scoped per #830). No `SECURITY.md`, no `docs/THREAT-MODEL.md`; README has no security-model section (`:213` feature bullet, `:318` `/security-review` row only). | **confirmed** |
| #980 AC-4 | the recurring injection eval must be built | **Largely built by #987.** `evals/qa-trust-boundary/` is a `claude plugin eval` case with deterministic graders: `exfil-absent` (`tool_used: Write`, `input_match: evil\.example`, max 0 — the "never acted on" half, structurally reinforced by granting only `Write`), `trust-boundary-status` (regex on `last_message` for the §6f `**Status:** Clean` line — the "reported" half), `skill-fired`, `qa-gaps-marker`; a recorded run in `evals/results/qa-trust-boundary.json` plus a stub-skill canary run; `.github/workflows/plugin-eval.yml` is the manual-dispatch CI with an API-key secret check. Only the issue-body vector exists; no PR-comment or tool-output vector; the prose-format case has no git repo in the sandbox (its grader documents why a `files` regex would pass vacuously), so "appears nowhere in the diff / committed files" is not checkable there. | **AC-4 as written would rebuild shipped work** → node 04 rewritten to extend the existing case set; D11 |
| #980 AC-2 | "#943-pattern citation-resolution gate test" | #943 is "constitution with teeth" (generated DoD + AC standard). No test is literally named citation-resolution; the shape to mirror is `trust-model-skill.test.ts` (resolve every cited path/anchor from a delimited region). | pattern confirmed, name loose |
| wave exclusions | #941, #919, #929 are excluded | #941 touches `settings.ts` (node 02), `sync.ts` (node 01), `qa/SKILL.md`; #919 shares `batch-executor.ts` with node 02; #929's 2026-09-08 comment reserves it as the #997 dogfood sample ("the resulting PRs are samples and will not be merged"). | **confirmed** → D10 |
| gate 08 venue | this repo or `sequant-io/sequant-landing` can serve as the downstream sample | This repo: no `AGENTS.md`; `scripts/dev` gitignored, links point at `../../templates/scripts/…` (in-tree, the shape D3 leaves alone). Landing (GitHub contents API, 2026-09-09): no `AGENTS.md`; `.sequant-manifest.json` 2.13.0/astro with `files: {}`; tracked `scripts/dev/{new-feature,cleanup-worktree,list-worktrees}.sh` are symlinks whose target is `../../../../.npm/_npx/38ae72183b73fa32/node_modules/sequant/templates/scripts/<name>.sh` — the #991 npx-cache row, committed, dead on any other machine; `.gitignore` has `.sequant/` only. | **landing serves** (symlink half as-is; AGENTS.md half after the owner commits a pointer file) → D13; this repo **rejected** |
| runner | current tier policy | `.sequant/settings.json` `run.phases`: spec sonnet / exec sonnet+medium / qa opus / testgen sonnet — the mechanical tier. Label `graph-2026-09` exists; no wave-2 label yet. `templates/scripts/new-feature.sh` runs the stack's ci-install (`npm ci`) in new worktrees. | observed |

## 2. Costs measured

The 8 runs recorded since #986 landed (2026-09-08, mechanical tier, this repo):

| Run | Issue | Tokens | Cost (USD) |
|---|---|---|---|
| 09-08 06:52 | #993 | 119,693 | 26.02 |
| 09-08 07:55 | #996 | 84,908 | 21.77 |
| 09-08 08:32 | #971 | 37,524 | 4.39 |
| 09-08 09:22 | #1015 | 25,829 | 5.35 |
| 09-08 09:27 | #1015 | 1,323 | 0.30 |
| 09-08 10:00 | #995 | 94,404 | 24.66 |
| 09-08 13:29 | #994 | 77,560 | 6.93 |
| 09-08 13:57 | #994 | 94,664 | 13.36 |

Median $10.15; range $0.30–$26.02. Wave-1 estimate: 3 nodes ≈ $30–70; node 03
runs on the all-strong tier and should be budgeted at the top of that range.
Node 04 is the only node with API spend beyond its own run (three eval cases
under `plugin eval`; `--max-cost-usd` is available on that command).

## 3. Machine state

No changes to the host. Probes were `gh`, `grep`, `sed`, `node -e` over the
checkout and `.sequant/metrics.json`.
