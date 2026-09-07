# 11 — #971-A feat(run): model escalation ladder — config, trigger, dispatch, stickiness, one resolver

**Epic:** M2   **Blocked by:** #863, #986   **Tier:** judgment   **Doc:** PLAN §2 D-ladder, §5 I-1/I-2, §7 D4/D6, §9 OQ-4/OQ-5

## Why
#914/#915 fixed model and effort at launch and escalate effort on retry; this
adds the model rungs, routed only on the deterministic no-progress signals
(`LOOP_NO_DIFF`, `SAME_SHA_NO_PROGRESS`). Carries #971 AC-1, 2, 5, 6, 7, 8, 11
and the recording half of AC-10, plus the "does not escalate" half of AC-3.
Halts, `SPEC_DIVERGENCE`, verbose output and docs are node 14.

## Scope
- may touch: `bin/cli.ts` (`--model-ladder`, one line), `src/lib/settings.ts` (`run.modelLadder`), `src/lib/workflow/config-resolver.ts`, a new `src/lib/workflow/model-ladder.ts` beside `effort-escalation.ts`, the retry-dispatch sites in `src/lib/workflow/phase-executor.ts` / `batch-executor.ts` / `ready-gate.ts` (through the node 04 shared config only), `src/lib/workflow/state-schema.ts` (append rung/trigger fields beside #975's `requestedModel`), `src/lib/workflow/metrics-schema.ts` (append escalation columns to node 08's `phaseUsage` row shape — no second array), tests beside each, `src/lib/workflow/execution-config-parity.test.ts` (allowlist unchanged, new field asserted equal)
- not in scope: skills text (node 14); README/docs (node 14); verify-failure trigger (OQ-4, out); semantic finding comparison; downgrades.

## Design decisions fixed at plan review
- Ladder entries resolve through the #975 role resolver; raw strings stay legal (OQ-5).
- A #973-shaped result (`subtype: "success"`, `is_error: true`) counts as a retry-eligible outcome, never a success, at the dispatch site.

## Acceptance criteria
- [ ] AC-1: parse + precedence + off-by-default — Verify: `npx vitest run src/lib/workflow/model-ladder.test.ts -t "971 AC-1"` → passes: CLI beats settings; with no ladder, a retried phase's driver options equal #914/#915's exactly (deep-equal against the pre-change snapshot).
- [ ] AC-2: capability-bound trigger dispatches the next rung — Verify: `-t "971 AC-2"`: a retry whose prior attempt recorded `LOOP_NO_DIFF` or `SAME_SHA_NO_PROGRESS` dispatches with the next rung's model at the dispatch site (driver-options assertion), for both the run path and the ready-gate path.
- [ ] AC-3 (non-escalation half): advancing SHAs with repeated QA failure never changes the model — Verify: `-t "971 AC-3"`: three iterations with new SHAs and failing verdicts assert the model option is constant.
- [ ] AC-5: composes with #915 — Verify: `-t "971 AC-5"`: retry 1 escalates effort only; the model rung fires on a later capability-bound retry; no test iteration shows both changing.
- [ ] AC-6: sticky, no skipping, no overflow — Verify: `-t "971 AC-6"`: after escalation the rung persists across remaining iterations; rung index increments by one; at the top rung a further trigger leaves the model unchanged and sets a `topOfLadder` flag for node 14 to act on.
- [ ] AC-7: `--models` pin sets the starting rung; pin without ladder never escalates — Verify: `-t "971 AC-7"`.
- [ ] AC-8: marker-integrity guard — Verify: `-t "971 AC-8"`: a rigged missing/inconsistent phase marker is reconciled through the doctor path and no escalation occurs.
- [ ] AC-11: one resolver for both producers — Verify: `npx vitest run src/lib/workflow/execution-config-parity.test.ts src/lib/workflow/ready-gate.phase-policy.test.ts -t "971"` → passes; `grep -rn 'modelLadder' src/lib/workflow/ready-gate.ts src/lib/workflow/config-resolver.ts | grep -v import | wc -l` → the ready-gate count is `0` (it receives the value through the shared config, never reads settings itself).
- [ ] AC-10 (recording half): rung, base model, escalated model, trigger reason land in the phase marker (`requestedModel` included, per the #975 trail note) and in the `phaseUsage` row — Verify: `-t "971 AC-10"`; old records still load (`npx vitest run src/commands/stats.test.ts -t "986 AC-6"` still passes).
- [ ] AC-13: #973 shape is retry-eligible — Verify: `-t "971 AC-13"`: a result with `subtype: "success", is_error: true` enters the retry path and does not count as convergence.

## Done when
With a ladder configured, a phase that stalls with no progress is re-dispatched one rung up through the single shared resolver, sticks there, never skips or overflows, and records what it did; with no ladder, nothing changes.
