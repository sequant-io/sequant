# ADR-0009: Keep the `verify` skill name; make pre-commit invocations a no-op

**Status:** Proposed (awaiting owner acceptance)
**Date:** 2026-10-06
**Issue:** #1345

## Context

Claude Code v2.1.286 tells Claude to run a project or user skill named `verify` right before committing, except for docs-only and tests-only commits. `sequant init` copies Sequant's `verify` into every project's `.claude/skills/`, so every Sequant project, exec phase agents included, now gets that nudge. `verify` takes an issue number, posts a comment with `gh issue comment`, and is a human-review step. It was not written to run before every commit.

The first measurement (#1345, from the PR's own `sequant run`): the nudge reaches `claude -p` phase agents, and the exec agent ignored it across 2 non-docs commits. Interactive sessions are not measured.

## Decision

Keep the name. Add a first section to the skill that returns a one-line no-op, doing nothing else, in three cases:

1. **A Sequant phase other than verify invoked it.** The skill runs `printenv SEQUANT_PHASE` (pre-approved in `allowed-tools`). The orchestrator sets that variable for every phase (`phase-executor.ts`). Any value other than `verify` means the commit guidance triggered it. This holds even when the agent passes its issue number.
2. **No issue number was given.**
3. **Claude called it on its own before a commit,** and nobody asked for `/verify` in the conversation. This case relies on the model's own account of why it is invoking the skill, so it is measured, not tested.

## Options

### Option 1: Rename the skill (rejected)

**Pros:** the name stops matching the rule. **Cons:** `verify` is a registered phase (`phase-registry.ts`, prompt `Run the /verify {issue} workflow`), `/qa` §11 reads its evidence, and `--phases verify` is public. A rename breaks users and needs a removal step in sync so projects do not keep a stale copy.

### Option 2: Guard pre-commit invocations (chosen)

**Pros:** no contract change for a requested `/verify <N>`; one skill file, mirrored by `sync:skills`; existing projects get it through the normal skill refresh. Case 1 is enforced by an environment check, not by wording. **Cons:** each commit can still cost one skill invocation that returns at once. Case 3 depends on model judgement.

### Option 3: Make `verify` a real pre-commit check (rejected)

**Pros:** adopts the new contract on purpose. **Cons:** it redefines `verify` and moves the evidence-posting flow elsewhere, which is a larger change than the problem needs.

### Not chosen: `disable-model-invocation: true`

Claude Code does not document whether the commit guidance respects it, and it would stop the verify phase from invoking the skill itself.

## Consequences

- The verify phase (`SEQUANT_PHASE=verify`) and a user typing `/verify <N>` are unaffected.
- `/upstream` files changelog lines that name a Sequant-shipped skill in backticks or after "named" under a separate `name-collision` category (`namesShippedItem` in `src/lib/upstream/relevance.ts`). These are high impact and always issue-worthy, but no longer share the "breaking" label. The shipped names come from the bundled `templates/skills`, resolved from the package rather than the cwd. An empty list logs a warning instead of silently disabling the rule.
