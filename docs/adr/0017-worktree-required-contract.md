# ADR-0017: An issue context says whether a worktree is required

**Status:** Accepted
**Date:** 2026-10-17
**Issue:** #1469

## Context

`IssueExecutionContext.worktree` was optional and meant "set when worktree isolation is enabled". The same `undefined` also appeared when isolation was on but `git worktree add` had failed: `ensureWorktree` logged the error and returned `null`, `ensureWorktrees` dropped the issue from the map, and both producers of the context (`executeOneIssue` in the orchestrator and `executeBatch`) passed `worktree: undefined` down. The one consumer, `runIssueWithLogging`, handed `worktreePath` to `executePhase`, whose `const cwd = shouldUseWorktree ? worktreePath : process.cwd()` then ran spec, exec and QA in the main checkout, on whatever branch was checked out there.

The failure is real and recurring: two `sequant run` CLIs provisioning in one repository race on `.git/config.lock`, because `worktree add -b` writes the branch's upstream there and so does `recordWorktreeBaseRef`. In a 40-way repro the lock was lost 11 times. The issue that lost it ran in the main checkout, its exec guard compared `origin/main..HEAD` there, and the run failed with "exec produced no changes" against a branch that had the work.

## Decision

The context carries the requirement explicitly. `IssueExecutionContext` gains `worktreeRequired?: boolean` and `worktreeError?: string`; `BatchExecutionContext` and `OrchestratorConfig` gain `worktreeRequired` and a `worktreeFailures` map that provisioning fills with git's stderr per issue. Both producers copy them in. `runIssueWithLogging`, the single consumer, fails the issue before state init and before any phase when `worktreeRequired && !worktree`, with `abortReason: worktree provisioning failed: <stderr>` and an empty `phaseResults`.

Provisioning itself retries a lost config lock: `retryOnConfigLock` in `git-config-lock.ts` (5 attempts, 100 to 800 ms, injectable sleep) wraps `worktree add` and `recordWorktreeBaseRef`. A retry re-checks whether the failed `-b` attempt already created the branch and adds it as existing. `recordWorktreeBaseRef` returns its failure instead of swallowing it, and the caller warns that the default base is in effect.

## Options

### Option A: An explicit flag in the context, one guard at the consumer (chosen)

**Pros:** the two states the old contract conflated are now distinct, so the guard cannot misfire on isolation-off or on the spec phase, which runs in the main checkout by design. One guard covers both producers, including a direct `new RunOrchestrator().execute()` caller. **Cons:** three types grow by two fields each.

### Option B: Guard in `executePhase` at the `process.cwd()` fallback

**Cons:** `worktreePath === undefined` there is also the legitimate isolation-off case and the spec-phase case (`requiresWorktree: false`). The executor cannot tell them apart without the flag, so the guard would break both.

### Option C: Partition the issues in `run()`, as `lockedResults` does

**Cons:** `executeBatch` and direct orchestrator callers would stay unprotected; the fix would live in one producer rather than at the contract.

### Option D: Make `ensureWorktrees` throw

**Cons:** one failed worktree would abort every issue in the batch. Failing the one issue matches the per-issue lock behaviour.

### Option E: A cross-CLI provisioning lock

**Cons:** more machinery than the observed rate needs; the retry is bounded at about 1.5 s. Revisit if the concurrency test flakes.

## Trade-offs

The branch a failed `-b` attempt created stays on disk without a worktree. The abort message says so, and the next run reuses it through the existing-branch path. After a lock race the branch may carry no upstream in `.git/config`; the PR push sets it with `push -u`, so nothing downstream depends on it.

## Consequences

- Under isolation, an issue never runs a phase outside its worktree. The provisioning summary reads `N created, M reused, K failed`, and in chain mode every successor of a broken link is failed with `chain broken: #<pred> has no worktree`.
- `recordWorktreeBaseRef` returns `{ ok } | { ok: false, error }`; its two callers warn on failure.
- The skills pre-flight no longer falls back to checking the main checkout when isolation is on and every worktree failed.
- The optional `provisioning` parameter on `ensureWorktree`, `ensureWorktrees` and `ensureWorktreesChain` keeps existing stubs valid.
