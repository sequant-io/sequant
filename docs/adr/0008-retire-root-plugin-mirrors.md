# ADR-0008: Retire the root `skills/` and `hooks/` copies; one owner for the skill mirror list

**Status:** Accepted
**Date:** 2026-10-04
**Issue:** #1271

## Context

[ADR-0006](0006-slim-plugin-folder.md) made `plugin/` the shipped plugin (`marketplace.json` `"source": "./plugin"`). After that, the root `skills/` and `hooks/` trees were dead copies that still cost something:

- Root `skills/` was a mirror that `scripts/check-skill-sync.ts` and `scripts/lint-skill-calls.ts` enforced, so every skill edit landed in four places.
- Root `hooks/` was hand-maintained, outside `scripts/sync-hooks.sh`, and had already drifted from `templates/hooks/`.
- `plugin-install-test.yml` tested the dead copies, not the plugin that ships.

Removing root `skills/` exposed a second problem. About 30 gate tests each declared their own list of skill mirror roots, and those lists already disagreed. Some named `plugin/skills` and some did not, and #1265 had to add `plugin/skills` to them one file at a time. This was the second re-patch of the same class (#738, then #1265).

One file in root `hooks/` was not a dead copy. `hooks/hooks.json` was the source of `plugin/hooks/hooks.json`: `sync-hooks.sh` copied root → plugin.

## Decision

Delete root `skills/` and `hooks/`. `scripts/check-skill-sync.ts` exports `SKILL_SOURCE_ROOT`, `SKILL_MIRROR_ROOTS` and `SKILL_ROOTS`, and every gate test and script that needs the mirror list imports it. `plugin/hooks/hooks.json` becomes its own hand-maintained source, guarded by a structural test.

## Options

### Option A: Remove `"skills"` from each hand-written array

**Pros:** smallest per-file change; no new import. **Cons:** keeps about 30 independent copies of the list. They had already drifted, and the next mirror change would need the same file-by-file sweep.

### Option B: One exported list, imported everywhere (chosen)

**Pros:** the same number of file edits as Option A, and a mirror change happens in one place. The arrays that had no `plugin/skills` now cover it. **Cons:** gate tests now depend on a script module. That module is already import-safe: `main()` is guarded, and 13 tests already import `collectFiles` from it.

### Option C (hooks manifest): move `hooks.json` to `templates/hooks/`

**Pros:** every hook file would have a template. **Cons:** `templates/hooks/*` is copied into every consumer's `.claude/hooks/`, so the plugin-only manifest would ship to consumers too.

### Option D (hooks manifest): keep it in `plugin/hooks/` as its own source (chosen)

**Pros:** one producer and no copy step. **Cons:** it has no byte-identity check. `hook-sync.test.ts` replaces that check with a structural one: every script the manifest registers must exist in `plugin/hooks/`.

## Trade-offs

Option B ends the drift class the hand-written arrays kept reopening, at no extra edit cost. Two lists stay local on purpose: `lint-skill-gates.ts` `SCAN_ROOTS` and `generate-constitution-dod.ts` `resolveQaSkillPath`. Both are first-match precedence lists that also run in consumer layouts, not mirror sets. Option D gives up byte-identity for the manifest, but byte-identity only meant something while there was a second copy to compare with.

## Consequences

- To add or remove a skill mirror, edit `SKILL_MIRROR_ROOTS` in `scripts/check-skill-sync.ts`. The sync, the call lint and every gate test follow.
- `plugin-install-test.yml` validates, syntax-checks and smoke-tests `plugin/hooks/` and `plugin/skills/`, and `--plugin-dir` loads `./plugin`. Its path filters list `templates/skills/**` and `templates/hooks/**`, the sources `plugin/` is generated from.
- `scripts/hook-corpus.ts --diff <ref>` reads `templates/hooks/` at the ref, because that directory exists at every ref.
- Root `.claude-plugin/plugin.json` still exists, because `/release` bumps it. Revisit if nothing reads it.
