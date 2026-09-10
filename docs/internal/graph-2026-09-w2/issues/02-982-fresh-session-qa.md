# 02 — #982 feat(run): fresh-session QA — never resume the exec session into qa; expose `run.fullQa` (setting + `--full-qa` + MCP param)

**Epic:** W2   **Blocked by:** —   **Tier:** mechanical   **Doc:** W2 PLAN §4 (phase dispatch + config seams), §5 I-3, §7 D4/D9, §9 OQ-2/OQ-3, Lab §1

## Why
`batch-executor.ts` captures the resume handle after spec (`:1142`) and after
every phase (`:1653`) and offers it to every dispatch (`:1122`, `:1638`,
`:1957`). Spec runs in the main checkout, exec/qa/loop in the worktree, and
`drivers/claude-code.ts:59-62` resumes only on a byte-equal cwd — so qa is the
phase that reliably resumes, starting anchored to ~142k tokens of the author's
transcript (median, n=44). The fresh-session study found fresh QA catches a
would-ship bug 44% of the time; the cost measurement in #982 says dropping the
resume is roughly cost-neutral. Full-weight QA (`config.fullQa` →
`SEQUANT_FULL_QA=1`, consumer `phase-executor.ts:1323-1328`) has exactly one
producer, `ready-gate.ts:760`; no `run` flag, setting or MCP param exists.

## Scope
- may touch: `src/lib/workflow/batch-executor.ts` (qa dispatch sites only),
  `src/lib/workflow/config-resolver.ts` (`buildExecutionConfig`),
  `src/lib/settings.ts` (one `run.fullQa` key, one schema line),
  `src/lib/cli-flags.ts`, `bin/cli.ts` (one `.option()` line on `run`),
  `src/commands/run.ts`, `src/mcp/tools/run.ts` (one zod param + description
  note), `README.md` (one `run` flags row, one settings-key line),
  `CHANGELOG.md` (one bullet); tests: `src/lib/workflow/batch-executor.test.ts`,
  new `src/lib/workflow/full-qa.test.ts`, `src/mcp/tools/run.test.ts`,
  `src/lib/workflow/ready-gate.test.ts` (added case only).
- not in scope: `drivers/*` (I-3), `ready-gate.ts` (regression test only),
  `types.ts` (`fullQa?: boolean` already exists at `:208`), exec/loop resume,
  any default flip of `fullQa`, skills.
- real `buildExecutionConfig` in the wiring test — no mocking of
  `config-resolver` (I-8).

## Acceptance criteria
- [ ] AC-1: every dispatch of the `qa` phase in `batch-executor.ts` passes no resume handle — the first qa and any re-QA after a loop iteration alike — while exec keeps receiving it — Verify: `npx vitest run src/lib/workflow/batch-executor.test.ts -t "982"` → the injected `executePhaseFn` sees `resumeHandle` defined for exec and `undefined` for every qa call across a `spec,exec,qa` run with one quality-loop retry. Mutation: pass the handle for qa → fails; restore. (OQ-2: the spec names every site that can dispatch qa — Verify: `grep -n "executePhaseWithRetry(" src/lib/workflow/batch-executor.ts` listed in the PR body.)
- [ ] AC-2: `run.fullQa: true` in `.sequant/settings.json` produces `SEQUANT_FULL_QA=1` in the qa phase agent env via `sequant run`, wired through `buildExecutionConfig` — Verify: `npx vitest run src/lib/workflow/full-qa.test.ts -t "AC-2"` → settings → `buildExecutionConfig` → phase-executor env assertion, no mocks on the resolver.
- [ ] AC-3: `sequant run <n> --full-qa` and the MCP `sequant_run` `fullQa` param each set `config.fullQa`; the CLI flag is registered in `bin/cli.ts`; the MCP description names the minimum server version that honors the param — Verify: `node dist/bin/cli.js run --help | grep -c -- '--full-qa'` → `1`; `npx vitest run src/mcp/tools/run.test.ts -t "fullQa"` → param accepted and forwarded; `grep -c "fullQa" src/lib/cli-flags.ts` ≥ 1.
- [ ] AC-4: with `run.fullQa` unset and no flag, behavior is identical to today except the qa resume drop — Verify: `npm run build && npm test` → pass; `grep -n "fullQa" src/lib/settings.ts` → the schema line has no `default(true)`.
- [ ] AC-5: `ready-gate.ts` still forces `fullQa: true` regardless of the new setting — Verify: `npx vitest run src/lib/workflow/ready-gate.test.ts -t "fullQa"` → the existing case plus one with `run.fullQa: false` both see `fullQa: true` on every qa dispatch.
- [ ] AC-6: `canResume` and the drivers are untouched — Verify: `git diff origin/main --stat -- src/lib/workflow/drivers/ | wc -l` → `0`.
- [ ] AC-7: documented — README gains one `--full-qa` row and one `run.fullQa` line; `CHANGELOG.md` `[Unreleased]` gains one bullet naming the qa-resume change — Verify: `grep -c "full-qa\|fullQa" README.md` ≥ 2; `grep -c "resume" CHANGELOG.md` ≥ 1.

## Done when
The qa phase never starts from the implementer's session, and full-weight QA
is reachable from the CLI flag, the settings key and the MCP param without
changing `ready-gate` or any driver.
