# Architecture Decision Records

An Architecture Decision Record (ADR) captures one design choice: the forces behind it, the options weighed, and what the choice makes easier or harder. ADRs live here, one file per decision, numbered in order: `NNNN-short-title.md`.

## When to write one

`/spec`'s Design Review flags any plan that **chooses between designs** — it presents options, or names a rejected alternative. The exec PR for that issue then adds an ADR here. Write one by hand, too, for any decision a future contributor would otherwise have to reconstruct from issue threads.

Skip it for choices with one obvious answer, or for decisions an existing ADR already covers (link that ADR in the PR instead).

## Format

Copy this skeleton into `docs/adr/NNNN-short-title.md`, taking the next free number:

```markdown
# ADR-NNNN: Title

**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-NNNN
**Date:** YYYY-MM-DD
**Issue:** #N

## Context

What situation forces a decision? Constraints, evidence, and what breaks if nothing changes.

## Decision

The change being made, stated in one or two sentences.

## Options

### Option A: Name

What it is. **Pros:** … **Cons:** …

### Option B: Name

Same shape. Include the option that was chosen.

## Trade-offs

Why the chosen option wins on the dimensions that matter here, and what it gives up.

## Consequences

- What becomes easier
- What becomes harder
- What to revisit, and when
```

## Rules

- **Immutable once accepted.** To change a decision, write a new ADR and mark the old one `Superseded by ADR-NNNN`. Fix typos freely; do not rewrite history.
- **Plain markdown only.** No plugin, template engine, or tool is required to read or write an ADR, so they work the same under Claude Code, Codex, and opencode.
- **Public.** This repository is public and `docs/` is published to the documentation site. Do not include credentials, local paths, private repository names, or personal contact details.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-adopt-adrs.md) | Adopt Architecture Decision Records | Accepted |
| [0002](0002-spec-stays-in-main-checkout.md) | Spec stays in the main checkout; check it instead | Accepted |
| [0003](0003-cleanup-phase-ordering.md) | Cleanup ordering via a `phase` field, not an aggregate registration | Accepted |
| [0004](0004-single-pr-producer-under-orchestrator.md) | The orchestrator is the only PR producer under `sequant run` | Accepted |
| [0005](0005-spec-can-halt-before-exec.md) | Spec can halt the run before exec | Accepted |
| [0006](0006-slim-plugin-folder.md) | Ship a slim `plugin/` folder as the marketplace source | Accepted |
| [0007](0007-followup-resolution-as-description-suffix.md) | A deferred QA finding carries its resolution as a description suffix | Accepted |
| [0008](0008-retire-root-plugin-mirrors.md) | Retire the root `skills/` and `hooks/` copies; one owner for the skill mirror list | Accepted |
| [0009](0009-verify-skill-guards-bare-invocation.md) | Keep the `verify` skill name; make pre-commit invocations a no-op | Accepted |
| [0012](0012-phase-skills-from-installed-package.md) | Phase agents load skills from the installed package; committed skills become an override | Proposed |
