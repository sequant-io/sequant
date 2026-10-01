# ADR-0004: Spec can halt the run before exec

**Status:** Accepted
**Date:** 2026-09-30
**Issue:** #1250

## Context

A retrospective of the 41 fix commits since v2.15.0 found that about 78% re-patched an artifact that already had an earlier fix. `/spec`'s Design Review confirmed whatever site the issue had already chosen: Q3 ("What existing pattern does this follow?") turned a recurring fix into the pattern to follow, nothing asked for every producer of the artifact, and when spec saw that the AC's lever was wrong it could only follow the AC or widen scope silently.

The runtime already had a halt for "the spec is impossible as written": `SPEC_DIVERGENCE` in a `SEQUANT_PHASE` marker (#995). `parseSpecDivergence` attaches it to every phase's result, spec included, but `runIssueWithLogging`'s spec path runs before the phase loop and never read the field, so a spec could not stop the run before exec.

## Decision

Design Review Q3 treats ≥2 prior fix issues as a stop, and a new Q5 lists every producer and consumer of the artifact. When either contradicts the lever the issue prescribes, spec emits the existing `SPEC_DIVERGENCE` outcome, and the spec path halts before exec with the same evidence bundle the phase loop prints.

## Options

### Option A: Reuse `SEQUANT_PHASE.outcome` and `parseSpecDivergence` (chosen)

The spec path reads the `specDivergence` field it already receives and calls the existing bundle builder, hoisted above the spec block. **Pros:** one producer of the signal, two consumers; no new parser, schema field or marker. **Cons:** the bundle builder now lives above the spec path, further from the loop that fills its arrays.

### Option B: A new `SPEC_HALT` marker or field

**Pros:** a name specific to spec. **Cons:** a second producer of the same signal, with a second parser to keep in sync — the class of defect this issue targets.

### Option C: Let the #1193 guard fail the spec phase

**Pros:** no code change. **Cons:** halts only when spec also omits `SEQUANT_SPEC`, prints no bundle, and lets a divergent-but-complete spec through to exec.

### Option D: A pure `buildEvidenceBundle` in `divergence-halt.ts`

**Pros:** testable in isolation. **Cons:** turns a hoist into a refactor for no behavior gain.

## Trade-offs

Option A keeps one producer per signal, which is the principle this issue adds to the constitution (§3 Boundaries). It gives up a little locality in `runIssueWithLogging`.

**Deviation from AC-5's parenthetical.** AC-5 says Simple-tier issues skip the Q3/Q5 additions. The audited re-patches were largely small `bug` issues with ≤2 ACs, which is exactly the Simple tier, so skipping the recurrence count there would miss most of the target. Simple keeps Q3 with its recurrence count (the same line, so no extra length); only Q5 is Standard/Complex-only.

## Consequences

- A spec that finds the lever wrong stops the run cheaply, with no exec spent and no model escalation.
- The owner resumes by editing the AC lines and re-running; a decision comment alone does not re-open the work.
- `/fullsolve` reads spec markers through its own path and does not yet honor a spec-phase divergence. Revisit if `/fullsolve` runs keep reaching exec after spec flagged the lever.
