# Stacked PRs

Build a chain of pull requests where each non-first PR targets its predecessor instead of `main`. Reviewers see the incremental diff for each issue, not the cumulative diff of the whole chain.

## Prerequisites

1. **A multi-issue chain you would already run with `--chain`** — `--stacked` inherits chain-mode's reliability profile (~29% whole-chain success rate; see [chain-mode-analysis-2026-05.md](../reference/chain-mode-analysis-2026-05.md)). Use it only for chains where `--chain` is already a sensible choice.
2. **Three or more issues for the full benefit** — a 2-issue stack renders the manifest but base-branch behavior is identical to plain `--chain` (the first PR targets `main` and the last PR also targets `main`; there is no middle PR to gain incremental diff).

## Setup

No setup required — `--stacked` is a flag on `sequant run`. It implies `--chain` automatically.

```bash
npx sequant run 100 101 102 --stacked
```

Cannot be combined with `--no-chain`:

```bash
# Errors at startup
npx sequant run 100 101 --stacked --no-chain
```

## What You Can Do

### Stack a chain of 3+ issues

```bash
npx sequant run 100 101 102 --stacked
```

| Issue | Branch | PR base |
|-------|--------|---------|
| #100 (first) | `feature/100-...` | `main` |
| #101 (middle) | `feature/101-...` | `feature/100-...` |
| #102 (last) | `feature/102-...` | `main` |

The middle PR (`#101`) shows only its incremental diff vs. `#100`. The first and last PRs target `main` so partial progress can land — you do not have to merge the whole stack atomically.

### Read the stack manifest

Every PR body includes a manifest line so reviewers see the chain:

```
Part of stack: #100 → #101 (this) → #102
```

### Merge the stack

Stacked PRs **must merge in order**: predecessor first, then dependents. GitHub auto-updates a dependent PR's base when its predecessor merges, so landing in order works without manual rebasing.

The `/merger` skill detects stacked PRs and warns when it sees them being processed out of order.

## What to Expect

- **The middle PRs are where the win shows up.** Reviewers see the incremental diff for issues 2 through N-1. The first and last PRs still show their full diff against `main`.
- **The final PR shows the cumulative diff.** Because the last branch rebases onto `main` before its PR is created (preserving `--chain` behavior and enabling partial landing), reviewers see the entire stack's diff on the final PR — not its incremental change vs. its predecessor.
- **Merging out of order will re-base the dependent PR against an unexpected commit.** Always merge predecessor first.
- **Reliability is bounded by chain-mode.** If `--chain` flakes for your workload (forensics in [chain-mode-analysis-2026-05.md](../reference/chain-mode-analysis-2026-05.md)), `--stacked` will too — it changes only the PR base, not the execution path.

## Flag Reference

| Flag | Default | Description |
|------|---------|-------------|
| `--stacked` | `false` | Non-first PRs target predecessor branch; first and last target `main`. Implies `--chain`. |
| `--chain` | `false` | Worktree N branches from worktree N-1 (structural chaining only — PRs still target `main` without `--stacked`). |
| `--no-chain` | — | Errors when combined with `--stacked`. |

## Common Workflows

### Land the stack in order

1. Run the chain: `npx sequant run 100 101 102 --stacked`.
2. Review and merge PR #100 (base: `main`).
3. GitHub auto-rebases PR #101 to target the new `main`.
4. Review and merge PR #101.
5. Repeat for PR #102.

### Drop the bottom of the stack

If PR #100 isn't going to land but #101 and #102 should, change PR #101's base to `main` in the GitHub UI before merging. The manifest line in the body will be stale — edit it or note in the PR comments.

## Troubleshooting

### My 2-issue stack looks identical to `--chain`

Expected. With `run 100 101 --stacked`, both PRs target `main` (#100 is first, #101 is last; there is no middle PR). The manifest still renders but no PR sees an incremental diff. Use `--stacked` for chains of 3 or more issues.

### `/merger` is warning about out-of-order merges

The merger skill detects stacked PRs from their manifest line and warns if you try to process them in a non-sequential order. Merge the lowest-numbered predecessor first. If the warning is wrong (e.g., manifest is stale), pass through manually — but be aware that GitHub may re-target the dependent PR's diff in unexpected ways.

### The last PR has a huge diff

Expected — the final branch rebases onto `main` before its PR is created, so it shows the cumulative diff. This is the trade for being able to land partial progress without merging the whole stack atomically. If you want every PR to show only its incremental diff, merge the stack as a single unit and don't worry about the final-PR diff width.

### `--stacked` is conflicting with `--no-chain`

These flags are mutually exclusive — `--stacked` requires chain-mode. Drop one.

## Reference

A more detailed reference (including the "What happens" table, full caveat list, and merge-order semantics) lives in [`docs/reference/run-command.md` § Stacked PRs](../reference/run-command.md#stacked-prs).

## Related

- Issue [#605](https://github.com/admarble/sequant/issues/605) — feature design and acceptance criteria
- Issue [#604](https://github.com/admarble/sequant/issues/604) — chain-mode reliability forensics
- `docs/reference/run-command.md` — full `sequant run` reference including chain-mode
- `.claude/skills/merger/SKILL.md` — merger skill's stacked-PR detection

---

*Generated for Issue #605 on 2026-05-13*
