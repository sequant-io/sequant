# Sequant

## Commit Rules

- Do NOT add `Co-Authored-By` lines to any commits in this repository.

## Branch protection

- `main` rejects direct pushes (ruleset `CC`, #1109: required `test` + `canary`, strict up-to-date — `GH013`). Every commit, docs included, lands through a PR; `/release` Step 6 does the same (#1131).

## Hooks

- **`HOOK_BLOCKED: Force push`** — see [.claude/skills/_shared/references/force-push.md](.claude/skills/_shared/references/force-push.md) for the user-handoff pattern. Do not attempt `CLAUDE_HOOKS_DISABLED=true` bypasses; they don't work.

## Skills

- When invoking a sequant skill via `Skill(skill: "<name>", ...)` from inside another sequant skill, qualify names that collide with Anthropic top-level skills as `Skill(skill: "sequant:<name>", ...)`. Bare colliding names silently misroute to Anthropic's version. Enforced in CI by `npm run lint:skill-calls` (`scripts/lint-skill-calls.ts`). See #562 / #568.

## Testing

- **Gate tests ship with a recorded mutation result.** A test whose job is to gate a claim — a fixture exists, a skill section is present, a flag is wired — must be mutation-verified before it counts as coverage: delete the thing it asserts, confirm exactly that test fails, restore, and record the result using the `Mutation-verified: AC-N — <mutation>; <test> failed; restored.` marker format (machine-anchored as `<!-- SEQUANT_MUTATION: {"ac":"AC-N","mutation":"...","failedTest":"<test file path> > <describe> > <case>"} -->`) in the PR body — `/qa` §6i parses and enforces this record for gate-test ACs, and it resolves only the path segment before the first `>`: a describe-block name or bare test title there classifies `test_not_in_diff` and floors the verdict at `AC_NOT_MET`. Scope file-reading assertions to the delimited region they mean to check; matching the whole file lets a doc header or comment satisfy the assertion. See #830, where deleting the injection fixture's payload left the suite green, and #939, which promoted this record from prose to a parseable gate.

## Red main

- **A failing `push` run on `main` is reverted first and debugged second.** When CI is red on `main`, the first change that lands is the revert of the commit that broke it — not a forward fix, not an investigation branch, not a "I'll have a patch in ten minutes". The revert PR references the failing run by URL, and the investigation happens afterwards on a branch off a green `main`. Rationale: every hour `main` is red, every other PR's CI is red too, so "pre-existing failure, unrelated to this diff" becomes true for everyone and the merge gate stops meaning anything — which is exactly how #1086 went a week unfiled while #1036, #1042 and #1048 shipped past it. The `main` ruleset (`scripts/ruleset-main.sh --print`, applied per `docs/internal/graph-2026-09-guard/ruleset.md`) requires the `test` check with `strict_required_status_checks_policy`, so a red `main` also blocks every merge until the revert lands. There is no field anywhere — PR body, issue comment, or template — for excusing a failure instead.
