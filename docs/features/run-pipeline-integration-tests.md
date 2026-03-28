# Run Pipeline Integration Tests

Complementary integration test layer for the run pipeline, addressing over-mocking in `run.test.ts` by exercising `executePhaseWithRetry` with real `StateManager` and `ShutdownManager` instances.

## Prerequisites

1. **Node.js 20+** — `node --version`
2. **Dependencies installed** — `npm install`

## What's Covered

The new tests complement (not replace) the existing 2,254-line unit test suite in `run.test.ts`.

### Integration Tests (`__tests__/integration/run-pipeline.integration.test.ts`)

Exercises the full pipeline path: `executePhaseWithRetry` → result collection → real `StateManager` with temp directory.

| Test | Description |
|------|-------------|
| 3-phase result collection | Runs spec → exec → qa, verifies all 3 results collected |
| Partial failure handling | Pipeline stops on exec failure, collects only completed results |
| Session continuity | `sessionId` from spec is passed through to exec |
| Timeout recording | Failed phase with timeout error correctly propagates |
| Timeout in PhaseResult | `success: false` with timeout error message |
| State tracking (completed) | All 3 phase statuses recorded as "completed" in state file |
| State tracking (failed) | Failed phase records error message, unstarted phases have no status |
| State file persistence | State survives re-read from a fresh `StateManager` instance |

### Phase Executor Unit Tests (`src/lib/workflow/phase-executor.test.ts`)

New retry and fallback coverage added alongside existing tests.

| Test | Description |
|------|-------------|
| Cold-start retry success | Succeeds on second attempt after short first run |
| Cold-start retry exhaustion | Fails after 3 cold-start attempts |
| MCP fallback success | Falls back to non-MCP after cold-start retries, succeeds |
| MCP fallback failure | Returns original error when MCP fallback also fails |
| Spec extra retries | Spec phase gets additional retries after cold-start + MCP exhaust |
| Spec retry exhaustion | Returns error after all retry tiers exhausted |
| Spec genuine failure → Phase 3 | Duration >= 60s skips cold-start, enters spec retry directly |
| Spec retry backoff | `delayFn` called with `SPEC_RETRY_BACKOFF_MS` for each retry |
| ShutdownManager integration | Abort controller passed through to `executePhaseFn` |
| Timeout PhaseResult | Timeout recorded as `success: false` with error |

## Running the Tests

```bash
# Run all tests
npm test

# Run only the new integration tests
npx vitest run __tests__/integration/run-pipeline.integration.test.ts

# Run only the phase-executor unit tests
npx vitest run src/lib/workflow/phase-executor.test.ts
```

## What to Expect

- All tests use `noDelay` to skip backoff waits — execution is near-instant.
- Integration tests create a temp directory (`/tmp/sequant-test-pipeline-*`) for real state file I/O; it is cleaned up automatically.
- No production code was changed — these are purely additive test files.

## Troubleshooting

### Tests fail with "Cannot find module" errors

**Symptoms:** Import resolution errors for `phase-executor.js` or `state-manager.js`.

**Solution:** Run `npm run build` first. Vitest resolves `.js` imports to `.ts` source files, but some configurations require a fresh build.

### Integration tests leave temp files behind

**Symptoms:** `/tmp/sequant-test-pipeline-*` directories accumulate.

**Solution:** This happens if the test process is killed before `afterAll` cleanup runs. Safe to delete manually: `rm -rf /tmp/sequant-test-pipeline-*`

---

*Generated for Issue #405 on 2026-03-27*
