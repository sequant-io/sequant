# ADR-0010: Phases run affected tests; CI keeps the full suite

**Status:** Proposed
**Date:** 2026-10-07
**Issue:** #1349

## Context

`npm test` runs 337 files in 6-13 minutes. The Bash tool caps a call at 600 s and the MCP watchdog kills a phase after 30 minutes without progress. Exec and qa phases died on `PHASE_TIMEOUT` running the full suite (2026-09-20, 2026-10-01). CI (`ci.yml` job `test`) already runs the full suite on every PR as a required check.

## Decision

Exec and qa run the stack's affected-tests command, the test files named in each AC's `Evidence:` command, every changed test file, and the tests that mention a changed non-test file (`grep -rlF`). The command comes from `resolveAffectedTestCommand` in `src/lib/stacks.ts`: vitest `--changed origin/main`, jest `--changedSince=origin/main`, otherwise the stack's full `commands.test`. The skills carry the text; no new CLI command.

## Options

### Option 1: Resolver in `src/lib/stacks.ts` plus skill prose (chosen)

`stacks.ts` already owns `commands.test`. `stack-config.ts` only persists `.sequant/stack.json` and holds no commands, so the issue's named location was not used.

### Option 2: A CLI command that computes the affected set (rejected)

More surface; the agent composes three commands itself.

### Option 3: Drop the full suite everywhere (rejected)

`merge-check/combined-branch-test.ts` and CI must stay full-suite.

## Consequences

`--changed` follows the static import graph and misses tests that read files through `fs`. The reverse `grep -rlF` and the AC-named files cover those; CI covers the rest. Other skills that still say `npm test` (`loop`, `fullsolve`, `test`) are a follow-up.
