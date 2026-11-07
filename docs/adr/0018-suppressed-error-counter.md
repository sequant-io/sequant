# ADR-0018: Dropped errors are counted by a module-level counter that the run log persists

**Status:** Proposed
**Date:** 2026-10-19
**Issue:** #1504

## Context

The run path drops many errors on purpose. `batch-executor.ts` had 25 empty `catch` blocks, each with a comment such as "State tracking errors shouldn't stop execution" or "progress errors must not halt". The policy is right: a run should not die because a status write or a progress callback failed. But a dropped error left no line and no count. When `.sequant/state.json` drifted, nothing recorded why, and `reconcile.ts` repaired the symptoms without a cause. #1469 had the same shape one layer down (a failed `git worktree add` was absorbed), and its fix added a side-channel so the caller could learn what happened.

## Decision

`src/lib/workflow/suppressed.ts` holds a per-run counter. `noteSuppressed(scope, err, context?)` increments the count for one of five scopes (`state`, `progress`, `cleanup`, `platform`, `other`), writes one debug line to an optional sink, and never throws. `LogWriter.initialize()` resets the counter and sets the sink (stderr, only when verbose). `LogWriter.finalize()` writes the counts into the run log as an optional `suppressed: { total, byScope }` field, so the schema stays `version: 1`. Every catch site keeps its behaviour and adds one call.

## Options

### Option A: Module-level counter, reset by `LogWriter` (chosen)

The call sites import one function and call it with no handle. **Pros:** the call is one line at every site; it works when `logWriter` is `null` (logging disabled); concurrent issues in one run share one count, which is what "per run" means. **Cons:** global state. Two runs in one process would share it.

### Option B: A counter on the `LogWriter` instance, passed to each site

**Pros:** no global state. **Cons:** each of the 25 sites would need `logWriter?.noteSuppressed(…)`, and a run with logging disabled would count nothing. Sites outside `runIssueWithLogging` (such as `withActivityHook`) have no `logWriter` in scope, so the handle would have to be threaded through more signatures.

## Trade-offs

Option A wins because one process runs one `sequant run`: the CLI is one run per process, and the MCP server spawns `sequant run` as a subprocess. The global is reset at the one place a run starts (`LogWriter.initialize()`), and the unit tests assert the reset. Option A gives up isolation between two runs in the same process, which no caller does today.

## Consequences

- Easier: converting the remaining empty catches elsewhere in `src/` is one import and one line per site.
- Easier: a run log now says how many errors were dropped and in which scope; `total: 0` means "counted, none dropped", and an absent field means an older log.
- Harder: a future in-process caller that runs two runs at once would need the counter moved onto a run object.
- Revisit when `sequant logs` and the MCP logs tool display the count, and if any caller starts running more than one run per process.
