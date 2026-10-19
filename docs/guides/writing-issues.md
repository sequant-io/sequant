# Write Issues Sequant Can Execute

Sequant checks its work against the requirements in your GitHub issue. Write them in the format below and every requirement gets planned, built, and checked off with evidence. Write them loosely and Sequant has nothing concrete to check against.

## Copy this

```markdown
## Problem

`slugify` drops accented letters: `slugify("Crème Brûlée")` returns `"cr-me-br-l-e"`.

## Acceptance Criteria

- [ ] AC-1: `slugify("Crème Brûlée")` returns `"creme-brulee"`. Evidence: a test in `test/slugify.test.js`
- [ ] AC-2: é, ü and ñ convert to e, u and n, with no new dependencies. Evidence: a test covering all three
- [ ] AC-3: The existing tests still pass. Evidence: `npm test`

## Non-Goals

- Transliterating non-Latin scripts (Cyrillic, CJK).
```

This is a real issue: [sequant-example#2](https://github.com/sequant-io/sequant-example/issues/2).

## Five rules

**1. Put each requirement under `## Acceptance Criteria` as a checkbox.** Sequant reads `- [ ]` lines in that section. A requirement written as a plain bullet or a paragraph is not read. The heading can be any level (`##`, `###`) and any case.

**2. Keep each requirement on one line.** The parser reads line by line. If a requirement wraps onto a second line, everything after the line break is dropped, including its `Evidence:`.

**3. Make each requirement checkable, and say how.** End the line with `Evidence:` and name the test, file, or command that proves it. "Works correctly" and "handles errors" can't be checked; "returns `"creme-brulee"`" can. `/spec` flags vague requirements ("should work", "fast", "edge cases", "etc.") as warnings in its plan comment. `Evidence:` is the only verification field Sequant reads, so `Verify:` or `Test:` clauses are ignored.

**4. Say what is out of scope under `## Non-Goals`.** The planning step's scope check and the ready gate read this section to keep the change from growing. One bullet per thing you don't want done.

**5. Mark related issues with `Depends on: #N`.** Start a line with `Depends on: #12` (or add a `depends-on/12` label) and a batch like `sequant run 12 13` queues #12 ahead of #13. Two things to know:

- Batches run up to 3 issues at once, so #13 can start before #12 finishes. Add `--sequential` to run them one at a time.
- Each issue branches from your base branch, so #13 never sees #12's code. If #13 needs it, merge #12's PR first and then run #13, or use `--chain`, which builds each issue on the previous one's branch.

`Blocked by #12` does not change the order; with `--chain` it only warns when the order looks wrong.

## Labels change which phases run

| Labels                                        | Phases                                        |
| --------------------------------------------- | --------------------------------------------- |
| none, `enhancement`, `feature`, `bug`, `docs` | spec → exec → qa                              |
| `ui`, `frontend`, `admin`, `web`, `browser`   | spec → exec → test → qa (adds a browser test) |
| `bug` + `auth`                                | spec → security-review → exec → qa            |

To skip planning for a small change, pass the phases yourself: `sequant run 12 --phases exec,qa`. See [Spec Phase by Default](../features/spec-by-default.md).

## Accepted formats

All of these parse to the same requirement:

```markdown
- [ ] AC-1: Returns "creme-brulee"
- [ ] **AC-1:** Returns "creme-brulee"
- [ ] **AC-1** Returns "creme-brulee"
- [ ] Returns "creme-brulee"
```

The last form, with no ID, works only under an `Acceptance Criteria` heading; Sequant numbers it for you. Checkboxes inside fenced code blocks are ignored, so you can quote examples safely.

## Common problems

| What you see                                                   | Cause                                                                                       | Fix                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The plan comment lists 0 acceptance criteria                   | Requirements are plain bullets, or the checkboxes sit under a different heading without IDs | Use `- [ ]` under `## Acceptance Criteria`                                                                              |
| A requirement is cut off mid-sentence, with no evidence        | It wrapped onto a second line                                                               | Rewrite it as one line                                                                                                  |
| QA returns `AC_NOT_MET` for something you consider done        | The requirement says more, or less, than you meant                                          | Edit the requirement line in the issue body and re-run QA (`sequant run 12 --phases qa`)                                |
| You changed your mind in a comment, but the run ignored it     | Sequant checks the work against the lines in the issue body                                 | Edit the requirement line itself                                                                                        |
| A dependent issue started before, or without, the one it needs | The dependency was written as `Blocked by` or mid-sentence, or the batch ran in parallel    | Start a line with `Depends on: #N`; merge the first issue before running the second, or pass `--sequential` / `--chain` |

## Optional: a GitHub issue form

To have every new issue start in this shape, save this as `.github/ISSUE_TEMPLATE/sequant-task.yml` in your repository:

```yaml
name: Task for Sequant
description: A change Sequant can plan, build and check
body:
  - type: textarea
    id: problem
    attributes:
      label: Problem
      description: What is wrong or missing, with a concrete example.
    validations:
      required: true
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance Criteria
      description: One checkbox per requirement, each on a single line, ending with Evidence.
      value: |
        - [ ] AC-1: <observable result>. Evidence: <test, file or command>
        - [ ] AC-2: <observable result>. Evidence: <test, file or command>
    validations:
      required: true
  - type: textarea
    id: non-goals
    attributes:
      label: Non-Goals
      description: What this change should not do.
      value: |
        - <out of scope>
```

GitHub renders each field label as a heading, so the issue body gets an `### Acceptance Criteria` section that Sequant reads. [sequant-example](https://github.com/sequant-io/sequant-example) uses this form.
