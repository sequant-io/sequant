# ADR-0015: Record the install scope in the manifest

**Status:** Accepted
**Date:** 2026-10-16
**Issue:** #1409

## Context

`sequant init --manifest-only` followed by `sequant sync --only skills` is the documented way to adopt sequant in an existing repo (#1209). That install writes `.claude/skills/**` and nothing else. The content-drift check (`computeContentDrift`, #713) counted every bundled template that is `new` or `modified`, so each hook, agent, `scripts/dev` script and `.claude/settings.json` the adopter left out counted as drift. The warning never cleared. Its remedy, `sync --force (or update)`, installed the skipped groups, and `sync --force` also overwrote the repo's own constitution (#814: `--force` overwrites user-owned files by design).

The manifest kept `"files": {}` after `sync --only skills`, so nothing recorded which groups were installed. The drift check had nothing to scope against.

## Decision

The manifest records the install scope in an optional `groups` field. `init --manifest-only` writes `groups: []`, `sync --only skills` adds `"skills"`, and a full sync removes the field. A manifest without the field is a full install. `src/lib/manifest.ts` owns the field; consumers read it through `getInstallScope`. Drift and the remedy text are scoped to it.

## Options

### Option A: Record the scope in the manifest (chosen)

An optional `groups` field written by the commands that choose the scope. **Pros:** says what the user chose; tells "never installed" apart from "deleted by accident"; old manifests need no migration because absence means full. **Cons:** one more field every manifest writer must keep correct; `update` (no `--only`) installs every group but leaves the field as it was (follow-up).

### Option B: Infer the scope from what exists on disk

Treat a group as installed when any of its files exist. **Pros:** no format change. **Cons:** a deleted hook reads as "never installed" and its drift disappears, which hides the case drift detection exists for. Rejected by the owner (graph doc OQ-1).

### Option C: A required field with a migration

**Pros:** no "absent" case. **Cons:** breaks every manifest written before it and the minimal manifest `run` documents (#1209).

## Trade-offs

Option A costs an optional field and keeps the old behaviour for every existing install. It gives up nothing a full install had: a full install has no `groups`, and `sync --only` never adds the field to a manifest that lacks it, so a later partial sync cannot narrow a full install and hide drift.

## Consequences

- A skills-only install reports drift only under `.claude/skills/**`, and its remedy is `sync --only skills --force` (content drift) or `sync --only skills` (version mismatch), which never writes outside the skills tree.
- Widening a partial install is a full `sync` or `init`; both record a full install.
- `update` and `doctor` do not read the scope yet. Revisit when `update` gains a scope (`update --only` is out of scope for #1409).
