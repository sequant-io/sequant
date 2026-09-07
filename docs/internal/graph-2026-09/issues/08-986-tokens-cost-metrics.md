# 08 — #986 fix(metrics): SDK `modelUsage` → per-phase tokens + cost; hook path becomes the fallback

**Epic:** M1   **Blocked by:** #863   **Tier:** judgment   **Doc:** PLAN §2 D-cost, §4, §5 I-1/I-2/I-3/I-4, §7 D6/D14, §9 OQ-1, Lab §1

## Why
124/124 local records carry `tokensUsed: 0`; the jq path is wrong and the
orchestrator reads the wrong directory, while the driver already returns
`modelUsage` with `costUSD`. Every cost-routing decision (#944, node 11) is
unmeasurable until this lands. Correction from Phase 0: the ready gate reads
through an injected `readTokensUsed(worktreePath)` callback, so the "one helper"
replaces that callback's default, not a direct call.

## Scope
- may touch: `src/lib/workflow/metrics-schema.ts` (append-only), `src/lib/workflow/token-utils.ts`, `src/lib/workflow/run-orchestrator.ts` (metrics assembly region ~:1729 only), `src/lib/workflow/phase-executor.ts` (usage normalization beside the #975 `resolvedModel` extraction ~:1381), `src/lib/workflow/drivers/agent-driver.ts` (type the `modelUsage` map), `src/lib/workflow/ready-gate.ts` (default of `readTokensUsed` only), `src/commands/ready.ts`, `src/lib/workflow/batch-executor.ts` (the one `readTokensUsed` wiring), `src/commands/stats.ts`, `templates/hooks/capture-tokens.sh` + `.claude/hooks/capture-tokens.sh` + `hooks/capture-tokens.sh`, tests beside each, fixtures: one recorded real SDK `result` message, one real transcript excerpt, one pre-fix `metrics.json` record
- not in scope: routing decisions; billing reconciliation; `ready` metrics (#929); node 11's escalation columns.

## Acceptance criteria
- [ ] AC-1: aggregate from `modelUsage` — Verify: `npx vitest run src/lib/workflow/phase-executor.test.ts src/lib/workflow/run-orchestrator.phase-policy.test.ts -t "986"` → passes; the test feeds a **recorded real** `result` message fixture with two model entries and asserts `metrics.tokensUsed/inputTokens/outputTokens/cacheTokens/costUSD` equal the sums.
- [ ] AC-1b (real run, runner-verified post-merge, D14): after the first `sequant run` on main that includes this fix — Verify: `jq '[.. | objects | select(has("tokensUsed")) | .tokensUsed] | last' .sequant/metrics.json` → `> 0`, pasted as a comment on #986 by the runner.
- [ ] AC-2: `metrics.phaseUsage[]` rows `{ phase, model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUSD }`, one per phase execution, quality-loop retries as separate rows — Verify: same `-t "986"` run, a case with two `qa` executions asserts two rows.
- [ ] AC-3: hook parses `.message.usage // .usage` — Verify: `bash templates/hooks/capture-tokens.sh` against a fixture transcript with known totals writes matching numbers (test in `src/lib/workflow/token-utils.test.ts -t "986 hook"`); PR body carries `Mutation-verified: AC-3 — reverted jq to .usage; <test> failed; restored.`; `md5 -q templates/hooks/capture-tokens.sh .claude/hooks/capture-tokens.sh hooks/capture-tokens.sh | uniq | wc -l` → `1`.
- [ ] AC-4: one worktree-anchored helper for the fallback — Verify: `grep -c 'getTokenUsageForRun(undefined' src/lib/workflow/run-orchestrator.ts` → `0` (scoped gate test, mutation record in PR body), and `ready-gate.ts`'s default `readTokensUsed` calls the same helper (`grep -n '<helperName>' src/lib/workflow/ready-gate.ts src/lib/workflow/run-orchestrator.ts` → both files).
- [ ] AC-5: `sequant stats` phase × model table with cost, labeled `SDK estimate, not a billing statement`, shown by default (OQ-1) — Verify: `npx vitest run src/commands/stats.test.ts -t "986"` → snapshot passes against a fixture `metrics.json`.
- [ ] AC-6: pre-fix records load and render — Verify: same stats test, a case loading a fixture copied verbatim from today's `.sequant/metrics.json` (no `costUSD`/`phaseUsage`) renders without throwing and shows `0`/`—` for missing fields.
- [ ] AC-7: I-1 — the config surface is untouched, so the node 04 parity test still passes — Verify: `npx vitest run src/lib/workflow/execution-config-parity.test.ts` → passes.

## Done when
`sequant stats` prints non-zero tokens and an SDK-estimate cost per phase × model from the driver's `modelUsage`, with the hook path as a working fallback read from one worktree-anchored helper.
