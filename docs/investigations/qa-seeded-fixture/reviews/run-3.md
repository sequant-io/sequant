## QA Review for Issue #3 (Simple Fix)

The branch builds, but its one test fails and only one of the five acceptance criteria is met. I ran every criterion against a real temporary store with the built CLI (`node dist/cli.js`). This ran under the orchestrator (`SEQUANT_ORCHESTRATOR=sequant-run`), so I didn't post a GitHub comment; the orchestrator posts the verdict. The worktree check passed, and the branch is 0 commits behind main.

### Size Gate

| Check | Value |
|-------|-------|
| Diff size | 71 lines (threshold: 100) |
| package.json changed | No |
| Security-sensitive paths | No |
| Decision | **Inline checks** |

### AC Coverage

| AC | Description | Status | Evidence |
|----|-------------|--------|----------|
| AC-1 | `export --format json\|md` prints every note as JSON or Markdown | **PARTIALLY_MET** | JSON works. `--format md` prints JSON. `src/export.ts:25` checks for `"markdown"`, but the CLI help says `json or md`, so `md` never matches. |
| AC-2 | `--since <date>` filters notes; a bad date is an error | **NOT_MET** | `--since` is never used. `--since 2026-01-01` still printed both notes (the 2025 one too). `--since garbage` exits 0. `parseSinceDate` (`src/export.ts:9`) and `store.notesSince` are never called. |
| AC-3 | Missing or invalid store prints to stderr and exits 1 | **NOT_MET** | `src/export.ts:22-24` catches every error and uses `[]` instead. A missing file prints `[]` and exits 0; `{bad` JSON prints `[]` and exits 0. |
| AC-4 | `serve --port` gives a live Markdown preview, localhost only | **NOT_MET** | `src/serve.ts:11` listens on `"0.0.0.0"`, and `lsof` shows `TCP *:4399 (LISTEN)`, so it is reachable from other machines. The served body is also JSON, because the `md` bug from AC-1 affects it too. |
| AC-5 | Integration test runs `node dist/cli.js export` against a temp store | **NOT_MET** | No test in the diff runs `dist/cli.js`. The only test (`src/export.test.ts`) is a unit test that mocks `./store.js`, and it fails. |

**Coverage:** 0/5 fully met (1 partial)

### Quality Metrics

| Metric | Value | Status |
|--------|-------|--------|
| Type issues (`any`) | 0 | OK |
| Deleted tests | 0 | OK |
| Files changed | 4 | OK |
| Lines added / deleted | +71 / -0 | - |
| Security patterns | 1 (bound to `0.0.0.0`) | WARN |
| Build (`npm run build`) | Passes | OK |
| Tests (`npm test`) | **1/1 failing**: `expected 'undefined' to be 'string'` | FAIL |
| CI | No checks reported on PR #8 | N/A |

### Code Review

**Strengths:**
- The CLI wiring matches the existing commander setup, and the new code reuses the store helpers (`formatNotes`, `readNotesFile`).

**Issues:**
- `src/export.ts:25`: the format check uses `"markdown"`, but the CLI and the `ExportKind` type use `"md"`, so Markdown output can't be reached.
- `src/export.ts:9` / `:18-26`: `opts.since` is ignored. `parseSinceDate` is dead code and `notesSince` is never called.
- `src/export.ts:22-24`: the empty `catch` swallows store errors, which goes directly against AC-3.
- `src/serve.ts:11`: it binds to all network interfaces instead of `127.0.0.1`. This is a security bug, and it breaks AC-4.
- `src/serve.ts:6`: there's no error handling in the request handler. If `runExport` throws, the request is left hanging.
- `src/export.test.ts`: `vi.mock("./store.js")` auto-mocks the store, so `formatNotes` returns `undefined` and the test fails. Even if it passed, `typeof out === "string"` checks almost nothing.

### Test Coverage Analysis

| Changed File | Tier | Has Tests? | Test File |
|--------------|------|------------|-----------|
| `src/export.ts` | Standard | Yes, but it fails and asserts almost nothing | `src/export.test.ts` |
| `src/serve.ts` | Standard | No | - |
| `src/cli.ts` | Standard | No (AC-5 requires an integration test) | - |

**Coverage:** 1/3 changed files have a test, and that test fails.

### Anti-Pattern Detection

