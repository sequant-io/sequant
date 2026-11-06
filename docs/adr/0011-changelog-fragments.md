# ADR-0011: Changelog fragments instead of a shared `[Unreleased]` block

**Status:** Accepted
**Date:** 2026-10-08
**Issue:** #1351

## Context

121 of 192 first-parent commits on `main` since 2026-09-01 touched `CHANGELOG.md`, all in the one `## [Unreleased]` block, so each squash-merge made the next PR conflict. `merge=union` (#1133) only helps local merges; GitHub still conflicts. A merge queue removes a conflicting PR from the queue, so it does not fix this.

## Decision

Each PR adds `changelog.d/<issue>-<slug>.md` (`kind: Added|Changed|Fixed|Removed|Security`, then the entry). `scripts/changelog-collate.ts` (`npm run changelog:collate -- <version>`) builds the version section grouped by kind, carries over any bullets still under `[Unreleased]`, and deletes the fragments. A malformed fragment exits non-zero and changes nothing. `/exec` writes the fragment, `/qa` accepts it, `/release` and `scripts/release.sh` collate it.

## Options

### Option 1: In-repo script (chosen)
No new dependency; fits the `scripts/` plus vitest pattern. Fragments live in separate files, so two PRs cannot collide.

### Option 2: changie (rejected)
A standalone Go binary, a non-npm dependency for release.

### Option 3: @changesets/cli (rejected)
It also bumps versions and writes the changelog its own way, which clashes with `/release`'s bump.

## Consequences

- `CHANGELOG.md` is only edited by the release. `.gitattributes` drops the union driver.
- A malformed fragment is found at release (or with `--check`), not at PR time. A CI check can be added later (#1350's `merge_group` trigger).
- PRs opened before this landed may still add `[Unreleased]` bullets; collate carries them over.
