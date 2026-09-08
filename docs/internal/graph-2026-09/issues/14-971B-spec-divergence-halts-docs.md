# 14 — #971-B feat(run): `SPEC_DIVERGENCE` escape hatch, halts with evidence bundles, verbose output, docs, rigged real run

**Epic:** M3   **Blocked by:** #971-A (node 11)   **Tier:** judgment   **Doc:** PLAN §2 D-ladder, §5 I-4, §7 D4, issue-graph anti-gap 5 (fixture issue)

## Why
The ladder is only safe if divergence goes to a human and never to a stronger
model. Carries #971 AC-3 (halt half), 4, 9, 10 (verbose half), 12, plus the
graph's "first real use" rule: one rigged run on this repo.

## Scope
- may touch: `src/lib/workflow/state-schema.ts` (append the `SPEC_DIVERGENCE` outcome), the halt sites in `src/lib/workflow/batch-executor.ts` / `ready-gate.ts` (through node 11's resolver output), verbose logging in `src/lib/workflow/phase-executor.ts`, `templates/skills/exec/SKILL.md` + `templates/skills/loop/SKILL.md` and their `.claude/skills` and `skills` mirrors, `README.md`, `docs/reference/run-command.md` (or a new `docs/reference/model-ladder.md`), tests beside each, one throwaway fixture issue on this repo (closed after)
- not in scope: verify-failure trigger (OQ-4); pre-escalation probe; downgrades.

## Acceptance criteria
- [ ] AC-3 (halt half): divergence-suspect pattern halts and surfaces evidence — Verify: `npx vitest run src/lib/workflow/model-ladder.test.ts -t "971 AC-3 halt"` → the loop stops after the stagnation detector's divergence signal with a bundle containing SHAs tried, verdicts, and escalation history (empty).
- [ ] AC-4: `SPEC_DIVERGENCE` marker halts without escalating, and the skills say when to emit it — Verify: `-t "971 AC-4"` for the halt; `grep -c 'SPEC_DIVERGENCE' templates/skills/exec/SKILL.md templates/skills/loop/SKILL.md` → both ≥ 1; `md5 -q templates/skills/exec/SKILL.md .claude/skills/exec/SKILL.md skills/exec/SKILL.md | uniq | wc -l` → `1` (same for `loop`).
- [ ] AC-9: top-of-ladder halt — Verify: `-t "971 AC-9"`: with node 11's `topOfLadder` flag set and a further trigger, the run halts with the evidence bundle instead of looping.
- [ ] AC-10 (verbose half): `model: sonnet → opus (no-progress retry)` appears in verbose output — Verify: `-t "971 AC-10 verbose"` asserts the exact line format.
- [ ] AC-12: docs — Verify: `grep -c 'modelLadder\|model-ladder' README.md docs/reference/*.md` ≥ 2, and the docs section names the capability-vs-spec-bound distinction and `SPEC_DIVERGENCE` (`grep -c 'SPEC_DIVERGENCE' docs/reference/*.md` ≥ 1).
- [ ] AC-14 (real run): a fixture issue on this repo whose single AC is impossible as written (e.g. asserts a file both exists and does not), run with `run.modelLadder` configured, halts with `SPEC_DIVERGENCE` and no escalation — Verify: after the run, `jq '[.. | objects | select(has("phaseUsage")) | .phaseUsage[]? | select(.escalatedModel != null)] | length' .sequant/metrics.json` → `0` for that run, and the run's halt output names the AC; the fixture issue is closed with a comment linking the run. Honest SKIP is not allowed here: the rig is deterministic.

## Done when
A contradiction in the spec stops the run at the cheapest rung with a packaged handoff, the skills tell agents when to declare one, and the docs explain the ladder — proven once on a rigged real run.
