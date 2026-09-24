# Phase 0 lab notes — guard-2026-09 (2026-09-20)

Host: the planning machine, `origin/main` `e73d0c67`. Budget: under 60 min,
$0. Everything below ran at $0.

## §1 `main` ruleset

`gh api repos/{owner}/{repo}/rulesets` → one ruleset, `CC` (id 12393605),
`enforcement: active`, rules `deletion`, `non_fast_forward`.
`conditions.ref_name` is `{include: [], exclude: []}` — **the ruleset targets
no ref.** `gh api repos/{owner}/{repo}/branches/main/protection` → 404
"Branch not protected". So the 09-18 note ("enforces only deletion +
non_fast_forward") overstates it: nothing is enforced on `main` today. #1093's
payload must set `include: ["~DEFAULT_BRANCH"]` as well as adding
`required_status_checks`.

## §2 #1086 reproduction

Clean shell (no `SEQUANT_*` in `env`), single test:

| Env | `relay-hook.integration.test.ts -t "SEQUANT_RELAY is unset"` |
|---|---|
| `SEQUANT_RELAY=true` | 1 failed |
| `SEQUANT_ORCHESTRATOR=true` | 1 passed |
| `SEQUANT_WORKTREE=true` | 1 passed |
| unset | 1 passed |

Same null result as 09-18 for the two single-var repros in the issue body;
`SEQUANT_RELAY` reproduces on its own. The fix scrubs by prefix, so the null
result changes nothing about the fix, only the AC-1 command (OQ-1).

## §3 Hook corpus sources

`.sequant/logs/` had 94 entries (93 `run-*.json`, one `relay/`); copied to
the scratchpad before counting. Phase records carry
`commitHash, durationSeconds, error, errorContext, fileDiffStats,
filesModified, status, summary, verdict` — **no command strings, zero `Bash`
mentions across all 93 files.** #1094's stated source is empty.

Real sources on this host:

| Source | Count |
|---|---|
| `~/.claude/projects/<project-slug>/*.jsonl` (81 files, 114 MB) Bash `tool_use` blocks | 5,601 total, 5,519 distinct, 2,707 under 300 chars, 700 with a heredoc |
| `~/.sequant/logs/claude-hook.log` `BLOCKED [rule] <redacted>` lines | 603 of 889 (force-push 218, staged-secret 126, sensitive-file 126, worktree-boundary 94, env-dump 17, commit-format 12) |
| `__tests__/pre-tool-hook.integration.test.ts` `runHook(` call sites | 114 |

AC-1's 150 threshold holds comfortably. The hook log already redacts; the
transcript harvest needs its own redaction (AC-4 covers it). Both sources
are machine-local → the harvest is a maintainer step, the committed corpus
is the artifact (D-11, OQ-4).

## §4 fast-check and vitest

`grep -c fast-check package.json` → 0. `origin/main` `package.json` pins
`"vitest": "^4.1.11"`. PR #1082 (vitest 4.1.11 → 5.0.0) is OPEN and stays
open (I-8, D-7). `codex` and `opencode` are both on `PATH` here.

## §5 Full-suite wall time

Run from a shell with every `SEQUANT_*` var unset, `npm test`, `origin/main`
tree, 322 files / 6,549 tests green, exit 0.

| Measure | Value |
|---|---|
| wall, `npm test` end to end incl. build | 433 s |
| vitest duration | 432 s |

#1098 AC-6's 6-minute budget is for the canary job alone (one integration file plus a previous-minor install), not this suite. #1093's required-check latency is this suite on the ubuntu runner (OQ-2).

## §6 Ownership policy and routes as landed

Recorded in PLAN §4 from `git show origin/main:src/lib/templates.ts`
(`OWNERSHIP_RULES`, `TEMPLATE_ROUTES`, `ownershipPolicy()` default
`sequant-owned`). The main checkout was not read.

## §7 Repairs / host state

None. `.sequant/logs` was copied, not moved. No files outside
`docs/internal/graph-2026-09-guard/` were written during Phase 0.
