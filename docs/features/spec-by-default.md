# Spec Phase by Default

Since [#533](https://github.com/sequant-io/sequant/issues/533), Sequant runs the `spec` phase for every issue by default — including bug fixes and documentation issues that previously short-circuited to `exec → qa`. Use this page to understand the new default and how to opt out for individual runs.

## Prerequisites

1. **Sequant installed** — `npx sequant --version` (must be a build that includes #533)
2. **`autoDetectPhases` enabled** in `.sequant/settings.json` — `jq '.run.autoDetectPhases' .sequant/settings.json` should print `true`

## What Changed

| Issue Labels | Before #533 | After #533 |
|--------------|-------------|------------|
| `bug`, `fix`, `hotfix`, `patch` | `exec → qa` | `spec → exec → qa` |
| `docs`, `documentation`, `readme` | `exec → qa` | `spec → exec → qa` |
| `enhancement`, `feature`, none | `spec → exec → qa` | `spec → exec → qa` (unchanged) |
| `ui`, `frontend`, `admin`, `web`, `browser` | `spec → exec → test → qa` | `spec → exec → test → qa` (unchanged) |
| `bug` + `auth` | `spec → security-review → exec → qa` | `spec → security-review → exec → qa` (unchanged — `bug` no longer adds a competing rule) |

The change applies at two layers:

- **`/assess` skill recommendation** — the recommendation table and example output now show `spec → exec → qa` for bug/docs issues.
- **`sequant run --auto-detect` runtime** — `phase-mapper.detectPhasesFromLabels` and `batch-executor`'s auto-detect branch always include `spec` unless explicitly overridden.

Spec is only skipped automatically when a prior `spec` phase marker already exists on the issue (resume case).

## Why

Real-world batch assessments showed that bug- and docs-labeled issues frequently contain meaningful design decisions — scope boundaries, edge cases, test-strategy shifts — that the spec pass exists to catch. Earlier compression of the `/spec` skill (#515) made the per-phase cost small enough that universal inclusion is the better default.

## What You Can Do

### Run with the new default

```bash
sequant run 123
```

If issue `#123` has a `bug` or `docs` label, Sequant now runs `spec → exec → qa` instead of going straight to exec.

### Opt out for one run

Pass explicit `--phases` to bypass auto-detection entirely:

```bash
sequant run 123 --phases exec,qa
```

### Opt out via the assess workflow

`/assess` will recommend `spec → exec → qa` by default. If you want to override before running, edit the `Commands:` block it produces:

```bash
# Default (assess recommends):
npx sequant run 123 -q

# Override:
npx sequant run 123 -q --phases exec,qa
```

### When spec is automatically skipped

Spec is skipped only when a prior `spec` phase marker already exists in the issue's GitHub comments (i.e., spec ran in a previous session). The marker looks like:

```html
<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed",...} -->
```

This preserves the resume-friendly `◂ exec → qa` behavior in `/assess` output.

## What to Expect

- **Bug/docs runs are slower** by approximately one spec cycle (~30–90s depending on issue complexity).
- **Spec output is now posted to the issue** for bug/docs issues that previously had no spec comment.
- **Docs issues still get the lighter QA pipeline** — see [Lighter QA Pipeline for Documentation Issues](./docs-pipeline.md). Only the QA phase is lighter; the workflow itself is the same as other issues.
- **`/assess` batch output reflects the new default** — bug/docs rows in the `Run` column now show `spec → exec → qa`. Resume cases (`◂ exec → qa`) still appear when a prior spec marker exists.

## Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `run.autoDetectPhases` | `boolean` | `true` | When true, label-based phase detection runs. Set to `false` to require explicit `--phases` on every invocation. |
| CLI flag `--phases <list>` | comma-separated | (auto-detect) | Bypasses auto-detection for one run. Example: `--phases exec,qa`. |

| Detection function | Location | Returns |
|--------------------|----------|---------|
| `detectPhasesFromLabels(labels)` | `src/lib/workflow/phase-mapper.ts` | `{ phases: Phase[], qualityLoop: boolean }` — always includes `spec` unless UI workflow applies |
| Auto-detect branch | `src/lib/workflow/batch-executor.ts` | Runs spec first, then uses spec output to determine remaining phases |

## Troubleshooting

### My bug fix was instant before; now it pauses for spec

This is the expected new default. Bypass for a single run:

```bash
sequant run <issue> --phases exec,qa
```

If you want to make this permanent for a class of issues, the override needs to be passed each time — there is no `bug → skip-spec` setting since #533. Consider adding a hook or shell alias if you frequently run trivial fixes.

### `/assess` recommends `spec → exec → qa` but I want `exec → qa`

Edit the `Commands:` line in the `/assess` output before running, or invoke `sequant run` directly with `--phases exec,qa`. `/assess` is read-only; nothing is committed by its recommendation.

### I see `◂ exec → qa` in `/assess` output for a bug issue

This means a prior `spec` phase marker exists on the issue (resume case). Spec runs once per issue lifetime when `autoDetectPhases` is on; subsequent runs reuse the prior spec via the `◂` resume symbol.

## Related Documentation

- [Workflow Phases](../concepts/workflow-phases.md) — Label → Phases mapping table
- [Exact Label Matching](./exact-label-matching.md) — How `BUG_LABELS` / `DOCS_LABELS` are matched (now metadata-only)
- [Lighter QA Pipeline for Documentation Issues](./docs-pipeline.md) — Docs issues still get the lighter QA flow

---

*Generated for Issue #533 on 2026-04-25*
