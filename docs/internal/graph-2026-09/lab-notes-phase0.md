# Phase 0 lab notes — backlog graph, 2026-09-06

Probed on main `c3c1b0a8` (== `origin/main`), sequant 2.13.0, Claude Code 2.1.263,
opencode 1.18.27, Node via fnm. Every claim below is something observed this
session; anything not observed is tagged `[unverified]` and has an OQ row in
`PLAN.md` §9.

## 1. Claim-by-claim verification

| Issue | Claim in body | Observed on c3c1b0a8 | Verdict |
|---|---|---|---|
| #981 | first quoted span / any heredoc hijacks `MSG` | Both repros fed to `templates/hooks/pre-tool.sh` as PreToolUse JSON exit 2 with `Got: mirrors byte-identical` and `Got: p = "x"`. Extraction at `templates/hooks/pre-tool.sh:919-931`. All three hook copies md5-identical (`e32afcec…`). | **confirmed** |
| #932 | `?? "npm"` survives in `run.ts` | `src/commands/run.ts:102` still `manifest.packageManager ?? "npm"`; `run-orchestrator.ts:219` types `packageManager: string`; `templates/skills/setup/SKILL.md` has zero `packageManager` mentions. `new-feature.sh:206` detects pnpm correctly. | **confirmed** |
| #935 | signal shutdown force-removes worktrees the failure text promises | `run-orchestrator.ts:1167-1181` registers `git worktree remove --force` for every non-pre-existing worktree, unconditionally; `src/lib/shutdown.ts` hands a `ShutdownReason` (signal name) to every cleanup, so a dirty-check is cheap. `formatUncommittedExecError` lives at `phase-executor.ts:887`. | **confirmed** |
| #935 | `abort` doc comment cites the wrong issue | `bin/cli.ts:507` and `src/commands/abort.ts:3,7` cite #645; #645 is the relay-loss bug and neither its body nor its comments mention abort or "Gap 7". `git log -S'Out-of-band abort'` yields one commit: `af1ce78a` (PR #858, fixing #853). | **confirmed**; the correct citation is discoverable by the verify command in node 09 |
| #986 | `tokensUsed` is 0 on every recorded run | `.sequant/metrics.json`: 124 records, 124 × `tokensUsed: 0`. `.claude/hooks/capture-tokens.sh:38` selects `.usage`. `run-orchestrator.ts:1729` calls `getTokenUsageForRun(undefined, true)`. `drivers/claude-code.ts:265` returns `modelUsage`; `phase-executor.ts:1384` uses only its first key. Ready gate reads via an injected `readTokensUsed(worktreePath)` (`ready-gate.ts:181,528,642,722`) — a third reader, not `getTokenUsageForRun` directly. | **confirmed**, with one correction: the ready-gate reader is a callback, so the "one shared helper" AC must replace the callback default, not a direct call |
| #933 | preflight never sees the worktrees | `run-orchestrator.ts:1097` calls `runSkillsPreflight({...})` with no `cwd`; `skills-preflight.ts:45-46` accepts `cwd`; `skills-check.ts:34` defaults to `process.cwd()`. Worktree cleanup registration (the post-provisioning point) is at `:1167`. | **confirmed** |
| #863 | `RunReadyGateOptions` lacks driver fields; siblings hardcoded | Interface fields enumerated: no `agent`, no `aiderSettings`. `buildPhaseConfig` hardcodes `skipVerification: false` (:376), `noSmartTests: false` (:381), `retry: true` (:385); `phasePolicies`/`effortEscalation` were plumbed by #914/#915 as "producer 2" — the drift class is live and growing one field per feature. | **confirmed** |
| #956 | target file flagged 5/5; corpus "if any exist" | Detector library (`analyzeTestFile`) on the target: **6/6** flagged. Corpus of test files that spawn AND build paths via `__dirname` / `join(REPO_ROOT…)`: **33 files**, of which **20 carry flags** (e.g. `new-feature-frozen-install` 18/24, `state-update-cli` 8/10, `pre-tool-hook` 4/79 = exactly the #966 remainder). Many of the 20 are file-content gate tests, not subprocess tests — they need classification, not a blanket fix. #966's `describe.each` fix is on main. | **confirmed, understated**: AC-3 needs a baseline table, not "if any" |
| #971 | builds on #914/#915/#581 | All three CLOSED; so are #972, #973, #975 (the comment-thread dependencies). `withEscalatedEffort` at `effort-escalation.ts:93` is the single-choke-point pattern to mirror. Stagnation constants live in `qa-stagnation.ts`, `state-schema.ts`, `ready-gate.ts`. `.sequant/settings.json` has no `modelLadder` key. | **inputs ready**; design OQs remain (§9 OQ-4/5) |
| #862 | opencode reads `.claude/skills` natively; `--command` wrappers | `opencode` 1.18.27 on PATH. No driver file exists; `drivers/` holds `aider.ts`, `claude-code.ts`. `docs/investigations/multi-backend-2026-07.md` is on main. Skill invocation via `--command` was **not** exercised by the 09-03→06 field run (memory: transport only). | transport **confirmed**; skill-load contract `[unverified]` → spike node 06 |
| #987 | `plugin eval` gated; `CLAUDE_CODE_WALNUT_SPIRE=1` is the switch | Without the var: `` `plugin eval` is currently in early access ``. **With the var: `claude plugin eval . --case __nonexistent__` reaches case discovery** ("No eval cases found matching …"). `--help` lists `--ablation with-without`, `--scaffold`, `--runs`, `--threshold`, `--max-cost-usd`, `--json`, `--mocks`, `--judge-model` (default haiku), and `plugin eval init --bare`. No `evals/` dir exists; `plugin.json` has no `experimental.evals`. `injection-issue-body.md` exists in all four skill copies (plugin reads `skills/qa/…`). | **P0.1 PASS on this machine** — the kill path collapses; P0.2–P0.6 `[unverified]` |

## 2. Costs measured

| Probe | Wall | $ |
|---|---|---|
| hook repro ×2 | <1 s | 0 |
| detector over 33-file corpus | ~6 s | 0 |
| `claude plugin eval` discovery probe | ~3 s | 0 (no cases) |
| everything else | grep-class | 0 |

No paid run was made. Node 06 (opencode spike) and node 07 (eval Phase 0) are
the graph's first paid probes; both carry a hard budget in their ACs.

## 3. Repo state relevant to the runner

- No branch, worktree, or `.sequant/state.json` entry exists for any of the ten
  issues. Two unrelated worktrees are live (#916, #919) — leave them.
- `package-lock.json` is modified in the main checkout (pre-existing, not ours).
- `.sequant/settings.json` phase policy: spec=sonnet, exec=sonnet/medium,
  qa=opus, testgen=sonnet. `run.agent` unset. This is the "mechanical" tier;
  judgment nodes need the flip.
- No `worktree_setup.sh`; sequant's own provisioning runs the manifest's
  package-manager install. Known trap: fresh worktrees can miss native deps and
  the Node ≥22.13 floor (memory `reference_worktree_env_gaps`).
- Host left clean: only `docs/internal/graph-2026-09/` was added; the scratch
  detector script lives in the session scratchpad.
