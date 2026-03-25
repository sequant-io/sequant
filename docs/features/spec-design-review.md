# Spec Design Review

The `/spec` skill now includes a mandatory Design Review section that evaluates *how* to build a feature before implementation starts. This catches wrong-layer decisions, over-engineering, and pattern mismatches before any code is written.

## Prerequisites

1. **sequant initialized** — `ls .sequant/`
2. **GitHub issue exists** — with clear requirements or acceptance criteria

## What It Does

When you run `/spec <issue>`, the output now includes a **Design Review** section between the Implementation Plan and Feature Quality Planning. It answers four questions:

| # | Question | Purpose |
|---|----------|---------|
| 1 | **Where does this logic belong?** | Identify the owning module/layer |
| 2 | **What's the simplest correct approach?** | Actively reject over-engineering |
| 3 | **What existing pattern does this follow?** | Name a specific pattern, confirm it fits |
| 4 | **What would a senior reviewer challenge?** | Anticipate design pushback |

## How It Scales

The Design Review adapts to issue complexity:

| Issue Type | Questions | Example |
|------------|-----------|---------|
| Simple fix (`simple-fix`, `typo`, `docs-only` labels) | Q1 + Q3 only | "Logic belongs in `utils.ts`, follows existing helper pattern" |
| Standard issue | All 4 questions | Full design review |
| Complex issue (`complex`, `refactor` labels) | All 4, detailed | In-depth layer analysis, multiple pattern candidates |

## Example Output

**Standard issue:**

```markdown
## Design Review

1. **Where does this logic belong?** Spec skill's SKILL.md prompt files — purely
   prompt engineering, not TypeScript. Same layer as Feature Quality Planning.

2. **What's the simplest correct approach?** Add a new section to the existing
   spec template. No new agents, no external lookups — just prompt additions.

3. **What existing pattern does this follow?** Same structure as Feature Quality
   Planning section — questions with conditional depth based on issue labels.

4. **What would a senior reviewer challenge?** "Should this be a separate agent?"
   No — adding complexity for a prompt-only change violates simplicity principle.
```

**Simple fix (abbreviated):**

```markdown
## Design Review

1. **Where does this logic belong?** `src/lib/utils.ts` — utility function,
   same layer as existing helpers.

3. **What existing pattern does this follow?** Matches `formatDuration()` and
   `slugify()` — pure functions, no side effects.
```

## What to Expect

- The Design Review appears in every `/spec` output and in the comment posted to the GitHub issue
- No additional time or API calls — it's part of the existing spec flow
- Downstream skills (`/exec`, `/qa`) benefit automatically from clearer design context

## Troubleshooting

### Design Review section is missing from spec output

Check that you're using the latest version of the spec skill. Run `sequant init` to update skill files, or verify `.claude/skills/spec/SKILL.md` contains the "Design Review" section.

### Design Review is too verbose for a simple fix

The skill should abbreviate to Q1 + Q3 for issues labeled `simple-fix`, `typo`, or `docs-only`. If it doesn't, verify the issue has the appropriate label applied before running `/spec`.

---

*Generated for Issue #413 / PR #424 on 2026-03-25*
