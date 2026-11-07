**Epic:** M2   **Blocked by:** #863, #986   **Tier:** judgment   **Doc:** `docs/internal/graph-2026-09/PLAN.md` §2 D-ladder, §5 I-1/I-2, §7 D4/D6, §9 OQ-4/OQ-5   **Graph node:** 11

Builds on #914 (per-phase model/effort configuration), #915 (effort escalation on retries), and #581 (QA stagnation detection).

## Motivation

Well-specified issues execute reliably on cheaper models; today the phase model is fixed at launch, so users either overpay (strong model everywhere) or babysit (watch for stalls, relaunch manually with `--models`). #915 already escalates *effort* on observed retries; this adds the next rungs — *model* escalation — for the cases where an effort bump wasn't enough.

The critical design constraint: **model escalation only helps capability-bound churn, not spec-bound churn.** When the loop churns because the spec diverges from reality, a stronger model rediscovers the contradiction more expensively before halting. So the ladder must route on *why* the loop is churning, not just count iterations — and the two failure classes leave different fingerprints in data `qa-stagnation.ts` already records:

- **No progress** (`LOOP_NO_DIFF`, `SAME_SHA_NO_PROGRESS`): the agent can't produce a working change → capability-bound → escalate.
- **Progress but repeated failure** (new SHA each iteration, QA still fails): plausible diffs that don't converge → divergence-suspect → halt to human, never escalate.

## Design

