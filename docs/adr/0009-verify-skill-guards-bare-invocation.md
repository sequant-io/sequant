# ADR-0009: Keep the `verify` skill name; make a bare `/verify` a no-op

**Status:** Accepted
**Date:** 2026-10-06
**Issue:** #1345

## Context

Claude Code v2.1.286 tells Claude to run a project or user skill named `verify` right before committing, except for docs-only and tests-only commits. `sequant init` copies Sequant's `verify` into every project's `.claude/skills/`, so every Sequant project, exec phase agents included, now gets that nudge. `verify` takes an issue number, posts a comment with `gh issue comment`, and is a human-review step. It was not written to run before every commit.

## Decision

Keep the name. Add a first section to the skill, placed right after the local-override line and before the body, that makes an invocation with no issue number return one line and do nothing: no command, no file read, no comment, no question.

## Options

### Option 1: Rename the skill (rejected)

**Pros:** the name stops matching the rule. **Cons:** `verify` is a registered phase (`phase-registry.ts`, prompt `Run the /verify {issue} workflow`), `/qa` §11 reads its evidence, and `--phases verify` is public. A rename breaks users and needs a removal step in sync so projects do not keep a stale copy.

### Option 2: Guard the bare invocation (chosen)

**Pros:** no contract change when an issue number is given; one skill file, mirrored by `sync:skills`; existing projects get it through the normal skill refresh. **Cons:** each commit still costs one skill invocation that returns at once.

### Option 3: Make `verify` a real pre-commit check (rejected)

**Pros:** adopts the new contract on purpose. **Cons:** it redefines `verify` and moves the evidence-posting flow elsewhere, which is a larger change than the problem needs.

## Consequences

- Phase prompts always pass an issue number, so they are unaffected.
- `/upstream` now flags changelog lines that name a Sequant-shipped skill in backticks or after "named" (`namesShippedItem` in `src/lib/upstream/relevance.ts`), so this class is not filed as No Action again. The shipped names come from `templates/skills`.
