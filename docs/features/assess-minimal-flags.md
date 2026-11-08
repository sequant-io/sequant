# /assess: Minimal Command Flags

`/assess` emits the shortest correct `npx sequant run` command for each issue. This page explains the output rules so you know what to expect — and what the displayed command actually resolves to at runtime.

## What you see

`/assess` follows three rules when generating example commands:

1. **Omit `--phases` for the default workflow.** When the resolved phases equal the CLI default (registered at `bin/cli.ts:186`, defined as `DEFAULT_PHASES` in `src/lib/workflow/types.ts`), the flag is dropped.
2. **Prefer additive flags over restating the phase list.** Additive flags: `--testgen` and `--security-review` (registered at `bin/cli.ts:208-209`). Use them instead of `--phases spec,testgen,exec,qa` or `--phases spec,security-review,exec,qa`.
3. **Keep `--phases` when no additive flag exists.** Power-user workflows that need bespoke phase orderings still fall back to `--phases`.

## Examples

| Issue type | Old display | New display |
|------------|-------------|-------------|
| Default workflow | `npx sequant run 532 -Q --phases spec,exec,qa` | `npx sequant run 532 -Q` |
| testgen needed | `npx sequant run 552 -Q --phases spec,testgen,exec,qa` | `npx sequant run 552 -Q --testgen` |
| ui-labelled | `npx sequant run 499 -Q --phases spec,exec,test,qa` | `npx sequant run 499 -Q` (since #1649 this no longer runs `test`; add `--phases spec,exec,test,qa` to get it) |
| security-review | `npx sequant run 500 -Q --phases spec,security-review,exec,qa` | `npx sequant run 500 -Q --security-review` |

## What runs at runtime

The displayed command is human shorthand. At runtime, `phase-mapper.determinePhasesForIssue` (in `src/lib/workflow/phase-mapper.ts`) resolves phases per issue based on labels:

- A UI label (`ui`, `frontend`, `admin`, `web`, `browser`) no longer adds the `test` phase to a phase list (#1649, closing #1631). Ask for it by name with `--phases spec,exec,test,qa`. In auto-detect mode (`run.autoDetectPhases`), a UI label still selects the UI workflow, which includes `test`.
- The `--testgen` flag inserts `testgen` after `spec`.
- The `--security-review` flag inserts `security-review` after `spec` (idempotent — no duplicate when `auth`/`security` labels already trigger auto-detection).
- Chain commands (`--chain`) resolve phases per issue, so each issue in the chain gets its own phase list.

Example: `npx sequant run 499 -Q` for a ui-labelled issue runs `spec → exec → qa`. The `/assess` shorthand still omits `--phases` for these issues. That is skill text, outside graph-2026-11-simplify's I-1 scope, and is tracked on #1649.

## Markers vs displayed commands

`/assess` posts a machine-readable marker on each issue alongside the human-readable command:

```
<!-- assess:phases=spec,exec,test,qa -->
npx sequant run 499 -Q
```

The marker records the **full resolved workflow** for tooling and audits. The displayed command shows only what the human needs to type. This divergence is intentional — parsers consume markers, humans copy commands.

## Troubleshooting

### The displayed command doesn't show the phases that actually run

This is intentional. Use the `<!-- assess:phases=... -->` marker (in the issue comment posted by `/assess`) to see the full resolved workflow. The marker is the source of truth for what runs.

### `--phases` is still in the command — why?

`/assess` falls back to `--phases` only for power-user / resume cases that need a bespoke phase ordering (e.g. `--phases qa,merger`). The two domain phases that have additive flags — `testgen` and `security-review` — are always preferred when the resolved workflow contains them.

---

*Generated for Issue #554 on 2026-04-28*
