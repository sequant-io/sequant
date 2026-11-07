# The "Read first" PR comment

**Quick Start:** After QA, `sequant run` posts one comment on each PR it opens. The comment starts with `## Read first` and splits the diff into three sections: **Residue**, **Tests** and **Explained**. Read the residue in full, check the test seams, and sample the explained files.

## Access

- **Where:** a comment on the PR, posted by the orchestrator after the last QA iteration, whether QA passed or not (see ADR-0021). A `--no-pr` run or a run that ran no QA posts nothing.
- **When:** once per PR. A later run, a second QA iteration or a qa-only re-run finds the existing comment and posts nothing. A run that ran no qa posts nothing.
- **Requirements:** `gh` authenticated. If the git reads fail, the run logs a warning and posts nothing. It never posts a residue built from partial input.

Every line is computed from git, the issue body and the test files. No model writes any part of it. Each line under Residue and Tests ends with the command that produced it, so you can re-run it.

The sections come in this order: Residue, Tests, Explained, then a pointer to the QA verdict comment on the issue. The last line is a machine marker, `<!-- SEQUANT_READ_FIRST: {"pr":N,"commit":"<sha>"} -->`. The `commit` field is the head the comment describes.

## Residue

The residue lists what nothing vouches for. Read it in full.

| Line | Rule | Command shown |
|------|------|---------------|
| Unexplained file | No AC's `Evidence:` clause names the file's path | `git diff --numstat <base>...HEAD -- <path>` |
| Hot file | 3 or more `fix` commits touched it in the last 28 days of history up to the PR's base; the PR's own commits do not count. A fix commit is a subject that starts with `fix:`, `fix(` or `fix!` | `git log --since=28.days --format=%s <base> -- <path> \| grep -cE '^fix(\(\|:\|!)'` |
| Deleted or weakened test | A test file whose deleted lines outnumber its added lines | `git diff --numstat <base>...HEAD -- <path>` |
| Tautology hit | A test file with tests that call no production code | `npx tsx scripts/qa/tautology-detector-cli.ts --json` |
| Over budget | More than 400 changed non-test lines | `git diff --numstat <base>...HEAD` |

Unattributed means residue. A file is explained only when an AC's evidence names its path, either as a bare path or as a command argument. For example, `npx vitest run src/a.test.ts` names `src/a.test.ts`. A token with a directory also matches as a path suffix (`workflow/a.ts` names `src/lib/workflow/a.ts`); a bare file name such as `SKILL.md` or `index.ts` names only a root-level file, so it cannot explain every file with that name in the diff. An AC whose evidence names no path explains nothing. Its files stay in residue. When the residue is empty, the section has one line: `- none` with the numstat command.

## Tests

Each test file in the diff gets one line with its seam class:

| Class | Rule |
|-------|------|
| `prose` | The file reads a `SKILL.md`, so it asserts on markdown wording |
| `mock` | The file calls `vi.mock`, `vi.doMock` or `jest.mock` |
| `real` | Neither |

The line also names:

- Any mocked module the project does not own, such as `child_process` or a package. Relative, absolute and `#` imports count as owned.
- The AC whose `SEQUANT_MUTATION` record names the file (`failedTest` before the first `>`), or `mutation record: none`.

Commands shown: `grep -nE 'vi\.mock|jest\.mock|SKILL\.md' <path>` and `gh pr view <N> --json body`.

## Explained

Each file that an AC's evidence names is listed with the AC ids. Sample these files. You do not need to read them all, because the QA verdict already covers the ACs.

## Measuring it

| Script | What it reports |
|--------|-----------------|
| `npx tsx scripts/qa/ac-attribution-rate.ts --closed-since YYYY-MM-DD --json` | Of the ACs in issues closed since the date, how many name a path in their evidence (`acs`, `withEvidence`, `attributed`, `rate`). This uses the same parse as the comment. |
| `npx tsx scripts/qa/residue-outcomes.ts --since YYYY-MM-DD --json` | Merged PRs that carry the comment, split into `withResidue` and `emptyResidue`, each with `total` and `commentedBeforeMerge`. A reviewer comment counts when it comes after the Read-first comment and before the merge, carries no `SEQUANT_` marker, and is not from a bot. |

The outcome number lags and has confounds. If nobody reads the residue, the two groups look the same, and that result is the expected null.

## Source

- Partition (pure): `src/lib/workflow/review-residue.ts`
- Collection and post: `src/lib/workflow/review-residue.post.ts`
- Call site: `postReadFirstForPR` in `src/lib/workflow/batch-executor.ts`
- Decision record: `docs/adr/0021-review-residue-read-first.md`
