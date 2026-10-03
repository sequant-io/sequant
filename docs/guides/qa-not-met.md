# When QA Says AC_NOT_MET

QA compared the work with the issue's acceptance criteria, and at least one is not met. This is normal. In Sequant's own repository, 25 issues got `AC_NOT_MET` between September 10 and October 1, 2026. The run logs show a pull request for 20 of them. This guide shows how to get from the verdict to a passing QA run.

## The four verdicts

| Verdict                 | Meaning                                                                            | What to do                                           |
| ----------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `READY_FOR_MERGE`       | All criteria are met and the review found nothing to improve.                      | Review the PR and merge it.                          |
| `AC_MET_BUT_NOT_A_PLUS` | All criteria are met. The review has suggestions.                                  | Merge, or act on the suggestions first.              |
| `NEEDS_VERIFICATION`    | The code looks right, but a check needs a person (a real API, a device, a deploy). | Do the check, then run `sequant run 42 --phases qa`. |
| `AC_NOT_MET`            | At least one criterion is not met.                                                 | Follow this guide.                                   |

## Step 1: Read the findings

QA posts two comments on the issue. The first, `QA Review`, has a table with the status of each criterion. The second starts with `QA Verdict: AC_NOT_MET` and lists each gap under **Gaps**. Read the gaps before you change anything. They tell you which of the paths below applies.

To find the branch and the worktree that hold the work:

```bash
sequant status 42
```

The output shows the worktree path, the phases that ran, and the PR. The worktree stays on disk after `AC_NOT_MET`, so you can open it and look at the code.

## Step 2: Pick a path

| The gap says                                                                    | Path                                               |
| ------------------------------------------------------------------------------- | -------------------------------------------------- |
| The code is wrong, and the fix is small and clear                               | [A. Fix it yourself](#a-fix-it-yourself)           |
| The code is wrong, and the fix is larger or unclear                             | [B. Let Sequant fix it](#b-let-sequant-fix-it)     |
| The criterion asks for the wrong thing, or for something that cannot be checked | [C. Change the criterion](#c-change-the-criterion) |

### A. Fix it yourself

This is the fastest path when the gap is specific.

1. Open the worktree from `sequant status 42`.
2. Make the fix and commit it to the issue's branch.
3. Run QA again, and only QA:

```bash
sequant run 42 --phases qa
```

You do not need `--force`. An issue with `AC_NOT_MET` is still in progress, so Sequant does not skip it.

### B. Let Sequant fix it

Run the build phase and QA again:

```bash
sequant run 42 --phases exec,qa
```

Add `-Q` (the quality loop) to let Sequant retry by itself. After each failed QA, it runs `/loop` to fix the gaps, then runs QA again, up to 3 times:

```bash
sequant run 42 --phases exec,qa -Q
```

If the same gap comes back after a retry, stop and use path A or C. A repeated gap usually means the criterion is unclear, not that the code needs one more attempt.

### C. Change the criterion

Sometimes QA is right about the gap, but the criterion asks for the wrong thing. For example, it asks for a check that cannot pass, or it describes a design you have since changed.

1. Edit the criterion line in the issue body. Keep it on one line, and end it with `Evidence:`.
2. If the code must change too, commit that change to the issue's branch.
3. Run `sequant run 42 --phases qa`.

Edit the line itself. A comment that says "ignore AC-3" or "we decided X" does not change what QA checks, because QA reads the criteria from the issue body. See [Write Issues Sequant Can Execute](writing-issues.md).

## Two real recoveries

**[#1100](https://github.com/sequant-io/sequant/issues/1100): fixed by hand.** The run `exec → qa` got `AC_NOT_MET` two times. The maintainer committed a fix to the issue's branch. The next run was QA only (`--phases qa`), which passed and opened [PR #1102](https://github.com/sequant-io/sequant/pull/1102).

**[#1094](https://github.com/sequant-io/sequant/issues/1094): code and criterion both changed.** The first run got `AC_NOT_MET`. A QA-only re-run also got `AC_NOT_MET`. Then the maintainer committed two fixes and edited the criteria in the issue body at the same times. The next QA-only run passed and opened [PR #1128](https://github.com/sequant-io/sequant/pull/1128).

In both cases the passing run was QA only. Neither issue needed a full re-run.

## Known issue: the recorded verdict

After a quality loop, three places can show the first QA verdict instead of the last one ([#1245](https://github.com/sequant-io/sequant/issues/1245)). They are `sequant status`, the QA note in the PR body, and the MCP result. Until #1245 closes, use the most recent `QA Verdict` comment on the issue as the result.

## Get fewer AC_NOT_MET results

- Write criteria that can be checked, one per line, each with `Evidence:`. See [Write Issues Sequant Can Execute](writing-issues.md).
- Add `-Q` to `sequant run` for issues where a small miss is likely.
- Add `--ready-gate` to run extra QA rounds before the PR. See [Run Ready Gate](../features/run-ready-gate.md).
