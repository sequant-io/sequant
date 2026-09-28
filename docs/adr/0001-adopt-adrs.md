# ADR-0001: Adopt Architecture Decision Records

**Status:** Accepted
**Date:** 2026-09-28
**Issue:** #1135

## Context

Sequant's design choices are recorded only where they were argued: `/spec` plan comments, PR bodies, and issue threads. `/spec`'s Design Review already asks "What's the simplest correct approach? [..., rejected alternatives]", but the answer lives in a comment on one issue and is not findable once that issue closes. Reconstructing why a module is shaped the way it is means searching closed issues.

A research pass on Anthropic's native `engineering` plugin skills (#1135) found an ADR format in `engineering:architecture` and no equivalent convention in Sequant. The same pass set a portability constraint: anything Sequant adopts must work under all three backends it drives (Claude Code, Codex, opencode), and plugin skills and MCP connectors are Claude-only.

## Decision

Record design decisions as plain-markdown ADRs in `docs/adr/`, one numbered file each, in the Status / Context / Decision / Options / Trade-offs / Consequences shape. When `/spec`'s recommended plan chooses between designs, the exec PR for that issue includes an ADR.

## Options

### Option A: Plain-markdown ADRs in `docs/adr/`, triggered by `/spec`

A README with the format, numbered files, and one sentence in `spec/SKILL.md`'s Design Review. **Pros:** readable by every backend and by humans on GitHub; no dependency; reviewed in the same PR as the code it explains. **Cons:** relies on the exec agent following the instruction; nothing mechanically enforces it yet.

### Option B: Invoke the `engineering:architecture` plugin skill

Have `/spec` or `/exec` call the native skill to produce the ADR. **Pros:** reuses a maintained template. **Cons:** Claude-only; adds a plugin dependency to every consumer project; the template is about twenty lines, cheaper to own than to depend on.

### Option C: Keep decisions in issue and PR comments

Status quo. **Pros:** zero new process. **Cons:** decisions stay scattered across closed threads, and nothing distinguishes a considered choice from an incidental one.

## Trade-offs

Option A accepts a soft trigger (a skill instruction, not a gate) in exchange for zero dependencies and full portability. Option B's template quality is not worth a Claude-only dependency when the format fits in the README. Option C costs nothing now and the most later.

## Consequences

- Easier: finding why a module is shaped the way it is; onboarding contributors; reviewing a PR against the design it claims to implement.
- Harder: exec PRs for design-choice issues carry one more file to write and review.
- Revisit: if ADRs are routinely skipped when `/spec` flagged a design choice, add a `/qa` check for them rather than more prose.
- `docs/adr/` publishes to the documentation site along with the rest of `docs/`, so ADRs must stay free of private details.
