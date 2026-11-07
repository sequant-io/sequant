# ADR-0020: `runIssueWithLogging` runs as same-file stage functions that share an explicit env/state pair

**Status:** Proposed
**Date:** 2026-10-21
**Issue:** #1507

## Context

`runIssueWithLogging` in `src/lib/workflow/batch-executor.ts` was one function of 1,620 lines (1,072 counted by `max-lines-per-function`). It held the setup, the spec phase, the phase plan, the quality loop with its ladder and /loop retry, the ready gate, the checkpoint, the rebase and the PR. Its file had 23 commits in 31 days, and a fix to a function that size cannot be reviewed as one unit. Fifteen test files call the function, and they mock the modules it imports with `vi.mock`. The split had to change no test (I-3) and no behaviour, log wording included.

## Decision

The function is split into module-private stage functions in the same file: `initIssueRun`, `runSpecStage` (`dispatchSpecPhase`, `recordSpecOutcome`, `resolvePhasesFromSpec`), `finalizePhasePlan`, `runQualityLoop` (`runPhaseStep`, `dispatchLoopPhase`, `recordLoopPhaseOutcome`, `logLoopPhaseResult`, `handlePhaseFailure`, `runLoopFixPhase`, `assessIterationProgress`), `settleIssueStatus` and `deliverIssueBranch`. The former closures `openOrUpdatePR`, `makeWaitTransition` and `buildBundle` become module functions. `runIssueWithLogging` is now a short sequence of stage calls.

The stages share two objects, passed as arguments:

- `IssueRunEnv` is read-only and built once: the context, the worktree path and branch, the start time, the auto-wait ledger, `log`/`warn`, the per-issue config and the relay activation.
- `IssueRunState` is mutable and per call: the phase results, the resume handle, the phase list, the halt flags, the divergence bundle and the ladder state.

Each former `break` or early `return` is now a value the caller checks on the next line. `runPhaseStep` returns `"next" | "break"`, `dispatchLoopPhase` returns `null` for the top-of-ladder halt, and the spec stage and `initIssueRun` return the halting `IssueResult`. Each `noteSuppressed` label moves with its catch, unchanged.

## Options

### Option A: Same-file stage functions with an env/state pair (chosen)

**Pros:** every `vi.mock` keeps resolving, because the imports do not move. Nothing new is exported, so knip has nothing to flag and the export list is unchanged. The diff is a mechanical move along the stage boundaries that the code comments already marked. **Cons:** the file stays long (about 3,200 lines). The `state` object is a bag of mutable fields that any stage can write.

### Option B: An `IssueRunner` class

**Pros:** `this` replaces the two arguments. **Cons:** a larger diff that turns every local into a `this.` field and changes no behaviour, and the class is constructed once per call anyway.

### Option C: Stage modules under `src/lib/workflow/batch-executor/`

**Pros:** shorter files. **Cons:** the stages need exports that knip counts as unused, and a test that mocks a module `batch-executor.ts` imports would also have to reach the new module. That is a test change, which I-3 forbids.

### Option D: A generic stage pipeline or registry

**Cons:** indirection with one caller.

## Trade-offs

Option A gives up a shorter file. In return, no test changes and the export surface stays the same. Signals instead of exceptions keep today's `try`/`catch` and `finally` semantics, because no new throw can reach an existing catch. The mutable `state` is per call and passed explicitly, so two concurrent issue runs (parallel mode) never share it.

## Consequences

- Easier: a fix to one stage is a diff to one function of at most 200 counted lines, and `max-lines-per-function` now holds for the whole file.
- Easier: the spec and loop paths share `buildPhaseErrorContext`, `phaseLogStatus` and `persistResumeHandle` where their output was already byte-identical. Spec's run-log entry still omits the diff stats, commit hash and verdict, as before.
- Harder: control flow crosses function boundaries. A reader must follow `"break"` and `null` back to the loop that acts on them.
- #1508 applied the same pattern to the rest of `src/lib/workflow`: `RunOrchestrator.run`, `ensureWorktree`, `executePhase`, `executePhaseWithRetry`, `runReadyGate` and `ClaudeCodeDriver.executePhase` became private stage functions in their own files, and `max-lines-per-function` (200) now holds for `src/lib/workflow/**`.
