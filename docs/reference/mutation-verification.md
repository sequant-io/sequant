# Mutation Verification

**Quick Start:** A gate test must fail when the thing it gates is removed. `sequant mutation` proves that by running the test: `begin` on a clean tree, apply the mutation with your own edit tools, `check` one named test, then `render` the `SEQUANT_MUTATION` marker lines for the PR body.

## Access

- **Command:** `sequant mutation <subcommand>`
- **Subcommands:** `begin`, `check`, `render`
- **State file:** `.sequant/mutations/<issue>.json` in the current worktree

## Overview

The repository's testing rule says that a gate test ships with a recorded mutation result: delete the thing the test asserts, confirm that exactly that test fails, restore, and record the result. `/qa` §6i reads the record from the PR body as a `SEQUANT_MUTATION` marker.

Done by hand, this has two problems. Restoring with `git checkout` or `git stash` has lost uncommitted work, and a hand-typed marker is no proof that the test ran. `sequant mutation` fixes both:

- The tree must be clean before the mutation, so the restore can never touch other work.
- The restore applies the captured patch in reverse. Deleted and new files are restored too.
- A record is written only after a real run in which the test failed under the mutation and passed after the restore.
- The marker is rendered from the record. It is not typed by hand.

A typical session:

```bash
sequant mutation begin --issue 1604
# Apply the mutation with your edit tools: delete the guard the test asserts.
sequant mutation check --issue 1604 --ac AC-2 \
  --test src/commands/mutation.test.ts \
  --name "mutation begin > refuses a dirty tree with exit 2 and writes no receipt" \
  --mutation "deleted the dirty-tree check in beginMutation"
sequant mutation render --issue 1604
```

Exit codes for all three subcommands: `0` for success, `2` for a refusal (the tree, the name or the result cannot be certified), `1` for an unexpected error (git or vitest could not run, or the state file is not valid).

## begin

```bash
sequant mutation begin --issue <N>
```

1. If `git status --porcelain` shows any change, `begin` exits `2` with "commit first" and lists the changed paths. It writes no file.
2. On a clean tree, it records `HEAD` and the current time in `.sequant/mutations/<N>.json`, and prints the two next steps (`check` or `render`).

Records from an earlier `begin` stay. After a commit between two gate-test ACs, run `begin` again; the records already made are kept.

## check

```bash
sequant mutation check --issue <N> --ac AC-<K> --test <file> \
  --name "<describe> > <case>" --mutation "<what you removed>"
```

| Flag | Meaning |
|------|---------|
| `--issue` | Issue number given to `begin` |
| `--ac` | The AC the test gates, as `AC-<number>` |
| `--test` | The test file, relative to the current directory |
| `--name` | The test's name, its `describe` blocks and case joined by ` > `. It is matched as a literal against the end of vitest's full name, so you can leave out leading `describe` names if the rest is unique. |
| `--mutation` | What the mutation removed or changed. Any text, including `}`, `>` and backticks. |

`check` runs these steps in order:

1. **No commit since `begin`.** If `HEAD` moved, `check` exits `2` and changes nothing. A commit made during the mutation may contain the mutation. Revert it if it does, then run `begin` again.
2. **The name resolves to exactly one test.** `npx vitest list <file> -t <name>` must list one test. Zero or two or more matches exit `2` before anything runs; the message lists every match.
3. **Capture the mutation.** `git add -A`, then `git diff --cached --binary` is saved as `.sequant/mutations/<N>.patch`. New and deleted files are in the patch. An empty patch exits `2`.
4. **Run under the mutation.** `npx vitest run <file> -t <name>` must exit non-zero, and the named test's own result must be `failed`. If the file fails to load, so that the test never runs, that does not count.
5. **Restore.** `git apply -R --index` of the patch, then `git status --porcelain` must be empty. This step runs whatever step 4 found, so the tree is never left in the mutated state.
6. **Run without the mutation.** The same run must exit `0` and the named test must be `passed`. A test that fails both ways is broken and cannot be certified.
7. **Record.** Append `{ac, test, name, mutation, mutatedExit, restoredExit, ranAt, sha}` to the state file and delete the patch.

A refusal at steps 1 to 6 leaves the state file unchanged. A refusal after step 3 leaves the patch in `.sequant/mutations/<N>.patch` so you can inspect it. `check` never runs `git checkout`, `git stash` or `git reset`.

Notes:

- All paths resolve against the worktree that contains the current directory, never the main checkout.
- `.sequant/mutations/` is never counted as a change, even in a repository that does not ignore `.sequant/`.
- A file the mutation creates in a gitignored path is not in the patch and is not removed by the restore.
- vitest runs with every `SEQUANT_*` variable removed from its environment, so an orchestrated session gets the same result as a plain shell.
- Each vitest call has a 5-minute limit.

## render

```bash
sequant mutation render --issue <N>
```

Prints one `SEQUANT_MUTATION` marker line per AC; when an AC has more than one record, the latest is used. Paste the output into your PR body or your exec `## Summary`. The lines come from `renderMutationMarker`, the same renderer the PR-body assembly uses, and `parseMutationMarkers` reads them back unchanged. `failedTest` is `<test file> > <full test name>`, so it starts with the file path, as `/qa` §6i requires.

With no state file or no records, `render` prints nothing to stdout and a note to stderr, and exits `0`.

Under `sequant run`, the orchestrator reads the same state file from the issue's worktree when it opens or updates the PR. It adds each marker that the exec summary does not already contain. Exec does not have to paste them; if it does, each marker still appears once.

## State file

`.sequant/mutations/<N>.json`:

```json
{
  "issue": 1604,
  "sha": "<HEAD when begin ran>",
  "startedAt": "2026-10-26T12:00:00.000Z",
  "records": [
    {
      "ac": "AC-2",
      "test": "src/commands/mutation.test.ts",
      "name": "mutation begin > refuses a dirty tree with exit 2 and writes no receipt",
      "mutation": "deleted the dirty-tree check in beginMutation",
      "mutatedExit": 1,
      "restoredExit": 0,
      "ranAt": "2026-10-26T12:03:10.000Z",
      "sha": "<HEAD the mutation was applied to>"
    }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `sha` (top level) | `HEAD` at the last `begin`; `check` refuses when `HEAD` differs |
| `records[].test` | Test file, relative to the worktree root |
| `records[].name` | The full vitest name of the one test that ran |
| `records[].mutatedExit` | vitest's exit code under the mutation (non-zero) |
| `records[].restoredExit` | vitest's exit code after the restore (zero) |
| `records[].sha` | `HEAD` the mutation was applied to |

`.sequant/mutations/<N>.patch` exists only after a refused `check`, and holds the mutation that was undone.

See also: [ADR-0023](../adr/0023-mutation-verification-cli.md).
