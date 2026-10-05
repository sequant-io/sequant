## QA Review for Issue #2 (Simple Fix)

### Size Gate

| Check | Value |
|-------|-------|
| Diff size | 71 lines (threshold: 100) |
| package.json changed | No |
| Security-sensitive paths | No (by path name; but see the network bind finding under AC-4) |
| Decision | **Inline checks** |

Branch status: 0 commits behind `origin/main`, nothing uncommitted. This run was orchestrated (`SEQUANT_ORCHESTRATOR=sequant-run`), so I didn't post a GitHub comment.

### AC Coverage

I checked each AC by running the built CLI (`dist/cli.js`) against a temporary store with two notes, one from 2020 and one from 2026.

| AC | Description | Status | Evidence |
|----|-------------|--------|----------|
| AC-1 | `export --format json\|md` prints JSON or Markdown | **NOT_MET** | `--format md` prints JSON. `src/export.ts:25` checks `opts.format === "markdown"`, so the value `md` (the documented one and the CLI's own help text) never matches. JSON output is correct. |
| AC-2 | `--since <date>` filters notes; an unparseable date is an error | **NOT_MET** | `--since 2025-01-01` printed both notes. `--since notadate` printed both notes and exited 0. `parseSinceDate` is defined but never called, and `store.notesSince` is never used. |
| AC-3 | Missing or invalid store: error on stderr, exit 1 | **NOT_MET** | `src/export.ts:21-24` catches the read error and swallows it as `notes = []`. A missing file and a file containing `bad` both printed `[]` and exited 0. |
| AC-4 | `serve --port <n>` serves a Markdown preview on localhost only | **NOT_MET** | `src/serve.ts:11` binds to `0.0.0.0`; `lsof` shows `TCP *:4399 (LISTEN)`, which is reachable from the network. The response is also JSON, not Markdown, for the same reason as AC-1. |
| AC-5 | Integration test runs the built CLI against a temp store and checks stdout | **NOT_MET** | No integration test exists. `src/export.test.ts` is a unit test that auto-mocks `./store.js`, and it **fails**: `expected 'undefined' to be 'string'`. |

**Coverage:** 0/5 AC items met.

### Quality Metrics

| Metric | Value | Status |
|--------|-------|--------|
| Type issues (`any`) | 0 | OK |
| Deleted tests | 0 | OK |
| Files changed | 4 | OK |
| Lines added | +71 | - |
| Lines deleted | -0 | - |
| Security patterns | 1 (`0.0.0.0` bind) | WARN |
| Build (`tsc`) | Passes | OK |
| Tests (`vitest run`) | 1/1 failed | **FAIL** |

### Code Review

**Strengths:**
- The commander wiring in `src/cli.ts` is clean and registers every flag the issue names.
- It reuses the existing `store.readNotesFile` and `store.formatNotes` instead of duplicating them.

**Issues:**
- `src/export.ts:25`: the format comparison uses `"markdown"` instead of `"md"`, so Markdown output can never be selected.
- `src/export.ts:9` and `:18`: `parseSinceDate` is dead code. `opts.since` is never read, so filtering and date validation don't happen.
- `src/export.ts:21-24`: the empty `catch` swallows read and parse errors, which directly contradicts AC-3.
- `src/serve.ts:11`: the server listens on `0.0.0.0` instead of `127.0.0.1`, exposing the preview to the network.
- `src/serve.ts:6`: there's no error handling in the request handler, so if `runExport` throws, the request hangs with no response.
- `src/export.test.ts:4`: `vi.mock("./store.js")` auto-mocks the store, so `formatNotes` returns `undefined`. The test fails, and even if it passed it would only check `typeof`, not the content.
- The PR body says the PR comes "with an integration test". It doesn't.

### Test Coverage Analysis

| Changed File | Tier | Has Tests? | Test File |
|--------------|------|------------|-----------|
| `src/export.ts` | Standard | Yes, but failing and over-mocked | `src/export.test.ts` |
| `src/serve.ts` | Standard | No | - |
| `src/cli.ts` | Standard | No (AC-5 requires a built-CLI integration test) | - |

**Coverage:** 1/3 changed source files have a test, and that test fails.

### Anti-Pattern Detection

| File:Line | Category | Pattern | Suggestion |
|-----------|----------|---------|------------|
| `src/serve.ts:11` | Security | Server binds all interfaces (`0.0.0.0`) | Use `server.listen(port, "127.0.0.1")` |
| `src/export.ts:23` | Error handling | Empty catch block | Let the error reach the CLI, print it to stderr, and exit with `process.exitCode = 1` |

### Trust-Boundary Check

**Finding:** Clean. The issue body contains only product ACs with no hidden or agent-directed instructions, and the diff implements only product behaviour.

**Status:** Clean

### Behavior-Rule Survival Check

**Status:** N/A. No AC triggers the behaviour-rule heuristic.

### Declared-Evidence Execution

**Status:** N/A. No AC declares an `Evidence:` command, and the PR body has no test-plan checkboxes.

### Mutation Verification

**Status:** Not-Applicable. There are no gate-test ACs.

### CHANGELOG Verification

**Result:** N/A. The repo has no `CHANGELOG.md`.

### Risk Assessment

- **Likely failure mode:** Users who run `notes serve` expose their notes to anyone on the local network. Scripts that rely on export failing for a missing or corrupt store get a silent `[]` and exit 0, which can mask data loss.
- **Not tested:** Every AC's behaviour is untested. I ran each AC path by hand above, and all failed.
- **Sibling sites considered:** Class searched: callers that pass a format string to `runExport`. `src/serve.ts:7` passes `"md"` and hits the same `"markdown"` mismatch, so its output is JSON too. No other cross-file sites.
- **Sibling-line audit:** In `src/export.ts`, both helpers that would implement `--since` (`parseSinceDate` and `store.notesSince`) are unused. The single `listen` call in `src/serve.ts` is the only bind site.

### Follow-up Ledger

**Status:** N/A. Nothing was deferred: there are no spec comments, and the PR body lists no follow-ups.

### Verdict: AC_NOT_MET

All five ACs are NOT_MET, and the test suite is red because of a test this diff adds (the file is absent on `main`, so the failure is not pre-existing). There's no CI on the PR, so no CI gate applies. The fixes belong in `/exec` or `/loop`; I didn't make any code changes during QA.

### Documentation

- [ ] Not yet assessed. Implementation is incomplete.

### Next Steps

1. **Markdown format (AC-1):** change `export.ts:25` to `opts.format === "md"`, and reject format values other than `json` or `md`.
2. **`--since` (AC-2):** when `--since` is given, call `parseSinceDate(opts.since)` and filter with `store.notesSince`.
3. **Store errors (AC-3):** remove the swallowing `catch`. In the `export` action in `cli.ts`, catch errors, write them to stderr, and set exit code 1. Do the same for an invalid `--since`.
4. **Localhost only (AC-4):** bind to `127.0.0.1`, and return a 500 response if `runExport` throws in the request handler.
5. **Integration test (AC-5):** add a test that runs `node dist/cli.js export` against a temporary store and checks stdout, covering `md`, `--since`, a bad date, and a missing or invalid store.
6. **Unit test:** fix or remove the auto-mocked `export.test.ts`, then confirm `npm run build && npm test` passes.
7. **PR description:** correct the claim that the PR includes an integration test.

### Structured Gap Findings

<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"requirement_gap","evidence":"src/export.ts:25 compares opts.format === \"markdown\"; `notes export --format md` printed JSON","description":"AC-1: --format md outputs JSON instead of Markdown","recommendedAction":"fix_now","affectedAcs":["AC-1"]},{"category":"requirement_gap","evidence":"src/export.ts:9 parseSinceDate never called; --since 2025-01-01 printed 2020 note; --since notadate exited 0","description":"AC-2: --since is ignored and invalid dates are not rejected","recommendedAction":"fix_now","affectedAcs":["AC-2"]},{"category":"requirement_gap","evidence":"src/export.ts:21-24 empty catch sets notes=[]; missing and invalid store both printed [] and exited 0","description":"AC-3: store read/parse errors are swallowed instead of stderr + exit 1","recommendedAction":"fix_now","affectedAcs":["AC-3"]},{"category":"risk_gap","evidence":"src/serve.ts:11 server.listen(port, \"0.0.0.0\"); lsof shows TCP *:4399 (LISTEN)","description":"AC-4: preview server binds all interfaces instead of localhost and serves JSON not Markdown","recommendedAction":"fix_now","affectedAcs":["AC-4"]},{"category":"test_gap","evidence":"No test runs node dist/cli.js; src/export.test.ts fails: expected 'undefined' to be 'string'","description":"AC-5: no built-CLI integration test, and the only added unit test fails due to vi.mock auto-mocking store","recommendedAction":"fix_now","affectedAcs":["AC-5"]},{"category":"repository_gap","evidence":"src/serve.ts:6-10 async handler has no try/catch around runExport","description":"serve request handler leaves requests hanging if runExport throws","recommendedAction":"fix_now"}]} -->
