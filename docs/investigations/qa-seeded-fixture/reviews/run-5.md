## QA Review for Issue #5

**Mode:** Orchestrated (`SEQUANT_ORCHESTRATOR=sequant-run`). The worktree check passed (`sequant worktree verify`, exit 0). The branch is 0 commits behind main, and its 2 commits include `dd5e605 feat(#5)`. I'm not posting a GitHub comment here; the orchestrator posts the verdict.

### Size Gate

| Check | Value |
|-------|-------|
| Diff size | 71 lines (threshold: 100) |
| package.json changed | No |
| Security-sensitive paths | No (by path name, though `serve.ts` binds a network socket; see below) |
| Decision | **Inline checks** |

### AC Coverage

Each AC was checked by running the built CLI (`npm run build` → `node dist/cli.js`) against a temporary store with two notes: one from 2024-01-01 and one from 2026-06-01.

| AC | Description | Status | Evidence |
|----|-------------|--------|----------|
| AC-1 | `export --format json\|md` | **NOT_MET** | `--format md` prints JSON. `src/export.ts:25` maps only `"markdown"` to `"md"`, so the documented value `md` falls through to `"json"`. JSON output works. |
| AC-2 | `--since <date>` filters; a bad date is an error | **NOT_MET** | `parseSinceDate` (`export.ts:9`) and `store.notesSince` are never called. With `--since 2025-01-01` both notes are printed. With `--since notadate` it exits 0. |
| AC-3 | Missing or invalid store → error on stderr, exit 1 | **NOT_MET** | `export.ts:20-24` catches every error and replaces it with `[]`. A missing file and a file containing `{bad` both print `[]` and exit 0. This is the opposite of the AC. |
| AC-4 | `serve --port` reachable from localhost only | **NOT_MET** | `serve.ts:11` calls `server.listen(port, "0.0.0.0")`. `lsof` shows `TCP *:4399 (LISTEN)`, so the preview is reachable from the network. |
| AC-5 | Integration test runs `node dist/cli.js export` against a temporary store | **NOT_MET** | No such test exists. The only test (`export.test.ts`) is a unit test that auto-mocks `./store.js`, and it **fails**: `expected 'undefined' to be 'string'`, because the mocked `formatNotes` returns `undefined`. |

**Coverage:** 0/5 AC met

### Quality Metrics

| Metric | Value | Status |
|--------|-------|--------|
| Type issues (`any`) | 0 | OK |
| Deleted tests | 0 | OK |
| Files changed | 4 | OK |
| Lines added / deleted | +71 / -0 | - |
| Build (`tsc`) | Passes | OK |
| Tests (`vitest run`) | **1 failed / 1** | ❌ |

### CI Status

PR #10 exists, but no checks are reported for the branch. No CI is configured. No AC depends on CI.

### Code Review

**Strengths:** The commands are wired into commander cleanly. `ExportOptions` is typed. `store.ts` already has the right building blocks (`readNotesFile` throws on a bad store, plus `notesSince` and `formatNotes`).