- Opt-in: `run.modelLadder` (e.g. `["sonnet", "opus", "fable"]`) plus a `--model-ladder` CLI flag; absent = feature fully off, retried phases behave exactly as #914/#915 shipped. CLI takes precedence over settings.
- Composition with #915: effort escalation remains the first rung (retry 1 → effort +1 tier, same model). Model escalation fires only on a *subsequent* capability-bound trigger (retry ≥ 2 with no-progress stagnation), so the two escalators never fire on the same retry and recovery stays attributable.
- Trigger (capability-bound only): a retried phase execution where the prior attempt showed `LOOP_NO_DIFF` or `SAME_SHA_NO_PROGRESS`. Deliberately NOT "QA returns the same finding twice" — finding-level identity across LLM-written verdicts needs semantic comparison, the same fuzzy-gate class rejected in #922/#928. The deterministic stagnation signals are the proxy.
- Divergence escape hatch: exec/loop phase agents gain a structured `SPEC_DIVERGENCE` outcome (a phase marker naming the AC and the contradiction). The ladder treats it as terminal-to-human — routes to spec revision, never to a stronger model. This converts "fable burns tokens rediscovering the contradiction" into "sonnet reports the contradiction on iteration one."
- Mechanism: the escalated model is applied via the existing per-phase session-level plumbing from #914 (phase policy → claude-code driver), NOT the Agent-tool `model` param, which is inert per claude-code#43869. Each loop iteration is already a fresh phase dispatch, so no relaunch machinery is needed — this is a config swap at the existing retry-dispatch sites.
- Stickiness (deliberate contrast with #915's non-accumulation rule): once a phase escalates to a rung, it stays at that rung for its remaining iterations in the run — dropping back to a model that already failed re-burns the cheap rung. Rungs are never skipped.
- Precedence: an explicit `--models` pin sets the ladder's starting rung for that phase; a pin with no ladder configured never escalates.
- Marker integrity guard: before escalating, verify phase-marker integrity (the `sequant doctor` checks). A missing/inconsistent marker is reconciled, never escalated — a broken marker is not evidence of model incapability.
- Top-of-ladder halt: top rung + still not converging = halt and surface to the human with the accumulated evidence (SHAs tried, verdicts, escalation history), so the worst case buys a well-packaged handoff, not just spent tokens.
- Observability: escalations recorded in the phase marker and run metrics (same fields pattern as #914/#915) and surfaced in verbose output (`model: sonnet → opus (no-progress retry)`).
- Both ExecutionConfig producers (`buildExecutionConfig`, `ready-gate.ts:buildPhaseConfig`) apply the same logic through one resolver function (#833 drift guard) — mirror `withEscalatedEffort`'s single-choke-point pattern.

## Out of scope (deferred, not rejected)

- Pre-escalation divergence probe (a cheap bounded session asking "is this AC achievable as written?") — favorable noise asymmetry, but adds a session type; revisit after dogfood metrics.
- Semantic comparison of QA findings across verdicts — rejected as a trigger (see above).
- Speculative *downgrades* — same reasoning as #915: escalation on evidence can only trade cost for quality; prediction can trade the reverse.

## Scope (graph plan 2026-09)

- may touch: `bin/cli.ts` (`--model-ladder`, one line), `src/lib/settings.ts` (`run.modelLadder`), `src/lib/workflow/config-resolver.ts`, a new `src/lib/workflow/model-ladder.ts` beside `effort-escalation.ts`, the retry-dispatch sites in `src/lib/workflow/phase-executor.ts` / `batch-executor.ts` / `ready-gate.ts` (through the #863 (node 04) shared config only), `src/lib/workflow/state-schema.ts` (append rung/trigger fields beside #975's `requestedModel`), `src/lib/workflow/metrics-schema.ts` (append escalation columns to #986 (node 08)'s `phaseUsage` row shape — no second array), tests beside each, `src/lib/workflow/execution-config-parity.test.ts` (allowlist unchanged, new field asserted equal)
- not in scope: skills text (#995 (node 14)); README/docs (#995 (node 14)); verify-failure trigger (OQ-4, out); semantic finding comparison; downgrades.

## Design decisions fixed at plan review (graph plan 2026-09)

- Ladder entries resolve through the #975 role resolver; raw strings stay legal (OQ-5).
- A #973-shaped result (`subtype: "success"`, `is_error: true`) counts as a retry-eligible outcome, never a success, at the dispatch site.

## Acceptance criteria (graph plan 2026-09)

- [ ] AC-1: parse + precedence + off-by-default — Verify: `npx vitest run src/lib/workflow/model-ladder.test.ts -t "971 AC-1"` → passes: CLI beats settings; with no ladder, a retried phase's driver options equal #914/#915's exactly (deep-equal against the pre-change snapshot).
- [ ] AC-2: capability-bound trigger dispatches the next rung — Verify: `-t "971 AC-2"`: a retry whose prior attempt recorded `LOOP_NO_DIFF` or `SAME_SHA_NO_PROGRESS` dispatches with the next rung's model at the dispatch site (driver-options assertion), for both the run path and the ready-gate path.
- [ ] AC-3 (non-escalation half): advancing SHAs with repeated QA failure never changes the model — Verify: `-t "971 AC-3"`: three iterations with new SHAs and failing verdicts assert the model option is constant.
- [ ] AC-5: composes with #915 — Verify: `-t "971 AC-5"`: retry 1 escalates effort only; the model rung fires on a later capability-bound retry; no test iteration shows both changing.
- [ ] AC-6: sticky, no skipping, no overflow — Verify: `-t "971 AC-6"`: after escalation the rung persists across remaining iterations; rung index increments by one; at the top rung a further trigger leaves the model unchanged and sets a `topOfLadder` flag for #995 (node 14) to act on.
- [ ] AC-7: `--models` pin sets the starting rung; pin without ladder never escalates — Verify: `-t "971 AC-7"`.
- [ ] AC-8: marker-integrity guard — Verify: `-t "971 AC-8"`: a rigged missing/inconsistent phase marker is reconciled through the doctor path and no escalation occurs.
- [ ] AC-11: one resolver for both producers — Verify: `npx vitest run src/lib/workflow/execution-config-parity.test.ts src/lib/workflow/ready-gate.phase-policy.test.ts -t "971"` → passes; `grep -rn 'modelLadder' src/lib/workflow/ready-gate.ts src/lib/workflow/config-resolver.ts | grep -v import | wc -l` → the ready-gate count is `0` (it receives the value through the shared config, never reads settings itself).
- [ ] AC-10 (recording half): rung, base model, escalated model, trigger reason land in the phase marker (`requestedModel` included, per the #975 trail note) and in the `phaseUsage` row — Verify: `-t "971 AC-10"`; old records still load (`npx vitest run src/commands/stats.test.ts -t "986 AC-6"` still passes).
- [ ] AC-13: #973 shape is retry-eligible — Verify: `-t "971 AC-13"`: a result with `subtype: "success", is_error: true` enters the retry path and does not count as convergence.

## Done when (graph plan 2026-09)

With a ladder configured, a phase that stalls with no progress is re-dispatched one rung up through the single shared resolver, sticks there, never skips or overflows, and records what it did; with no ladder, nothing changes.

<details>
<summary>Original acceptance criteria (superseded by the graph-plan ACs above; kept for history)</summary>

- AC-1: `run.modelLadder` and `--model-ladder` are parsed, with CLI precedence over settings; with no ladder configured, retried phases carry the same model options as #914/#915 ship today (unescalated, verified by a driver-options unit test)
- AC-2: with a ladder configured, a retried phase whose prior attempt recorded `LOOP_NO_DIFF` or `SAME_SHA_NO_PROGRESS` dispatches at the next ladder rung, verified by a driver-options unit test at the dispatch site
- AC-3: a divergence-suspect pattern (repeated failed QA verdicts at advancing SHAs) does NOT escalate the model; the loop halts and surfaces the divergence-suspect evidence to the human
- AC-4: a `SPEC_DIVERGENCE` phase-marker outcome halts to human/spec-revision without escalating, and the exec/loop skill docs instruct agents when to emit it
- AC-5: model escalation composes with #915 — effort escalates on the first retry at the same model, and the model rung fires only on a subsequent capability-bound trigger, never both on the same retry
- AC-6: an escalated rung persists for that phase's remaining iterations in the run, rungs are never skipped, and the ladder never escalates past its last entry
- AC-7: an explicit `--models` pin sets the ladder starting rung; a pin with no ladder configured never escalates
- AC-8: a rigged missing/inconsistent phase marker is reconciled (doctor path) without escalating, verified by a unit test on the guard
- AC-9: top-of-ladder non-convergence halts with an evidence bundle (SHAs, verdicts, escalation history) instead of looping
- AC-10: escalations are recorded in the phase marker, run metrics, and verbose output with base model, escalated model, and trigger reason
- AC-11: both ExecutionConfig producers apply escalation through one shared resolver function (no per-call-site copies), with a test covering the ready-gate path
- AC-12: README + docs/ document the ladder, triggers, the capability-vs-spec-bound distinction, cost implications, and the `SPEC_DIVERGENCE` escape hatch

</details>


