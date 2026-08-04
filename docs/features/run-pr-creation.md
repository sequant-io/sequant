# Automatic PR Creation in `sequant run`

**Quick Start:** `sequant run` now automatically creates GitHub PRs after successful QA, completing the full issue-to-PR pipeline without manual intervention.

## Access

- **Command:** `npx sequant run <issues...>`
- **Requires:** `gh` CLI authenticated, git push access to remote
- **Added in:** v1.15.4 (fixes v1.15.3 regression)

## Usage

### Default Behavior

PRs are created automatically after all phases pass:

```bash
npx sequant run 42
# spec → exec → qa → rebase → PR created
# ✓ #42: spec → exec → qa → PR #99 (45.2s)
```

The PR includes:
- Title with conventional commit prefix (`feat(#42): ...` or `fix(#42): ...`)
- Body with issue summary and `Fixes #42` for auto-close
- Branch set to the feature worktree branch

### Skipping PR Creation

Use `--no-pr` to skip automatic PR creation:

```bash
npx sequant run 42 --no-pr
# spec → exec → qa → rebase → done (no PR)
```

Useful when:
- You want to review changes before creating the PR manually
- You're running a dry-run or exploratory workflow
- Your team uses a different PR creation process

### Multiple Issues

PR creation works across all execution modes:

```bash
# Sequential — one PR per issue
npx sequant run 42 43 44 --sequential

# Parallel — PRs created after each issue completes
npx sequant run 42 43 44

# Batch — PRs created per batch
npx sequant run --batch "42 43" --batch "44"
```

## Options & Settings

| Option | Description | Default |
|--------|-------------|---------|
| `--no-pr` | Skip PR creation after successful QA | PR created |
| `--no-rebase` | Skip rebase before PR (also affects PR) | Rebase enabled |

## How It Works

1. All phases (spec, exec, qa) complete successfully
2. Branch is rebased onto `origin/main` (unless `--no-rebase`)
3. Branch is pushed to remote (`git push -u origin <branch>`)
4. Existing PR is detected (reuses if found)
5. New PR is created via `gh pr create`
6. PR info is recorded in run logs and workflow state

### PR Title Convention

The PR title prefix is derived from issue labels:

| Issue Label | PR Title Prefix |
|-------------|----------------|
| `bug` | `fix(#N): <title>` |
| Any other | `feat(#N): <title>` |

### Run Log Output

PR info appears in the summary and structured run logs:

```
Results: 1 passed, 0 failed
  ✓ #42: spec → exec → qa → PR #99 (45.2s)
```

Run logs include `prNumber` and `prUrl` fields for programmatic access.

## Troubleshooting

### Run fails with a PR-creation error

**Symptoms:** All phases pass but the run is reported as **failed** with a
`prCreationError` (e.g. `git push failed: permission denied`) in the output and
run log.

**Solution:** Check that `gh` CLI is authenticated (`gh auth status`), your git
credentials and remote URL are valid (`git remote -v`), and you have push
access. Since #879, a failed push or PR creation **fails the run** instead of
silently succeeding without a PR — the phase work is preserved on the issue
branch, so fixing credentials and re-running picks it up. Only `--no-pr`
legitimately skips PR creation without failing.

### PR already exists

**Symptoms:** Run detects an existing PR and reuses it instead of creating a new one.

**Solution:** This is expected behavior. If a PR already exists for the branch, `sequant run` returns its info rather than creating a duplicate.

---

*Generated for Issue #322 on 2026-02-21*
