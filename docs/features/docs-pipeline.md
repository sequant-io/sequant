# Lighter Documentation Pipeline

When a GitHub issue has documentation labels (`docs`, `documentation`, or `readme`), Sequant automatically uses a lighter workflow pipeline optimized for docs-only work.

## Prerequisites

1. **Sequant installed** — `npx sequant --version`
2. **GitHub issue with a docs label** — one of: `docs`, `documentation`, `readme`

## What Changes

Documentation issues get a streamlined two-phase pipeline instead of the standard three-phase pipeline:

| Issue Type | Pipeline | Phases |
|------------|----------|--------|
| Standard | spec → exec → qa | 3 phases |
| Bug fix | exec → qa | 2 phases (skips spec) |
| **Documentation** | **exec → qa** | **2 phases (skips spec)** |

Additionally, the QA phase adapts when running on docs issues:

| QA Behavior | Standard Issues | Docs Issues |
|-------------|-----------------|-------------|
| Type safety check | Yes (sub-agent) | Skipped |
| Security scan | Yes (sub-agent) | Skipped |
| Scope/size check | Yes (sub-agent) | Yes (1 sub-agent) |
| Sub-agents spawned | 3 | 1 |

## Setup

No configuration needed. The lighter pipeline activates automatically when `autoDetectPhases` is enabled (the default).

To verify auto-detection is on:

```bash
cat .sequant/settings.json | grep autoDetectPhases
# Expected: "autoDetectPhases": true
```

## What You Can Do

### Run a documentation issue through the lighter pipeline

```bash
sequant run 123
```

If issue `#123` has a `docs`, `documentation`, or `readme` label, Sequant will:
1. Skip the spec phase entirely
2. Run exec (implementation)
3. Run QA with a single sub-agent focused on scope/size and link validation

### Verify detection is working

Look for this log line during execution:

```
Docs issue detected: exec → qa
```

If you see `Running spec to determine workflow...` instead, the issue labels may not include a docs label.

## What to Expect

- **Faster runs:** ~30-50% faster due to skipping spec and running fewer QA sub-agents
- **Same exec behavior:** The implementation phase runs identically
- **Lighter QA:** Focuses on content accuracy, completeness, formatting, and link validity instead of type safety and security scanning
- **No spec output:** Since spec is skipped, there's no spec plan comment on the issue

## How It Works

1. **Label detection:** Sequant checks issue labels against `docs`, `documentation`, `readme` (case-insensitive)
2. **Phase shortcut:** If matched, phases are set to `["exec", "qa"]` — same pattern as bug fixes
3. **Metadata propagation:** `SEQUANT_ISSUE_TYPE=docs` environment variable is passed to skills
4. **QA adaptation:** The QA skill reads the env var and uses a single sub-agent instead of three

## Recognized Labels

| Label | Detected As |
|-------|-------------|
| `docs` | Documentation |
| `documentation` | Documentation |
| `readme` | Documentation |
| `DOCS` (any case) | Documentation |

Labels are matched case-insensitively via substring. A label like `docs-update` would also trigger the lighter pipeline.

## Troubleshooting

### Issue runs full pipeline despite having a docs label

**Symptoms:** Log shows `Running spec to determine workflow...` instead of `Docs issue detected`

**Solution:** Verify `autoDetectPhases` is enabled in `.sequant/settings.json`. If set to `false`, explicit phases override label detection:

```bash
jq '.run.autoDetectPhases' .sequant/settings.json
# Should output: true
```

### QA still runs 3 sub-agents on a docs issue

**Symptoms:** QA spawns type-safety, security, and scope agents

**Solution:** This happens when running QA standalone (not via `sequant run`). The `SEQUANT_ISSUE_TYPE` env var is only set when the orchestrator manages the pipeline. Standalone `/qa` runs use the full pipeline by default.

---

*Generated for Issue #451 on 2026-03-26*