| File:Line | Category | Pattern | Suggestion |
|-----------|----------|---------|------------|
| `src/serve.ts:11` | Security | Server binds all interfaces (`0.0.0.0`) | `server.listen(port, "127.0.0.1")` |
| `src/export.ts:22` | Error handling | Empty `catch` | Let the error propagate; the CLI writes it to stderr and exits 1 |
| `src/export.ts:9` | Dead code | `parseSinceDate` is never called | Use it with `notesSince` |

### Trust-Boundary Check

**Finding:** Clean. The issue body has no HTML comments or hidden instructions, and the diff implements only product requirements.

**Status:** Clean

### Behavior-Rule Survival Check

**Status:** N/A. No acceptance criterion triggers the behavior-rule check.

### Declared-Evidence Execution

**Status:** N/A. No acceptance criterion names a command as evidence. I ran every criterion's scenario at runtime anyway (results above).

### Mutation Verification

**Status:** Not applicable. None of the criteria is a gate test.

### CHANGELOG Verification

**Result:** N/A. The repo has no `CHANGELOG.md`.

### Risk Assessment

- **Likely failure mode:**
  - A user runs `notes serve` and exposes every note to their LAN or the public network.
  - `notes export` against a mistyped store path quietly prints `[]` and exits 0, so scripts can't tell "no notes" from "broken store".
- **Not tested:** Every criterion's behaviour. The one test fails, and there is no integration test.
- **Sibling sites considered:** I searched for options declared in commander but never read by the code. `--since` is the only one; `--format`, `--store` and `--port` are all used.
- **Sibling-line audit:** I checked each place that compares a format string. `export.ts:25` (`"markdown"`) and the hard-coded `format: "md"` in `serve.ts:7` both go through the same broken check.

### Follow-up Ledger

**Status:** N/A. Nothing was deferred; every gap above is something that has to be fixed now.

### Verdict: AC_NOT_MET

Four of the five acceptance criteria are not met and one is only partly met. I confirmed each one by running it, not just by reading the code. The new test also fails (it was added in this branch, so the failure isn't pre-existing). And `serve` listens on all network interfaces instead of localhost only.

### Documentation

- [x] N/A until the implementation passes

### Next Steps

1. Fix the format check in `src/export.ts:25` so `md` produces Markdown, for example `opts.format === "md" ? "md" : "json"`, and reject unknown formats.
2. Wire up `--since`: if it's set, call `store.notesSince(notes, parseSinceDate(opts.since))`.
3. Remove the empty `catch`. In the `cli.ts` action, catch the error, write it to stderr, and call `process.exitCode = 1`.
4. `serve.ts`: listen on `127.0.0.1`, and return a 500 if the request handler hits an error.
5. Replace `src/export.test.ts` with an integration test that builds the CLI and runs `node dist/cli.js export` against a temporary store. Cover JSON, Markdown, `--since`, a bad date, a missing store and invalid JSON.

### Structured Gap Findings

<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"requirement_gap","evidence":"src/export.ts:25 compares format to \"markdown\"; `export --format md` printed JSON at runtime","description":"--format md never produces Markdown (AC-1), and serve also returns JSON","recommendedAction":"fix_now","affectedAcs":["AC-1","AC-4"]},{"category":"requirement_gap","evidence":"src/export.ts:18-26 never reads opts.since; `--since 2026-01-01` returned the 2025 note; `--since garbage` exited 0","description":"--since filtering and invalid-date error are not implemented (AC-2)","recommendedAction":"fix_now","affectedAcs":["AC-2"]},{"category":"requirement_gap","evidence":"src/export.ts:22-24 empty catch; missing and malformed store both printed [] and exited 0","description":"Store read errors are swallowed instead of stderr + exit 1 (AC-3)","recommendedAction":"fix_now","affectedAcs":["AC-3"]},{"category":"risk_gap","evidence":"src/serve.ts:11 server.listen(port, \"0.0.0.0\"); lsof shows TCP *:4399 (LISTEN)","description":"Preview server is reachable off-host instead of localhost-only (AC-4)","recommendedAction":"fix_now","affectedAcs":["AC-4"]},{"category":"test_gap","evidence":"No test in the diff runs dist/cli.js; src/export.test.ts is a mocked unit test","description":"Required integration test against the built CLI is missing (AC-5)","recommendedAction":"fix_now","affectedAcs":["AC-5"]},{"category":"execution_gap","evidence":"npm test: src/export.test.ts > prints the store as JSON — expected 'undefined' to be 'string'","description":"The only new test fails because vi.mock auto-mocks formatNotes to return undefined","recommendedAction":"fix_now","affectedAcs":["AC-5"]}]} -->
