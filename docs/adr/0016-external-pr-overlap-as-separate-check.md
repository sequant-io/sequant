# ADR-0016: Report open-PR overlap as a separate, non-blocking merge check

**Status:** Accepted
**Date:** 2026-10-16
**Issue:** #1454

## Context

`sequant merge --check` compared only the feature branches in the batch, and `/assess` compared only file paths named in issue bodies. Neither saw open PRs on origin from another session, another machine, Dependabot or a human. A peer PR that touched the same files could merge mid-run and leave the issue's PR `CONFLICTING` (#760 → PR #764 → PR #765). Sometimes the conflict was semantic, so a textual rebase replayed it wrongly.

## Decision

Open PRs are a new overlap source with one fetcher and one intersection. `GitHubProvider.listOpenPRFilesSync` fetches every open PR's number, head branch and file list, and throws on failure. `src/lib/open-pr-overlap.ts` (`findOpenPrOverlaps`) intersects those lists with the work's paths. Each consumer formats the result its own way:

- `merge-check` adds an `external-pr-overlap` check. It always reports `passed: true` with no per-branch results, so its warnings never change the batch verdict or the exit code. A fetch failure becomes one `info` skip finding.
- `assess-collision-detect.ts` adds `formatOpenPrCollisionWarnings`, which renders the existing `⚠ #N  Modifies … (overlaps PR #M); land sequentially` line. `/assess` starts calling it after the plugin freeze lifts (graph doc D-8).

## Options

### Option A: A separate check with a shared intersection (chosen)

**Pros:** the exit code stays as it was, which the issue requires: the owner decides merge order. The batch check is not touched. Both consumers share one fetcher and one intersection. **Cons:** one more section in the report. The per-issue PR comments (`--post`) do not show these warnings, because the check has no per-branch results.

### Option B: Fold external PRs into `runOverlapDetection`

**Pros:** all overlap findings appear in one section. **Cons:** they would become branch `WARN`s, move the batch verdict to `NEEDS_ATTENTION` and change the exit code. That breaks the non-blocking requirement.

### Option C: Put the intersection in `assess-collision-detect.ts` and import it from merge-check

**Pros:** no new module. **Cons:** it couples the CLI merge check to the `/assess` heuristics module, so a change to body-path extraction would touch the merge check.

### Option D: A `gh` fetcher in each consumer

**Cons:** two producers of the same data that can drift apart. AC-2 of #1454 forbids it.

## Trade-offs

Option A gives up a verdict signal: a batch that overlaps a peer PR still reads `READY`. The warning text and the summary's warning count carry the signal instead. Fetch failures stay visible as a skip line rather than looking like "no peers", because the provider method throws instead of returning `[]`.

## Consequences

- `getChecksToRun` returns four Phase 1 checks (five with `--scan`).
- Each `merge --check` makes one extra `gh pr list` GraphQL call (15 s timeout). `gh` caps `files` at 100 per PR, so a larger PR can be under-reported.
- GitLab and Azure DevOps have no such method. Only `GitHubProvider` implements it, and `PlatformProvider` is unchanged. A provider without it would take the same skip path.
- The `/assess`, `/exec` and `/merger` skill prose that calls these functions is a follow-up after the freeze (#1459).
