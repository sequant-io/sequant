# Documentation Tiers

Where knowledge lives in this repo, by how often it's needed and how long it stays true.

**There are no line-count targets.** Judge a tier by whether the right reader
finds the right thing, not by size. A short CLAUDE.md means the other tiers are
working, not that it needs filling.

## Tier 1: CLAUDE.md — the always-loaded index

Loaded into **every** session, so everything here is a tax on every session.

**Keep only:**
- ✅ Rules with no natural home in a skill or doc (commit conventions, hook gotchas)
- ✅ Pointers — a one-line "here's the trap, here's the link"
- ✅ Things that are wrong to learn late (e.g. skill-invocation namespacing)

**Move out:**
- ❌ Anything that matters in one workflow → that skill
- ❌ Anything explanatory or >~10 lines → `docs/` and link to it
- ❌ Session-to-session context about *this developer's* work → auto-memory

## Tier 2: Auto-memory — the main knowledge store

`~/.claude/projects/<project>/memory/`, indexed by `MEMORY.md`. This is where
most of this repo's hard-won knowledge actually lives (100+ entries): pitfalls,
feedback, architecture decisions, roadmap state.

- One fact per file; `MEMORY.md` carries a one-line pointer.
- Best tier for "I learned this the hard way and would re-learn it otherwise".

**Its failure mode is rot, not bloat.** Entries citing script flags, CLI
behavior, or `file:line` go stale silently, and a *wrong* memory is worse than a
missing one — it gets trusted. Verify before asserting; fix on sight.

## Tier 3: docs/ — reference for humans

Real structure: `concepts/`, `features/`, `guides/`, `reference/`,
`getting-started/`, `examples/`, `internal/`, `incidents/`, `investigations/`.

- Detailed specs, architecture, runbooks. Length is fine here.
- User-facing behavior changes must land here, and often in **more than one
  place** — check the main README, the marketplace README, and `docs/`.
- Review when the behavior it describes changes, not on a calendar.

## Tier 4: Skills — workflow instructions

`skills/`, `templates/skills/`, `.claude/skills/` — **three real copies**;
fix all three or `sequant init`/`update` regenerates the bug (CI enforces this
via `npm run lint:skill-sync`).

- Procedure a skill must follow belongs in its `SKILL.md`.
- Detail a skill needs only sometimes → its `references/`, linked from `SKILL.md`.
- **When editing a SKILL.md, grep its `references/` for the same claim.** Prose
  specs of a rule drift out of sync with the rule itself.

## Tier 5: Code comments

Constraints the code can't show — why this approach, what breaks otherwise.
Not what the next line does, and not where it came from.

## When to extract from CLAUDE.md

- ✅ It's explanatory rather than a pointer
- ✅ It only applies to one workflow or one command
- ✅ It has examples, steps, or rationale
- ✅ It could evolve independently of the rest

## Health check

**CLAUDE.md:** is every line still true, still needed in *most* sessions, and
not duplicated in a skill? Recommend `Prune | Restructure | Extract | Good as-is`
— never "Expand".

**Memory:** spot-check entries relied on this session against current code.
Are `MEMORY.md` one-liners still accurate? Any entry superseded by shipped work?

**docs/:** does anything contradict what shipped? Behavior changes are the usual
source of drift.

**Skills:** are the three copies in sync, and does each `SKILL.md` agree with its
own `references/`?
