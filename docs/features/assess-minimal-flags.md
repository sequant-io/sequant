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
| Default workflow | `npx sequant run 532 -q --phases spec,exec,qa` | `npx sequant run 532 -q` |
| testgen needed | `npx sequant run 552 -q --phases spec,testgen,exec,qa` | `npx sequant run 552 -q --testgen` |
| ui-labelled (test phase auto-added) | `npx sequant run 499 -q --phases spec,exec,test,qa` | `npx sequant run 499 -q` |
| security-review | `npx sequant run 500 -q --phases spec,security-review,exec,qa` | `npx sequant run 500 -q --security-review` |

## What runs at runtime

The displayed command is human shorthand. At runtime, `phase-mapper.determinePhasesForIssue` (in `src/lib/workflow/phase-mapper.ts`) resolves phases per issue based on labels:

- Issues labelled `ui`, `frontend`, `admin`, `web`, or `browser` automatically get the `test` phase inserted before `qa`.
- The `--testgen` flag inserts `testgen` after `spec`.
- The `--security-review` flag inserts `security-review` after `spec` (idempotent — no duplicate when `auth`/`security` labels already trigger auto-detection).
- Chain commands (`--chain`) resolve phases per issue, so each issue in the chain gets its own phase list.

Example: `npx sequant run 499 -q` for a ui-labelled issue runs `spec → exec → test → qa` even though the displayed command shows no `--phases` flag.

## Markers vs displayed commands

`/assess` posts a machine-readable marker on each issue alongside the human-readable command:

```
<!-- assess:phases=spec,exec,test,qa -->
npx sequant run 499 -q
```

The marker records the **full resolved workflow** for tooling and audits. The displayed command shows only what the human needs to type. This divergence is intentional — parsers consume markers, humans copy commands.

## Troubleshooting

### The displayed command doesn't show the phases that actually run

This is intentional. Use the `<!-- assess:phases=... -->` marker (in the issue comment posted by `/assess`) to see the full resolved workflow. The marker is the source of truth for what runs.

### `--phases` is still in the command — why?

`/assess` falls back to `--phases` only for power-user / resume cases that need a bespoke phase ordering (e.g. `--phases qa,merger`). The two domain phases that have additive flags — `testgen` and `security-review` — are always preferred when the resolved workflow contains them.

---

*Generated for Issue #554 on 2026-04-28*
