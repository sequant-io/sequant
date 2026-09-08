# 15 — #862-P1 feat: opencode fidelity — hook shim (fail closed), subagent defs, MCP translation, error classes, CI smoke

**Epic:** M3   **Blocked by:** #862-P0 (node 12)   **Tier:** judgment (run with `--security-review`: the shim is the only security-adjacent surface)   **Doc:** PLAN §4, §5 I-3/I-8, §7 D2

## Why
Without the shim, opencode phases run with no force-push/commit/secret guards.
Without subagent defs, `exec`/`qa` fan-out degrades silently. Both must be
observable, not assumed.

## Scope
- may touch: `templates/opencode/plugins/sequant-hooks.ts` (new, generated into `.opencode/plugins/` by `init`), `templates/opencode/agents/*.md` (four defs translated from `.claude/agents/`), `src/commands/init.ts`, `src/commands/doctor.ts` (plugin-active check), `src/commands/serve.ts` or the MCP config writer (opencode `mcp` key translation), `src/lib/workflow/drivers/opencode.ts` (error classification only), `.github/workflows/*.yml` (one smoke job), tests beside each
- not in scope: rewriting `pre-tool.sh`; forking skills; warm start; docs (node 16 accept path).

## Acceptance criteria
- [ ] AC-1: shim maps opencode `{tool, args}` → the hook's stdin JSON and blocks on exit 2 — Verify: `npx vitest run src/lib/workflow/drivers/opencode-hooks.test.ts -t "862 P1 shim"` → a force-push args object thrown by the shim (blocked); a conventional commit passes; a **malformed args object is blocked** (fail closed), asserted by a case with a missing `command` field.
- [ ] AC-2: doctor verifies the plugin is active — Verify: `npx vitest run src/commands/doctor.test.ts -t "opencode plugin"` → fails with guidance when `.opencode/plugins/sequant-hooks.ts` is absent or `--pure` is configured.
- [ ] AC-3: subagent defs translated — Verify: `sequant init --agent opencode` writes `.opencode/agents/{sequant-implementer,sequant-qa-checker,sequant-testgen,sequant-explorer}.md` with `mode: subagent`, `steps` from `maxTurns`, `permission` from `tools` (`grep -c 'mode: subagent' .opencode/agents/*.md` → 4); fan-out either verified in the node 16 dogfood table or the driver-conditional sequential fallback is documented in the driver's doc comment.
- [ ] AC-4: MCP translation — Verify: `npx vitest run src/commands/serve.test.ts -t "opencode mcp"` → the generated config uses opencode's flat `mcp` key with `type: local` and `command` as an array.
- [ ] AC-5: error classification — Verify: `npx vitest run src/lib/workflow/drivers/opencode.test.ts -t "862 P1 errors"` → NDJSON `error` events map to a distinct `PhaseResult.error` class; a spy asserts the Claude-specific MCP-fallback and SDK rate-limit retry paths are never entered for the opencode driver.
- [ ] AC-6: CI smoke against the pinned version — Verify: `grep -c '1.18.27' .github/workflows/*.yml` ≥ 1 and the job runs `opencode run --format json` on a trivial prompt with `--max-cost` equivalent budget or a free/local model, and one green run URL is in the PR body.

## Done when
An opencode phase is guarded by the same bash hooks as a Claude Code phase, fails closed on any schema mismatch, and the repo's CI would notice an upstream opencode break before a user does.
