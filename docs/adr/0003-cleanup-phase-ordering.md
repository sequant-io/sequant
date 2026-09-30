# ADR-0003: Cleanup ordering via a `phase` field, not an aggregate registration

**Status:** Accepted
**Date:** 2026-09-30
**Issue:** #1222

## Context

`ShutdownManager` runs registered cleanup tasks in LIFO order on a
signal-driven shutdown. `sequant run` registers "Finalize run logs" early
(once, at startup) and a "Cleanup worktree for #N" task lazily, per worktree,
as each is created. Lazy registration always happens after the log finalizer,
so strict LIFO always runs the worktree removals *first* — the opposite of
what's needed. `cleanupWorktreeOnShutdown` force-removes a worktree with
`git worktree remove --force`, which can take longer than the outer process's
SIGKILL grace when `node_modules` is present, so a killed run can be
SIGKILLed mid-removal with the log never finalized (the bug this issue
fixes).

## Decision

Add an ordering `phase` (`"finalize" | "resource"`, default `"resource"`) to
each `CleanupTask`. `gracefulShutdown` runs every `"finalize"` task before any
`"resource"` task; within a phase, order stays LIFO. "Finalize run logs"
registers with `{ phase: "finalize" }`; worktree-removal cleanups keep their
default.

## Options

### Option A: `phase` field on `CleanupTask` (chosen)

Each cleanup task carries an ordering class. `gracefulShutdown` sorts by
phase before applying LIFO within each phase.

**Pros:** Unit-testable in `ShutdownManager` alone, independent of
`run-orchestrator.ts`'s registration order; a future caller adds a new
early-registered cleanup by name only. **Cons:** `ShutdownManager` now
encodes two ordering classes instead of pure LIFO — a small addition to its
contract.

### Option B: one early-registered aggregate "Cleanup worktrees" task

Register a single "Cleanup worktrees" task at startup, before "Finalize run
logs", and have it iterate a list `worktree-manager.ts` appends worktrees to
as they're created — rather than each worktree registering its own task
lazily.

**Pros:** No new field on `ShutdownManager`; LIFO alone would then produce
the right order for these two tasks, matching today's model exactly.
**Cons:** Changes *when* worktree cleanups are captured — `run-orchestrator.ts`
would need to build and share a mutable list with `worktree-manager.ts`
instead of registering per-worktree, a larger change to its control flow
for the same outcome, and it still leaves the ordering guarantee implicit
in registration order rather than a property either side can assert.

## Trade-offs

Option A keeps the fix inside `ShutdownManager`'s own tests and contract, at
the cost of a small enum on `CleanupTask`. Option B keeps `ShutdownManager`
unchanged but pushes a structural rework onto `run-orchestrator.ts` and
`worktree-manager.ts`, and the resulting guarantee ("early registration wins")
is exactly the assumption that caused this bug in the first place — later
lazy registrations would still race an early aggregate unless the aggregate
is *itself* proven to register before everything else, which is what phase
sorting proves without relying on order.

## Consequences

- Any future cleanup that must run before resource teardown declares
  `{ phase: "finalize" }` instead of relying on registering early.
- `CleanupTask`'s shape is now `{ name, task, phase }`; callers that construct
  one directly (none outside `shutdown.ts` today) would need updating.
- Worth revisiting if a third ordering class is ever needed — a fixed
  two-value enum was chosen over an open numeric priority because only two
  classes exist today (see the issue's Open Questions).
