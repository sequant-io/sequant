# Sequant

## Commit Rules

- Do NOT add `Co-Authored-By` lines to any commits in this repository.

## Hooks

- **`HOOK_BLOCKED: Force push`** — see [.claude/skills/_shared/references/force-push.md](.claude/skills/_shared/references/force-push.md) for the user-handoff pattern. Do not attempt `CLAUDE_HOOKS_DISABLED=true` bypasses; they don't work.

## Skills

- When invoking a sequant skill via `Skill(skill: "<name>", ...)` from inside another sequant skill, qualify names that collide with Anthropic top-level skills as `Skill(skill: "sequant:<name>", ...)`. Bare colliding names silently misroute to Anthropic's version. Enforced in CI by `npm run lint:skill-calls` (`scripts/lint-skill-calls.ts`). See #562 / #568.

## Testing

- **Gate tests ship with a recorded mutation result.** A test whose job is to gate a claim — a fixture exists, a skill section is present, a flag is wired — must be mutation-verified before it counts as coverage: delete the thing it asserts, confirm exactly that test fails, restore, and record the result in the commit message or PR body. Scope file-reading assertions to the delimited region they mean to check; matching the whole file lets a doc header or comment satisfy the assertion. See #830, where deleting the injection fixture's payload left the suite green.
