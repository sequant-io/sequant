# 01 — #990 fix(sync): never rewrite a user-owned `AGENTS.md` or write a machine-specific `scripts/dev` symlink (absorbs #991)

**Epic:** W2   **Blocked by:** —   **Tier:** mechanical   **Doc:** W2 PLAN §4 (template sync seam), §5 I-2, §7 D1/D2/D3/D6, Lab §1

## Why
Two file classes from the 2026-09-06 downstream incident that #988 (v2.13.1)
did not close, because an explicit `sequant sync` still does both:

- **`AGENTS.md`** — `src/commands/sync.ts:498-512` regenerates it whenever it
  exists; it is not in `CUSTOMIZABLE_FILES` (`src/lib/templates.ts:238`) and
  `sync` has no `--no-agents-md` (only `init` does, `bin/cli.ts:189`). A
  deliberate 73-line pointer file was replaced with a 1,079-line copy of
  `CLAUDE.md` because `generateAgentsMd` inlines `getPortableInstructions()`
  (`src/lib/agents-md.ts:100`).
- **`scripts/dev/*.sh`** — symlink target is
  `relative(dirname(dest), <templates dir of whichever sequant ran>)`
  (`src/lib/templates.ts:499-507`): an npx cache path (evicted → dead links), an
  `npm link` sibling or a global prefix (machine-specific). Only a local
  devDependency target survives `git clone && npm install`. The links are
  tracked (`GITIGNORE_ENTRIES` is `.sequant/` only, `src/commands/init.ts:101`),
  so every re-sync from a different runner is churn on three files.
- **Found in Phase 0 (Lab §1):** `src/commands/doctor.ts:320-360` tells the
  owner of a pointer-style `AGENTS.md` to run `sequant sync --force` — the
  command that destroys it.

One contract (PLAN §5 I-2): sequant never rewrites a tracked file the user owns,
never writes a machine-specific one, and shows every such decision before
writing.

## Scope
- may touch: `src/lib/templates.ts`, `src/lib/agents-md.ts`,
  `src/commands/sync.ts`, `src/commands/init.ts`, `src/commands/doctor.ts`,
  `bin/cli.ts` (one `.option()` line on `sync`), `README.md` (sync-section
  lines), `CHANGELOG.md` (`[Unreleased]`, one bullet); tests:
  `src/lib/templates.test.ts`, `src/lib/agents-md.test.ts`,
  `src/commands/sync.test.ts`, `src/commands/init.test.ts`,
  `src/commands/doctor.test.ts`.
- not in scope: populating `Manifest.files` (PLAN §10); gitignoring
  `scripts/dev` (OQ-1); the Windows copy path (unchanged); any hook or skill
  file (I-4).
- real filesystem only: symlink/copy tests run in a temp project with
  `SEQUANT_TEMPLATES_DIR`; no `fs` mocking (I-8).

## Acceptance criteria
- [ ] AC-1: a generated `AGENTS.md` begins with the marker line `<!-- sequant:agents-md v=<package version> h=<sha1 of everything after the marker line> -->`, written by `generateAgentsMd` and therefore present in `init` output — Verify: `npx vitest run src/lib/agents-md.test.ts -t "AC-1"` → first line matches `^<!-- sequant:agents-md v=\S+ h=[0-9a-f]{40} -->$` and `h` recomputes from the body.
- [ ] AC-2: `sequant sync` leaves an `AGENTS.md` byte-identical when it has no marker or its body hash ≠ the marker's `h=`, lists it under `Customizable (preserved)`, and rewrites it only with `--force`; a marked file whose hash matches is regenerated as today — Verify: `npx vitest run src/commands/sync.test.ts -t "AC-2"` → three cases: unmarked file unchanged + `preserved` line; marked-and-matching regenerated; `--force` rewrites both. Mutation: delete the marker/hash guard → the first case fails; restore.
- [ ] AC-3: `sequant sync --no-agents-md` skips `AGENTS.md` entirely (parity with `init`) — Verify: `npx vitest run src/commands/sync.test.ts -t "AC-3"` → `generateAgentsMd` not called, file untouched; `node dist/bin/cli.js sync --help | grep -c -- '--no-agents-md'` → `1`.
- [ ] AC-4: when `<project>/node_modules/sequant/templates/scripts/` exists, every `scripts/dev/*.sh` link targets it (relative path) regardless of which sequant binary ran the command — Verify: `npx vitest run src/lib/templates.test.ts -t "AC-4"` → with `SEQUANT_TEMPLATES_DIR` pointing at a sibling dir and a fake `node_modules/sequant/templates/scripts` present, `readlink` of each link resolves inside `node_modules/sequant`. Mutation: remove the `node_modules` preference → fails; restore.
- [ ] AC-5: with no local `node_modules/sequant`, a templates dir under a `/_npx/` path segment or outside the project tree yields copies, not links, plus exactly one stdout line that says why and names `--no-symlinks` — Verify: `npx vitest run src/lib/templates.test.ts -t "AC-5"` → two cases (the `_npx` case uses the verbatim field target `../../../../.npm/_npx/38ae72183b73fa32/node_modules/sequant/templates/scripts/new-feature.sh`, observed committed in `sequant-io/sequant-landing` on 2026-09-09 — PLAN D13; the second is a sibling dir): no symlinks under `scripts/dev`, files present, exactly one line matching `--no-symlinks`. Mutation: drop the `_npx`/outside-tree detection → links appear; restore.
- [ ] AC-6: `sequant sync --dry-run` and `sequant update --dry-run` print the `AGENTS.md` decision (`regenerate` | `preserved` | `skipped (--no-agents-md)`) and, for each `scripts/dev` link whose target would change, `old → new`, and write nothing — Verify: `npx vitest run src/commands/sync.test.ts -t "AC-6"` → stdout assertions; project tree hash identical before and after.
- [ ] AC-7: `sequant doctor` (a) warns on a `scripts/dev/*.sh` link whose target is missing or resolves outside both `node_modules/sequant` and the project tree, naming the fix command, and (b) reports an unmarked or hash-mismatched `AGENTS.md` as `user-owned (preserved by sync)` and never recommends `sync --force` for it — Verify: `npx vitest run src/commands/doctor.test.ts -t "AC-7"` → dead-link case warns with the fix text; user-owned case's message contains no `--force`. Mutation: restore the old `--force` hint → (b) fails; restore.
- [ ] AC-8: the behavior change is documented — `CHANGELOG.md` `[Unreleased]` and the README sync section state the ownership rule, the marker, and that pre-existing `AGENTS.md` files without a marker are treated as user-owned until `sync --force` once — Verify: `grep -c "sequant:agents-md" README.md CHANGELOG.md` → both ≥ 1.
- [ ] AC-9: suite green — Verify: `npm run build && npm test` → pass.

## Done when
`sequant sync`/`update` never rewrite an `AGENTS.md` the user owns and never
write a `scripts/dev` link that only works on the machine that ran the command,
and every such decision is visible in `--dry-run` and `doctor` before any
write.
