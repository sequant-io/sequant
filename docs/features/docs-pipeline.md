# Lighter QA Pipeline for Documentation Issues

When a GitHub issue has documentation labels (`docs`, `documentation`, or `readme`), Sequant automatically uses a lighter QA pipeline optimized for content changes. The full workflow still includes spec — see [#533](https://github.com/sequant-io/sequant/issues/533) for the rationale on universal spec inclusion.

## Prerequisites

1. **Sequant installed** — `npx sequant --version`
2. **GitHub issue with a docs label** — one of: `docs`, `documentation`, `readme`

## What Changes

Documentation issues use the same three-phase workflow as other issues, but the QA phase is lighter:

| Issue Type | Workflow | Phases |
|------------|----------|--------|
| Standard | spec → exec → qa | 3 phases |
| Bug fix | spec → exec → qa | 3 phases (since #533) |
| **Documentation** | **spec → exec → qa** | **3 phases (with lighter QA, see below)** |

The QA phase adapts when running on docs issues:

| QA Behavior | Standard Issues | Docs Issues |
|-------------|-----------------|-------------|
| Type safety check | Yes (sub-agent) | Skipped |
| Security scan | Yes (sub-agent) | Skipped |
| Scope/size check | Yes (sub-agent) | Yes (1 sub-agent) |
| Sub-agents spawned | 3 | 1 |

## Setup

No configuration needed. The lighter QA pipeline activates automatically when `autoDetectPhases` is enabled (the default).

To verify auto-detection is on:

```bash
cat .sequant/settings.json | grep autoDetectPhases
# Expected: "autoDetectPhases": true
```

## What You Can Do

### Run a documentation issue

```bash
sequant run 123
```

If issue `#123` has a `docs`, `documentation`, or `readme` label, Sequant will:

1. Run spec to plan the change (since #533, spec always runs)
2. Run exec (implementation)
3. Run QA with a single sub-agent focused on scope/size and link validation (lighter than the full 3-agent QA)

### Verify lighter QA is active

The orchestrator passes `SEQUANT_ISSUE_TYPE=docs` to the QA skill when a docs label is present. The `/qa` skill reads this and uses the docs-lighter pipeline (1 sub-agent instead of 3).

## What to Expect

- **Same spec behavior:** Spec runs to plan the change, just like any other issue. This catches scope/design decisions in docs work that would otherwise slip through.
- **Same exec behavior:** The implementation phase runs identically.
- **Lighter QA:** Focuses on content accuracy, completeness, formatting, and link validity instead of type safety and security scanning.

## How It Works

1. **Label detection:** Sequant checks issue labels exactly against `docs`, `documentation`, `readme` (case-insensitive equality, see [exact label matching](./exact-label-matching.md)).
2. **issueType propagation:** If matched, `SEQUANT_ISSUE_TYPE=docs` environment variable is passed to post-spec phases via `issueConfig`.
3. **QA adaptation:** The QA skill reads the env var and uses a single sub-agent instead of three.

## Recognized Labels

| Label | Detected As |
|-------|-------------|
| `docs` | Documentation |
| `documentation` | Documentation |
| `readme` | Documentation |
| `DOCS` (any case) | Documentation |

Labels are matched by exact equality (case-insensitive). A label like `docs-update` would **not** trigger the lighter QA pipeline — see [exact label matching](./exact-label-matching.md) for the rationale.

## Troubleshooting

### QA still runs 3 sub-agents on a docs issue

**Symptoms:** QA spawns type-safety, security, and scope agents.

**Solution:** This happens when running QA standalone (not via `sequant run`). The `SEQUANT_ISSUE_TYPE` env var is only set when the orchestrator manages the pipeline. Standalone `/qa` runs use the full pipeline by default.

### Spec runs even though I want to skip it for a small docs change

This is intentional behavior since #533 — spec always runs by default because docs issues frequently contain design decisions worth a spec pass. To bypass for a specific run:

```bash
sequant run 123 --phases exec,qa
```

This explicit override skips auto-detection entirely.

---

*Originally generated for Issue #451 on 2026-03-26; updated for #533 on 2026-04-24.*
