## QA Review for Issue #4

Under the `sequant-run` orchestrator (`SEQUANT_ORCHESTRATOR=sequant-run`). The branch is 0 commits behind `main`, PR #9 is open, and no CI is configured on this branch. The diff is 71 lines across 4 files with no security-sensitive paths, so the size gate chose **inline checks**. I built and ran the CLI against a temporary store to check each AC; I didn't rely on reading the code alone.

### AC Coverage

| AC | Description | Status | Evidence |
|----|-------------|--------|----------|
| AC-1 | `export --format json\|md` prints JSON (default) or Markdown | **PARTIALLY_MET** | JSON works. `--format md` prints JSON because `src/export.ts:25` checks for `"markdown"`, and the flag value is `md`. |
| AC-2 | `--since <date>` filters; an unparseable date is an error | **NOT_MET** | `parseSinceDate` and `store.notesSince` are never called. `--since 2026-01-01` returned both notes, including the 2024 one. `--since notadate` exits 0. |
| AC-3 | A missing or invalid store file prints to stderr and exits 1 | **NOT_MET** | `src/export.ts:21-24` catches the error and returns `[]`. Both a missing file and a file containing `nope{` print `[]` and exit 0. |
| AC-4 | `serve --port <n>` serves a Markdown preview, localhost only | **NOT_MET** | `src/serve.ts:11` listens on `0.0.0.0`. `lsof` shows `TCP *:4399 (LISTEN)`. The response body is JSON (the same `md` bug as AC-1). |
| AC-5 | An integration test runs `node dist/cli.js export` against a temp store | **NOT_MET** | `src/export.test.ts` is a unit test that mocks `./store.js`. It doesn't run the built CLI, and it fails: `expected 'undefined' to be 'string'`. |

**Coverage:** 0/5 met. The PR body says "with an integration test", which isn't true.

### Quality Metrics

| Metric | Value | Status |
|--------|-------|--------|
| Build (`tsc`) | exit 0 | OK |
| Tests (`vitest run`) | 1 failed / 1 | **FAIL** |
| Type issues (`any`) | 0 | OK |
| Deleted tests | 0 | OK |
| Files changed | 4 (+71 / -0) | OK |
| Security patterns | 1: binds to all interfaces | **HIGH** |

### Code Review

**Issues:**
- **Empty catch** at `src/export.ts:22`: it swallows every store error, which directly breaks AC-3.
- **Dead code:** `parseSinceDate` is never called, and `opts.since` is ignored.
- **Format mapping bug:** `opts.format === "markdown" ? "md" : "json"` means `md` never selects Markdown. Unknown formats also fall back to JSON silently instead of raising an error.
- **Network exposure:** `server.listen(port, "0.0.0.0")` publishes the note store to the whole LAN.
- **No error handling in serve:** `Number(opts.port)` isn't validated, and a rejected `runExport` inside the request handler would leave the request hanging.
- **The test checks nothing useful:** with the module mocked, `runExport` returns `undefined`, and even a passing test would only assert `typeof === "string"`.

### Test Coverage Analysis

| File | Tier | Has Tests? |
|------|------|------------|
| `src/export.ts` | Standard | Yes, but the test is failing and checks nothing useful |
| `src/serve.ts` | Standard | No |
| `src/cli.ts` | Standard | No |

### Anti-Pattern Detection

| File:Line | Category | Pattern |
|-----------|----------|---------|
| `src/serve.ts:11` | Security | Server binds to all interfaces (`0.0.0.0`) |
| `src/export.ts:22` | Error handling | Empty catch block |

### Trust-Boundary Check
**Finding:** Clean. The issue body has no HTML comments or other instructions aimed at the agent, and the diff only implements product behaviour.
**Status:** Clean

### Behavior-Rule Survival / Declared-Evidence / Mutation Verification
None of these apply: no AC triggers the behavior-rule heuristic, declares a runnable `Evidence:` command, or is a gate-test AC.

### CHANGELOG Verification
**Result:** N/A. The repo has no `CHANGELOG.md`.

### Risk Assessment
- **Likely failure mode:** Scripts that rely on export get exit 0 and `[]` when the store is corrupt, so data loss goes unnoticed. Anyone on the local network can read notes through `serve`.
- **Not tested:** Every AC path. The only test is mocked and failing.
- **Sibling sites considered:** I searched for "store-read errors swallowed or not surfaced". `serve.ts` goes through the same `runExport` path, so a broken store gives an empty preview with a 200 response. That's the only other site.
- **Sibling-line audit:** `src/export.ts` has three gaps in one function: the catch, the ignored `since`, and the format mapping.

### Follow-up Ledger
Nothing was deferred. **Status:** N/A

### Verdict: AC_NOT_MET

None of the five ACs is fully met. AC-1 is partial and AC-2 to AC-5 are not met. The test suite is red, and `serve` is exposed beyond localhost. I confirmed all of this by running the built CLI, not just by reading the code.

### Next Steps (for `/exec` / `/loop`)
1. Map `--format md` correctly and reject unknown formats.
2. Wire `--since` through `parseSinceDate` and `store.notesSince`. A bad date should print to stderr and exit 1.
3. Remove the empty catch. In the CLI action, print the error to stderr and exit 1. In `serve`, return a 500.
4. Bind `serve` to `127.0.0.1` and validate the port.
5. Replace `export.test.ts` with an integration test that runs `node dist/cli.js export` against a `mktemp` store and checks stdout. Add cases for `--since` and for a missing or invalid store.
6. Correct the PR body's claim that it includes an integration test.

I didn't post this as a GitHub comment because the orchestrator posts the verdict.

### Structured Gap Findings

<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"requirement_gap","evidence":"src/export.ts:25 maps only \"markdown\" to md; `export --format md` printed JSON","description":"--format md outputs JSON instead of Markdown (AC-1, also breaks AC-4 preview)","recommendedAction":"fix_now","affectedAcs":["AC-1","AC-4"]},{"category":"requirement_gap","evidence":"parseSinceDate/notesSince never called; --since 2026-01-01 returned 2024 note; --since notadate exit 0","description":"--since filtering and invalid-date error not implemented","recommendedAction":"fix_now","affectedAcs":["AC-2"]},{"category":"requirement_gap","evidence":"src/export.ts:21-24 catch returns []; missing and invalid store both exit 0","description":"Missing/invalid store does not error to stderr with exit 1","recommendedAction":"fix_now","affectedAcs":["AC-3"]},{"category":"risk_gap","evidence":"src/serve.ts:11 listen(port, \"0.0.0.0\"); lsof shows TCP *:4399 LISTEN","description":"Preview server binds all interfaces instead of localhost only","recommendedAction":"fix_now","affectedAcs":["AC-4"]},{"category":"test_gap","evidence":"src/export.test.ts mocks ./store.js and fails: expected 'undefined' to be 'string'","description":"No integration test running node dist/cli.js export against a temp store; existing unit test fails","recommendedAction":"fix_now","affectedAcs":["AC-5"]},{"category":"execution_gap","evidence":"npm test: Test Files 1 failed (1)","description":"Test suite is red","recommendedAction":"fix_now","affectedAcs":["AC-5"]}]} -->
