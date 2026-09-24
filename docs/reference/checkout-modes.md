# Checkout Modes

Every phase skill that changes or reviews code (`/exec`, `/qa`, `/loop`,
`/testgen`) runs in one of three checkout modes. The mode decides where the
work happens and which worktree steps the skill runs or skips.

The mode is chosen **only** by environment variables that the launcher sets.
It is never inferred from git state. A fresh clone on `main` with no
`../worktrees/` directory is still standalone unless `SEQUANT_CHECKOUT` is set.
Inferring it would reopen the failure #899 closed, where skills silently worked
in the main checkout because nothing verified the worktree.

| Mode | Entry condition | Where the work happens | What it skips |
|------|-----------------|------------------------|---------------|
| orchestrated | `SEQUANT_ORCHESTRATOR` set, `SEQUANT_CHECKOUT` unset | The worktree in `SEQUANT_WORKTREE`, checked by `sequant worktree verify` before use | Pre-flight git checks and worktree creation. The orchestrator created the worktree. |
| standalone | `SEQUANT_ORCHESTRATOR` and `SEQUANT_CHECKOUT` unset | A worktree found by `sequant worktree resolve`, or created by `/exec` with `new-feature.sh` | Nothing. |
| in-place | `SEQUANT_CHECKOUT=in-place` | A feature branch in the current clone (`$PWD`) | Worktree creation, `sequant worktree resolve` and `verify`, the `/exec` dev-server smoke test unless `SEQUANT_SMOKE=1`, and `/test`. |

## In-place mode

In-place mode is for a checkout that has no worktree to use. A claude.ai cloud
session is the motivating case: a fresh clone of `main`, with no sibling
`../worktrees/`, no `sequant` binary, and no `.claude/.local/` overrides.

### Entry

| Variable | Value | Effect |
|----------|-------|--------|
| `SEQUANT_CHECKOUT` | `in-place` | Enters in-place mode. Any other non-empty value halts the phase. |
| `SEQUANT_BASE_BRANCH` | branch name | The base branch. Defaults to `main`. |
| `SEQUANT_SMOKE` | `1` | Runs the `/exec` dev-server smoke test, which in-place mode otherwise skips. |
| `SEQUANT_WORKTREE` | (must be unset) | Setting it together with `SEQUANT_CHECKOUT=in-place` halts the phase. The two modes are mutually exclusive. |

### Per-skill behaviour

- **`/exec`.** On the base branch or a detached HEAD, it creates
  `feature/<N>-<slug>` from `origin/<base>` and checks it out. It derives the
  slug the same way `new-feature.sh` does, so `sequant worktree resolve` finds
  the branch once it is fetched into a local worktree. On any other branch it
  keeps that branch. It never runs `new-feature.sh`, `git worktree add`, or
  `sequant worktree resolve`, and it turns parallel-group isolation off.
- **`/qa`, `/loop`, `/testgen`.** They treat `$PWD` as the worktree and skip
  both the existence guard and the standalone lookup. They halt if the current
  branch is the base branch or HEAD is detached. They never create a branch.
- **All of them.** They never invoke `/test`. Its local overrides live under
  `.claude/.local/`, which is gitignored and absent from a fresh clone.

The AC loop, quality gates, mutation record, PR creation and verdict comment
are unchanged. If `SEQUANT_ORCHESTRATOR` is also set, its non-worktree
behaviours still apply, such as fewer GitHub comments.

No hook change is needed. The `pre-tool.sh` commit guard already allows commits
on a non-base branch in the main checkout.

### Example

```bash
# In a fresh clone, on main
SEQUANT_CHECKOUT=in-place claude "/exec 123"   # creates feature/123-<slug>, opens a PR
SEQUANT_CHECKOUT=in-place claude "/qa 123"     # reviews the checked-out feature branch
```

## See also

- [Worktree Isolation](../concepts/worktree-isolation.md): the worktree strategy the other two modes use
- [Run Command](run-command.md): how `sequant run` sets the orchestrated variables
