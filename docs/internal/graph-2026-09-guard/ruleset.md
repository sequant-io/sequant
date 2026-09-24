# The `main` ruleset — field by field

**Issue:** #1093 (payload + docs) · **Applied by the owner in:** #1109 (G-1)
**Script:** `scripts/ruleset-main.sh --print`

## What was wrong

Ruleset `CC` (id `12393605`) was created on 2026-02-02 and, as of Phase 0 of
this graph, read:

```json
{
  "id": 12393605,
  "name": "CC",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": [], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }],
  "bypass_actors": [],
  "current_user_can_bypass": "never"
}
```

Two defects:

1. **`conditions.ref_name.include` is `[]`** — the ruleset targeted no ref at
   all. Even the two rules it did declare protected nothing.
2. **No `required_status_checks` rule** — a PR could merge with red CI, and with
   CI that never ran against the merge state at all.

The practical consequence is on the record: PRs #1036, #1042 and #1048 (all
2026-09-10/11) each merged carrying "3 pre-existing failures, unrelated to this
diff" in the body. The failures were #1086; nobody filed it; it stopped a gate
run a week later.

## The payload

`scripts/ruleset-main.sh --print` emits the PUT body. Every field:

| Field | Value | Why |
|-------|-------|-----|
| `name` | `"CC"` | Must match the existing ruleset — this is an update of `12393605`, not a second ruleset. Two overlapping rulesets both apply, and the union is confusing to reason about. |
| `target` | `"branch"` | Unchanged. |
| `enforcement` | `"active"` | Unchanged. `"evaluate"` would log without blocking, which is the state we are leaving. |
| `bypass_actors` | `[]` | Unchanged, and deliberately empty. A bypass list is a field for excusing a failure, which is the thing this issue exists to remove. |
| `conditions.ref_name.include` | `["~DEFAULT_BRANCH"]` | Fixes defect 1. `~DEFAULT_BRANCH` rather than the literal `refs/heads/main` so the ruleset follows the default branch if it is ever renamed. |
| `conditions.ref_name.exclude` | `[]` | No carve-outs. |
| `rules[].type: deletion` | — | Preserved from the current ruleset: `main` cannot be deleted. |
| `rules[].type: non_fast_forward` | — | Preserved: `main` cannot be force-pushed. |
| `rules[].type: required_status_checks` | — | Fixes defect 2. |
| `…parameters.required_status_checks` | `[{ "context": "test" }]` | The `test` job in `.github/workflows/ci.yml` — the one that runs `npm test`. See "The context name" below. |
| `…parameters.strict_required_status_checks_policy` | `true` | The up-to-date requirement: the check must have run against the *merge state*, not against a stale head. Without it a PR branched before a breaking change still shows green. |
| `…parameters.do_not_enforce_on_create` | `false` | Branch creation is not exempt. |

## The context name

A required status check is matched **by check-run context string**. A required
context that never reports is not skipped — it is permanently pending, and under
`strict_required_status_checks_policy: true` it blocks **every** merge to `main`
until a human with admin rights edits the ruleset back. So the context string has
to be exactly right, and has to stay right.

Before #1093, the job that ran `npm test` was called `build` and carried a
single-entry matrix:

```yaml
build:
  strategy:
    matrix:
      node-version: [22.x]
```

GitHub suffixes a matrixed job's context with its matrix values, so the real
context was **`build (22.x)`** — not `build`. Requiring `build` would have
blocked `main` immediately; requiring `build (22.x)` would have worked until
someone bumped `node-version`, at which point `main` would block with no obvious
cause.

#1093 therefore renames the job to **`test`** and drops the matrix, making the
context the plain, stable string `test`. `ci.yml` carries a comment saying so.
The remaining jobs (`node-floor-guard`, `validate-skills`, `typecheck`,
`validate-plugin`) are intentionally **not** required here; `tautology-advisory`
must never be required — it is `if: github.event_name == 'pull_request'` and so
never reports on a `push` to `main` at all.

**If you rename the job or add a matrix to it**, update
`REQUIRED_CHECK_CONTEXT` in `scripts/ruleset-main.sh` and re-apply the ruleset in
the same change.

## Applying it

This is an owner action, done by hand, tracked in #1109. An agent never applies
it: `scripts/ruleset-main.sh` has `--print` as its only mode and makes no network
call.

1. Review the diff against what is live:

   ```
   scripts/ruleset-main.sh --print > /tmp/ruleset-new.json
   gh api repos/sequant-io/sequant/rulesets/12393605 > /tmp/ruleset-live.json
   diff <(jq -S . /tmp/ruleset-live.json) <(jq -S . /tmp/ruleset-new.json)
   ```

2. Apply with a `PUT` to `repos/sequant-io/sequant/rulesets/12393605`, passing
   `/tmp/ruleset-new.json` as the request body.

3. Confirm the `test` context appears as required on an open PR before walking
   away — `gh pr view <n> --json statusCheckRollup`. If it does not, revert the
   ruleset immediately; a wrong ruleset blocks every merge.

## Related

- `CLAUDE.md` § Red main — a failing `push` run on `main` is reverted first and
  debugged second.
- `scripts/settle-against-base.sh` — the mechanical proof required of any
  "pre-existing failure" claim (#1093).
- #1086 — the three failures that went a week unfiled.
