# Spec Skill: Compressed Prompt and Tiered Context

The `/spec` skill prompt has been compressed by 68% (5,508 to 1,757 words) and now adapts its output to issue complexity. Simple issues get lean output; complex issues get full analysis.

## Prerequisites

1. **sequant initialized** — `ls .claude/skills/spec/SKILL.md`
2. **GitHub CLI (optional)** — `gh auth status`. If unavailable, `/spec` falls back to manual AC input.

## What Changed

### Output Tiers

`/spec` now determines a complexity tier before generating output and announces it on the first line:

| Tier | Criteria | What You Get |
|------|----------|-------------|
| **Simple** | `simple-fix`/`typo`/`docs-only` label, or `bug` with 1-2 ACs | AC list + plan + Design Review Q1/Q3 only |
| **Standard** | 3-8 ACs, no complexity labels | Full output minus Polish section |
| **Complex** | `complex`/`refactor`/`breaking` label, or 9+ ACs | Full output including all quality dimensions |

Output begins with: `**Complexity: Standard** (5 ACs, 3 directories)`

### Conditional Agent Spawning

The skill no longer always spawns 3 explorer agents. Agent count depends on issue content:

| Issue Content | Agents |
|---------------|--------|
| Database/SQL/migration keywords | 3 |
| UI/frontend references | 2 |
| CLI/script changes | 2 |
| Docs/config/simple-fix | 1 |

### Platform Detection

`/spec` now checks for available tools before execution:
- If `gh` CLI is unavailable: skips phase detection, label review, and auto-comment
- If `.sequant/settings.json` is missing: uses defaults silently

### Exception-Based Quality Planning

Feature Quality Planning changed from a 25+ checkbox ceremony to exception reporting. Instead of marking `[x] N/A` for items that don't apply, the output now says:

> **All standard checks pass.** Notable items:
> - [Only gaps and concerns are listed]

The full checklist is still available in `references/quality-checklist.md` and is used for Complex tier issues.

## Skill Versioning

Skills now carry a `version` field in their YAML frontmatter (under `metadata`):

```yaml
metadata:
  author: sequant
  version: "2.1"
```

### Checking for Updates

Run `sequant status` — if any installed skill is behind the package template version, you'll see:

```
Skill updates available (1):
    spec: v1.0 -> v2.1
    Run `sequant init --upgrade-skills` to update.
```

### Upgrading Skills

```
sequant init --upgrade-skills
```

This compares your installed `.claude/skills/` files against the package templates, shows a color-coded diff for each changed file, and asks for confirmation before applying.

- Does NOT auto-run — you must explicitly pass `--upgrade-skills`
- In interactive mode, prompts for confirmation before overwriting
- Shows new files that would be added

## Reference Files

The spec skill uses tiered reference files in `.claude/skills/spec/references/`:

| File | Purpose |
|------|---------|
| `verification-criteria.md` | Guide for choosing verification methods, #452 case study |
| `quality-checklist.md` | Full Feature Quality Planning checklist (for Complex tier) |
| `parallel-groups.md` | Format for parallel execution groups in implementation plans |
| `recommended-workflow.md` | Expected format for the Recommended Workflow section |

These are loaded on demand by the model, not included in the prompt token budget.

## Troubleshooting

### `/spec` output is too brief

The tier was likely set to Simple. Check the first line of output for the tier announcement. If the issue needs more detail, add a `complex` or `refactor` label and re-run.

### `sequant status` doesn't show skill versions

Skills without a `version` field in `metadata` won't appear in version checks. Only the spec skill has `version: "2.1"` currently — other skills will be updated in future releases.

### `sequant init --upgrade-skills` shows no changes

Your installed skills match the package templates. This is expected after a fresh `sequant init` or recent upgrade.

---

*Generated for Issue #515 on 2026-04-14*