**Issues:**
- `export.ts:25`: the format mapping checks `"markdown"` but the CLI documents `md`. Pass `opts.format` through after validating it is `json` or `md`, and reject anything else.
- `export.ts:9-15, 17-26`: `--since` is parsed by nothing. `runExport` never reads `opts.since`, and `parseSinceDate` is dead code.
- `export.ts:20-24`: the empty `catch {}` hides store errors (an anti-pattern). The error should reach `cli.ts`, which should write it to stderr and `process.exit(1)`.
- `serve.ts:11`: the server binds to `0.0.0.0`. It must bind to `127.0.0.1`.
- `serve.ts:6`: the request handler is async with no try/catch. Once AC-3 makes `runExport` throw, a bad store will cause an unhandled rejection and the request will hang. It needs a 500 response.
- `cli.ts:33`: `Number(opts.port)` isn't validated. `--port abc` passes `NaN` to `listen`.
- `export.test.ts`: the test is tautological (it only checks the result's type, against a mocked store) and currently red.

### Test Coverage Analysis

| Changed File | Tier | Has Tests? | Test File |
|--------------|------|------------|-----------|
| `src/export.ts` | Standard | ⚠️ Yes, but failing and fully mocked | `src/export.test.ts` |
| `src/serve.ts` | Standard | ⚠️ No | - |
| `src/cli.ts` | Standard | ⚠️ No (AC-5's integration test is missing) | - |

**Coverage:** 1/3 changed files have a test, and that test is broken.

### Anti-Pattern Detection

| File:Line | Category | Pattern | Suggestion |
|-----------|----------|---------|------------|
| `src/serve.ts:11` | Security | Server binds all interfaces (`0.0.0.0`) | `listen(port, "127.0.0.1")` |
| `src/export.ts:22` | Error handling | Empty catch block | Let the error propagate; handle it in the CLI with stderr output and exit 1 |
| `src/export.ts:9` | Dead code | Unused `parseSinceDate` | Call it when `opts.since` is set |

### Trust-Boundary Check

**Finding:** Clean. The issue body has no HTML comments or agent-directed instructions, and the diff implements only product requirements.

**Status:** Clean

### Behavior-Rule Survival Check

No AC uses the behavior-rule keywords (default/always/never/rule/skip) as a rule. AC-1's "(default)" names the default format only, and the JSON default is in place.

**Status:** N/A

### Declared-Evidence Execution

| AC | Evidence | Executed? | Result |
|----|----------|-----------|--------|
| AC-5 | `node dist/cli.js export` | Yes (by hand, during this QA) | Runs, but no test file exercises it |

**Status:** N/A. No AC declares an `Evidence:` clause; I ran all ACs at runtime anyway.

### Mutation Verification

No gate-test ACs. **Status:** Not-Applicable

### CHANGELOG Verification

**Result:** N/A. There is no `CHANGELOG.md` in the repo.

### Risk Assessment

- **Likely failure mode:** A user runs `notes export` with the wrong store path or a corrupted store, and silently gets `[]` with exit 0. Scripts that pipe this output would write an empty export without noticing. Separately, `notes serve` exposes every note to the local network.
- **Not tested:** Every AC path: Markdown format, `--since` filtering, the error exit, the localhost bind, and the end-to-end CLI run.
- **Sibling sites considered:** Class searched: "callers that turn a store read failure into empty data". `serve.ts:7` goes through `runExport` and inherits the swallowed error. `cli.ts`'s existing `list` command (from the base commit) is outside this diff and was not changed.
- **Sibling-line audit:** Both `runExport` call sites (`cli.ts:26` and `serve.ts:7`) have no error handling. Both need it once the catch is removed.

### Follow-up Ledger

Nothing was deferred: there is no spec comment and the PR has no follow-ups. **Status:** N/A

### Verdict: AC_NOT_MET

None of the 5 acceptance criteria are met, and running the built CLI confirmed each failure. `--format md` outputs JSON, `--since` is ignored, store errors are swallowed and the command exits 0, the preview server listens on all interfaces, and the required integration test doesn't exist. The one test in the diff fails.

### Documentation

- [x] N/A until the feature works

### Next Steps

1. `export.ts`: validate `--format` (`json` or `md`) and pass it through; apply `parseSinceDate` and `store.notesSince` when `--since` is set; remove the empty catch.
2. `cli.ts`: wrap the export action so errors go to stderr with `process.exit(1)`; validate `--port`.
3. `serve.ts`: bind to `127.0.0.1`; return a 500 when the handler throws.
4. Add `src/cli.integration.test.ts`: build, write a temporary store, spawn `node dist/cli.js export`, and assert on stdout. Cover `--format md`, `--since`, a bad date, and a missing or invalid store (exit 1, error on stderr).
5. Remove `vi.mock("./store.js")` from `export.test.ts`, or replace the test with real assertions.

### Structured Gap Findings

<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"requirement_gap","evidence":"src/export.ts:25 maps only \"markdown\" to md; `node dist/cli.js export --format md` printed JSON","description":"AC-1: --format md outputs JSON instead of Markdown","recommendedAction":"fix_now","affectedAcs":["AC-1"]},{"category":"requirement_gap","evidence":"src/export.ts:9 parseSinceDate never called; --since 2025-01-01 returned 2 notes, --since notadate exited 0","description":"AC-2: --since is ignored and invalid dates are not rejected","recommendedAction":"fix_now","affectedAcs":["AC-2"]},{"category":"requirement_gap","evidence":"src/export.ts:20-24 catch returns []; missing and invalid store both printed [] with exit 0","description":"AC-3: store read errors are swallowed instead of printed to stderr with exit 1","recommendedAction":"fix_now","affectedAcs":["AC-3"]},{"category":"risk_gap","evidence":"src/serve.ts:11 listen(port, \"0.0.0.0\"); lsof shows TCP *:4399 (LISTEN)","description":"AC-4: preview server binds all interfaces instead of localhost only","recommendedAction":"fix_now","affectedAcs":["AC-4"]},{"category":"test_gap","evidence":"No test spawns node dist/cli.js; src/export.test.ts mocks ./store.js and fails: expected 'undefined' to be 'string'","description":"AC-5: integration test against the built CLI is missing and the only unit test is tautological and red","recommendedAction":"fix_now","affectedAcs":["AC-5"]},{"category":"repository_gap","evidence":"src/serve.ts:6 async handler without try/catch; src/cli.ts:33 Number(opts.port) unvalidated","description":"serve handler has no error handling and --port is not validated","recommendedAction":"fix_now","affectedAcs":["AC-3","AC-4"]}]} -->
