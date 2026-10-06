# Automatic PR Creation in `sequant run`

**Quick Start:** `sequant run` opens a GitHub PR as soon as exec has committed work, then updates that PR after QA. The run never merges it: merging is your call.

## Access

- **Command:** `npx sequant run <issues...>`
- **Requires:** `gh` CLI authenticated, git push access to remote
- **Added in:** v1.15.4 (fixes v1.15.3 regression)

## Usage

### Default Behavior

A passing run touches the PR twice:

```bash
npx sequant run 42
# spec → exec → PR #99 opened → qa → rebase → PR #99 updated
# ✓ #42: spec → exec → qa → PR #99
```

1. **After exec**, once the branch has commits, the run pushes and opens the PR. QA reads the PR body (acceptance-criteria table, test plan, mutation records), so the PR has to exist before QA starts. If this step fails, the run only warns and retries after QA.
2. **After QA**, the run rebases (unless `--no-rebase`), pushes, and updates the same PR with the QA result and, with `--ready-gate`, the gate report. If this step fails, the run fails (#879).

A run that halts on `SPEC_DIVERGENCE`, from spec ([ADR 0005](../adr/0005-spec-can-halt-before-exec.md)) or from exec, opens no PR.

The PR includes:
- A conventional-commit title (see [PR title convention](#pr-title-convention))
- The issue's worktree branch as the head
- A body built from exec's final output (see [What the PR body carries](#what-the-pr-body-carries))

### What the PR body carries

| Section | Source | When |
|---------|--------|------|
| `## Summary` | Exec's final `## Summary` section (capped at 4,000 characters) | Always. With no Summary, the AC table from exec's output is used instead. If neither exists, the body says `Automated PR for issue #N.` and the run prints `PR body for #N: exec output (<n> chars) has no Summary or mutation markers; using placeholder`. |
| Mutation records | Every valid `SEQUANT_MUTATION` marker in exec's final output, including markers in a code block | When exec wrote any. They are never duplicated, and they are kept on a later qa-only run (#1297). |
| `Fixes #42` | The issue number | Always. `run.prIssueLink: "refs"` or the `no-autoclose` label changes it to `Refs #42` (#1197). |
| QA note | See below | Until QA reviews the latest exec, then the latest QA verdict. |
| `## Follow-ups` | QA's `document` findings from the latest QA pass | When QA deferred anything (#1249). |
| Ready-gate report | `sequant ready` gap report | With `--ready-gate`. |

**The QA note.** Until QA has reviewed the latest exec, the body carries this line:

```text
> **QA has not run** — phases run: spec, exec. This PR has not been reviewed by sequant's QA phase; run `sequant run 42 --phases qa` before merging.
```

After QA, the line is replaced by a note for the **latest** QA verdict, or removed for `READY_FOR_MERGE` (#1245, #1246). A run that skips QA (`--phases spec,exec`) or stops before it keeps the line, so an unreviewed PR always says so.

**The follow-ups checklist.** Each item that QA deferred must end with a resolution: `filed #N`, `fixed in this PR`, or `dropped: <reason>`. A resolved item is checked. An item with no resolution is unchecked and reads `unresolved`, and QA caps its verdict at `AC_MET_BUT_NOT_A_PLUS` until it is resolved:

```markdown
## Follow-ups

- [x] Document the new flag in the run reference — filed #1350
- [ ] Windows path handling is untested — unresolved
```

**Phase agents do not edit the body.** Under `sequant run`, exec and the quality loop never change the PR's body or title. Content that must reach the PR goes in exec's final `## Summary` (#1302). If an agent edited the body, the body no longer ends with the `sequant run` trailer, and the run stops updating it (see [PR already exists](#pr-already-exists)).

### Skipping PR Creation

Use `--no-pr` to skip automatic PR creation:

```bash
npx sequant run 42 --no-pr
# spec → exec → qa → rebase → done (no PR at any point)
```

`--no-pr` skips both steps: no PR after exec and no update after QA.

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
| `--no-pr` | Skip PR creation entirely (after exec and after QA) | PR opened after exec, updated after QA |
| `--no-rebase` | Skip rebase before PR (also affects PR) | Rebase enabled |

## How It Works

1. Exec finishes with commits on the branch
2. Branch is pushed (`git push -u origin <branch>`) and the PR is opened via `gh pr create`, or updated if one already exists for the branch
3. QA runs and reads the PR body
4. Branch is rebased onto `origin/main` (unless `--no-rebase`) and pushed again
5. The PR title and body are updated with the latest QA verdict, the follow-ups checklist and, with `--ready-gate`, the gate report
6. PR info is recorded in run logs and workflow state

`sequant run` is the only thing that opens the PR during a run: the exec skill pushes the branch but doesn't create a PR itself ([ADR 0004](../adr/0004-single-pr-producer-under-orchestrator.md)).

### PR Title Convention

If the issue title already starts with a conventional-commit prefix, its type is kept and the scope becomes the issue number. Otherwise the type comes from the labels:

| Issue title | Labels | PR title |
|-------------|--------|----------|
| `docs(readme): fix typo` | any | `docs(#N): fix typo` |
| `bug: crash on empty input` | any | `fix(#N): crash on empty input` |
| `feat(api)!: drop v1` | any | `feat(#N)!: drop v1` |
| `Crash on empty input` | `bug` | `fix(#N): Crash on empty input` |
| `Add dark mode` | anything else | `feat(#N): Add dark mode` |

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

### PR body says "Automated PR for issue #N."

**Symptoms:** The PR body has no summary, and the run output has `PR body for #N: exec output (<n> chars) has no Summary or mutation markers; using placeholder`.

**Solution:** The number in the warning tells you which case you have. `0 chars` means exec wrote no final output. A large number means exec wrote output but no `## Summary` heading at the start of a line, no AC table, and no mutation markers. Before v2.20, the Claude Code, Codex and opencode drivers joined the agent's messages without a line break, so a correct `## Summary` was often missed (#1311). Upgrade, then run the issue again with exec (`sequant run N --phases exec,qa`). The run updates the same PR, because its body still ends with the `sequant run` trailer. A qa-only re-run does not help here: the summary that was missed was never stored.

### PR already exists

**Symptoms:** A PR already exists for the issue's branch, opened by an earlier run or by hand.

**Solution:** This is expected. `sequant run` updates that PR instead of opening a duplicate. It rewrites the title and body only when the body is empty or was written by `sequant run` (it ends with the `` 🤖 Generated by `sequant run` `` trailer). A body someone else wrote is left alone.

---

*Generated for Issue #322 on 2026-02-21*
