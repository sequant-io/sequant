# Skill/CLI Drift Prevention

Automated smoke tests that verify skill documentation (SKILL.md) stays in sync with the canonical CLI flags and phase definitions. Prevents recurrence of drift where skill examples reference nonexistent flags or phase names.

## Prerequisites

1. **Node.js 20+** — `node --version`
2. **Project dependencies installed** — `npm install`

## Setup

No additional setup required. The smoke tests run as part of the standard test suite (`npm test`).

## What It Does

The assess skill smoke test (`src/lib/__tests__/assess-skill.test.ts`) verifies three categories of drift:

1. **Phase vocabulary:** The "Valid phases" reference line in the assess skill's Step 4 (Workflow Detection) lists all phases from `PhaseSchema` in `src/lib/workflow/types.ts` — no extras, no omissions.

2. **CLI flag accuracy:** Example commands and the "Other flags" section in the assess SKILL.md only reference flags registered via `.option()` in `bin/cli.ts`.

3. **3-directory sync:** The assess SKILL.md content is identical across `.claude/skills/`, `skills/`, and `templates/skills/`.

## What to Expect

Tests run in under 1 second. They read files as text (no compilation or Commander execution needed). A failure means a skill document has drifted from the source of truth.

## Valid Phases Reference

The canonical phase list (from `PhaseSchema`):

`spec`, `security-review`, `exec`, `testgen`, `test`, `verify`, `qa`, `loop`, `merger`

This list appears in the assess skill's Step 4 section after the label-to-phase workflow table.

## How Drift Is Caught

| Drift Category | Source of Truth | Test Method |
|----------------|----------------|-------------|
| Invalid phase name in skill | `PhaseSchema` in `types.ts` | Import schema, compare against SKILL.md |
| Invalid CLI flag in examples | `.option()` calls in `bin/cli.ts` | Regex extraction, compare against SKILL.md |
| Skill directory desync | `.claude/skills/assess/SKILL.md` | Byte-equal comparison across 3 directories |

## Troubleshooting

### Test fails: "Expected phases to contain X"

**Symptoms:** A phase was added to or removed from `PhaseSchema` but the assess SKILL.md reference line wasn't updated.

**Solution:** Update the "Valid phases" line in `.claude/skills/assess/SKILL.md` to match `PhaseSchema`, then sync to `skills/` and `templates/skills/`.

### Test fails: "Expected validRunFlags to contain --X"

**Symptoms:** A SKILL.md example uses a flag that doesn't exist in `bin/cli.ts`.

**Solution:** Either fix the SKILL.md example to use the correct flag, or register the missing flag in `bin/cli.ts` if it should exist.

### Test fails: 3-directory sync

**Symptoms:** One of the three SKILL.md copies differs from the others.

**Solution:** Copy the authoritative version (`.claude/skills/assess/SKILL.md`) to `skills/assess/SKILL.md` and `templates/skills/assess/SKILL.md`.

---

*Generated for Issue #467 on 2026-03-26*
