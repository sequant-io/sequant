# 12 — #862-P0 feat: opencode driver core

**Epic:** M2   **Blocked by:** node 06 (spike verdict GO), #863   **Tier:** judgment   **Doc:** PLAN §4 (opencode seam), §5 I-1/I-3/I-8, §7 D2/D7, §9 OQ-8/OQ-9

## Why
The first backend that reads `.claude/skills/` natively. Built against node 06's
recorded NDJSON fixture and mitigation table, never against the README. The
ready-gate driver plumbing (#862 P0's last AC) is already node 04.

## Scope
- may touch: `src/lib/workflow/drivers/opencode.ts` (new), `src/lib/workflow/drivers/index.ts` (one registry line), `src/lib/settings.ts` (`run.opencode: { model, variant, extraArgs, reasoningMaxTokens }` — the last field per node 06 AC-3), `src/lib/workflow/config-resolver.ts` (pass-through only), `src/commands/init.ts` (+ one template source for `.opencode/commands/<phase>.md`), `src/commands/doctor.ts`, tests beside each, `src/lib/workflow/drivers/opencode.live.integration.test.ts`
- not in scope: hook shim, subagent defs, MCP translation, error classification beyond NDJSON `error` events, CI smoke (node 15); docs (node 16 accept path); `serve`/`--attach`.

## Acceptance criteria
- [ ] AC-1: driver parses the recorded fixture — Verify: `npx vitest run src/lib/workflow/drivers/opencode.test.ts -t "862"` → passes; input is `src/lib/workflow/drivers/__fixtures__/opencode-run-qa.ndjson` from node 06; asserts concatenated `text` → `output`, `error` events → structured failure, `success` only when the skill marker is present (AC-4), abort → SIGTERM on a detached process group, `config.env` forwarded, RingBuffer tails populated.
- [ ] AC-2: live SKIP-when-absent test — Verify: same command with `opencode.live.integration.test.ts`: when `which opencode` succeeds and a provider key is present, spawns `opencode run --format json --auto --dir <tmp>` with a trivial prompt and asserts ≥1 `text` event; otherwise reports `SKIPPED (opencode absent)`, never a pass.
- [ ] AC-3: registry + settings + CLI — Verify: `node dist/bin/cli.js run 1 --agent opencode --dry-run` (after `npm run build`) prints the opencode driver in its plan without spawning; `npx vitest run src/lib/workflow/drivers/index.test.ts -t "862"` asserts `getDriver("opencode")`.
- [ ] AC-4: skill-marker verification — Verify: `-t "862 AC-4"`: a fixture stream with no skill marker yields a distinct `PhaseResult.error` (`skill-not-loaded`), not a parsed verdict.
- [ ] AC-5: command wrappers from one source — Verify: `sequant init --agent opencode` in a temp dir writes `.opencode/commands/<phase>.md` for every phase entrypoint from a single template (`grep -rl 'opencode/commands' src/commands/init.ts templates | wc -l` → the template lives in exactly one place), and `diff <(ls .opencode/commands) <(expected phase list)` is empty.
- [ ] AC-6: resume honors #674 — Verify: `npx vitest run src/lib/workflow/drivers/resume-semantics.test.ts -t "opencode"` → `ResumeHandle{driver:"opencode", token, originCwd}` round-trips and is rejected from a different cwd.
- [ ] AC-7: doctor — Verify: `npx vitest run src/commands/doctor.test.ts -t "opencode"` → with `run.agent: "opencode"` doctor checks the binary and the pinned minimum version (`1.18.27`) and fails with the install hint when absent.
- [ ] AC-8: node 06 mitigations applied — Verify: `-t "862 AC-8"`: the spawn passes `OPENCODE_CONFIG_CONTENT` carrying the reasoning budget, the `/tmp`/`$TMPDIR` allow rule (or scratch relocation) from node 06's table, and `detached: true`.
- [ ] AC-9: I-1 — Verify: `npx vitest run src/lib/workflow/execution-config-parity.test.ts` → passes with the new `opencodeSettings` field asserted equal across producers.

## Done when
`sequant run <n> --agent opencode` dispatches every phase through a driver whose parser was proven on recorded real output, fails distinctly when the skill did not load, and passes doctor and the parity test.
