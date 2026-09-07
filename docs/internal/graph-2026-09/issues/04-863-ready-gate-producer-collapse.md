# 04 — #863 fix(ready-gate): carry the resolved `ExecutionConfig` into the gate; collapse producer 2

**Epic:** M0   **Blocked by:** —   **Tier:** judgment   **Doc:** PLAN §4, §5 I-1, §7 D5, §9 OQ-12, Lab §1

## Why
`RunReadyGateOptions` has no driver fields; `buildPhaseConfig` hardcodes
`skipVerification`, `noSmartTests`, `retry`; #914/#915 each hand-plumbed one more
field as "producer 2". Nodes 08, 11, 12 all add config fields — this node lands
the parity test they extend (I-1). Unblocks #862 P0's last AC and #971 AC-11.

## Scope
- may touch: `src/lib/workflow/ready-gate.ts`, `src/commands/ready.ts`, `src/lib/workflow/batch-executor.ts` (the `runReadyGateForIssue` args struct and its one call site), `src/lib/workflow/config-resolver.ts`, `src/lib/workflow/ready-gate.test.ts`, `src/commands/ready.test.ts`, `src/lib/workflow/ready-gate.phase-policy.test.ts`, one new `src/lib/workflow/execution-config-parity.test.ts`
- not in scope: token reading (node 08), ladder (node 11), any driver.

## Acceptance criteria
- [ ] AC-1: `RunReadyGateOptions` carries the driver-relevant resolved config as one field (the resolved `ExecutionConfig` or a typed subset), not new one-off primitives — Verify: `grep -nE 'agent\?*:|aiderSettings\?*:' src/lib/workflow/ready-gate.ts` → matches only inside the shared-config field's type, never as top-level option keys.
- [ ] AC-2: both callers populate it from the resolver — Verify: `npx vitest run src/commands/ready.test.ts src/lib/workflow/ready-gate.test.ts -t "863"` → passes; the `ready.ts` case asserts `buildExecutionConfig` (or the same resolver) is what produced the value.
- [ ] AC-3: with `run.agent: "aider"` the ready-gate path selects the aider driver — Verify: same `-t "863"` run includes a test spying on driver selection (`getDriver`/registry) and asserting `"aider"`, not a config field.
- [ ] AC-4: producer parity — Verify: `npx vitest run src/lib/workflow/execution-config-parity.test.ts` → passes; the test builds both producers from identical inputs and asserts every key is equal except an explicit allowlist `{ phases, qualityLoop, sequential, concurrency, parallel, dryRun }` with a reason string per entry. `skipVerification`, `noSmartTests`, `retry` are plumbed (OQ-12) and therefore not in the allowlist. PR body carries `Mutation-verified: AC-4 — re-hardcoded retry: true in buildPhaseConfig; execution-config-parity.test.ts failed; restored.`
- [ ] AC-5: existing ready/ready-gate suites green — Verify: `npx vitest run src/lib/workflow/ready-gate-run.test.ts src/lib/workflow/ready-gate.phase-policy.test.ts src/commands/ready.phase-policy.test.ts` → passes.

## Done when
There is one resolved config object that both `sequant run --ready-gate` and `sequant ready` hand to the gate, a parity test fails when either producer drifts, and an aider-configured project's gate runs on aider.
