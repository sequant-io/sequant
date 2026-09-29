# ADR-0002: Spec stays in the main checkout; check it instead

**Status:** Accepted
**Date:** 2026-09-28
**Issue:** #1193

## Context

`spec`, `verify` and `merger` are registered with `requiresWorktree: false`, so `sequant run` executes them in the main checkout (`process.cwd()`) even when every other phase runs in a worktree. #933 moved the skills pre-flight from the main checkout to the provisioned worktrees, because worktrees only materialize tracked files. That left the main checkout unchecked.

In the field, a main checkout 21 commits behind `origin/master` had no `.claude/skills/spec/`, though the default branch did. Worktrees cut from the freshly fetched base passed the pre-flight. The spec agent could not load `/spec`, planned by hand from the phase prompt, and the phase was recorded as success, because `mapAgentSuccessCore` had output guards for `qa` and `exec` but none for `spec`.

## Decision

Keep `spec` in the main checkout. Check that checkout's skills for the phases that run there, before provisioning; warn when it is behind `origin/<base>`; and fail a spec that produced no `SEQUANT_SPEC` marker.

## Options

### Option A: Check the main checkout for `requiresWorktree: false` phases

Run the skills pre-flight a second time against `process.cwd()`, scoped to the phases that execute there, before any worktree is created. **Pros:** covers `spec`, `verify` and `merger` with one rule; fails before there is anything to clean up; the remedy can describe what actually happened (update the checkout, not "commit .claude/skills"). **Cons:** a second pre-flight call, and the main checkout's code can still be stale even when its skills are present.

### Option B: Run spec in the worktree

The batch executor already has the worktree path. **Pros:** spec would plan against the freshly fetched base. **Cons:** `/spec`'s Worktree Contract (#899) plans in the main checkout; it fixes one of three `requiresWorktree: false` phases and leaves the check gap for `verify` and `merger`; it changes where spec's side effects land.

### Option C: Warn or fail when the main checkout is stale

Compare the main checkout against `origin/<base>`. **Pros:** catches stale code, which Option A cannot see. **Cons:** as a hard failure it blocks legitimate runs from a checkout that is a few commits behind; alone, it does not catch a missing skill.

### Output guard: chat output vs. issue comment

A marker in the posted comment is the durable channel (#921), but a scan of all comments would accept a marker left by an earlier spec. The guard accepts the marker from the agent's output, or from a comment created during the phase (with a 60-second clock-skew allowance). Drivers that do not resolve skills (aider) are exempt: their spec prompt never asks for a marker.

## Trade-offs

A + C (warn only) closes the reported failure with the smallest change and keeps spec's contract as it is. The guard catches every other way a spec can end without loading its skill. What it gives up: the main checkout can still be stale, and the run only warns about it.

## Consequences

- A missing spec skill in the main checkout fails before any worktree exists, naming `.claude/skills/spec/SKILL.md`.
- A spec that ends without a marker costs a retry (`extraRetries: 1`) before the run stops, where it used to pass.
- Revisit Option B if `/spec` ever needs the implementation tree, or if stale-checkout warnings turn out to be ignored in practice.
