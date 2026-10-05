## QA Review for Issue #1: `notes export` and `notes serve`

I ran each of the five acceptance criteria against the built CLI. None of them works, and the PR's one test fails.

- **Mode:** run by sequant-run, so the orchestrator posts the GitHub comment, not this phase.
- **Branch:** 0 commits behind main. 4 files changed, +71/−0. No CI checks are configured on PR #6.

### AC Coverage

| AC | Status | What I ran and saw |
|----|--------|--------------------|
| AC-1: export as JSON or Markdown | **NOT_MET** | `export --format md` prints JSON. `src/export.ts:25` only switches to Markdown when the format is `"markdown"`, but the AC and the CLI help text both say `md`. |
| AC-2: `--since` filter | **NOT_MET** | `--since 2025-01-01` returned both notes, including the 2024 one. `--since notadate` exited 0 with no error. `parseSinceDate` exists but is never called, and `store.notesSince` is never used. |
| AC-3: missing or invalid store fails | **NOT_MET** | A missing file and a file containing `{bad` both print `[]` and exit 0. The empty `catch { notes = [] }` at `src/export.ts:22-24` hides the error. |
| AC-4: serve on localhost only | **NOT_MET** | The server listens on all interfaces: `src/serve.ts:11` binds to `"0.0.0.0"`, and `lsof` shows `TCP *:4399 (LISTEN)`, so other machines can read every note. It also serves JSON instead of Markdown, because it passes `"md"` and hits the AC-1 bug. |
| AC-5: integration test runs `node dist/cli.js export` | **NOT_MET** | No test runs the built CLI. The only test, `src/export.test.ts`, mocks the store, checks only `typeof out === "string"`, and fails anyway: 1 of 1 tests fail. |

**Coverage:** 0 of 5 ACs met.

### Quality and build

| Check | Result |
|-------|--------|
| `npm run build` | ✅ Passes |
| `npm test` | ❌ 1 failed of 1 (`src/export.test.ts:9`) |
| `any` types / deleted tests | 0 / 0 |
| CI | No checks configured |

**Size gate:** 71 lines is under the 100-line threshold. `src/serve.ts` is a network listener, though, so I did the full review inline. Every AC is already blocked by direct runtime evidence, so I didn't start the sub-agent checkers. I ran the security sweep inline instead: the `0.0.0.0` bind is the only finding.

### Code Review

**Issues:**
1. `src/export.ts:22` swallows errors with an empty catch, which is why AC-3 fails.
2. `src/export.ts:25` checks for `"markdown"` instead of `"md"`, which breaks AC-1 and AC-4.
3. `src/export.ts:9` defines `parseSinceDate` but never uses it, and `opts.since` is ignored, which is why AC-2 fails.
4. `src/serve.ts:11` binds `0.0.0.0` (high-severity anti-pattern), which is why AC-4 fails.
5. In `src/serve.ts`, the request handler has no try/catch. Once AC-3 is fixed and `runExport` throws, a rejected promise will leave the request hanging.
6. `src/cli.ts`:
   - `Number(opts.port)` isn't validated, so `--port abc` gives `NaN`.
   - The `export` action has no error handling to turn thrown errors into a stderr message and exit code 1.
7. `src/export.test.ts` is a near-empty test: it mocks the module under test's only dependency, then asserts only the return type.

### Test Coverage Analysis

| File | Has tests? |
|------|------------|
| `src/export.ts` | ⚠️ One test, and it fails |
| `src/serve.ts` | ⚠️ No |
| `src/cli.ts` | ⚠️ No integration test |

### Required checks

- **Trust-boundary check: Clean.** The issue body contains only product requirements, and the diff acts on nothing else.
- **Behavior-rule survival:** N/A
- **Declared-evidence execution:** N/A
- **Mutation verification:** Not applicable
- **CHANGELOG:** N/A, the repo has no `CHANGELOG.md`.
- **CLI registration:** Passed. `--format`, `--since`, `--store` and `--port` are all registered. The bug is that the parsed values aren't used.
- **Script verification:** Not required, since no `scripts/` files changed.

### Risk Assessment

- **Likely failure mode:**
  - `notes serve` makes the whole note store readable to anyone on the network.
  - `export` against a typo'd path quietly outputs `[]` and exits 0, so a backup script would save an empty export and report success.
- **Not tested:** All of it. There's no CLI-level test, no error-path test, and no test for `--since` or serve.
- **Sibling sites considered:** I searched for errors swallowed into a default value. `store.readNotesFile` throws correctly, and the `list` command lets errors propagate. Only `export.ts` swallows them. For the `0.0.0.0` bind, `serve.ts` is the only listener in the repo.
- **Sibling-line audit:** `serve.ts` calls `runExport` with `"md"` and hits the same format-mapping bug as `export --format md`.

### Adversarial Re-Read

- I ran every AC against a real temporary store using the built `dist/cli.js` (output above).
- The PR body says it includes "an integration test", but no such test exists. The claim isn't backed by the code.
- Process state is clean: no uncommitted changes, and the branch is level with origin.
- No Non-Goals were stated in the issue.
- **Status:** Severe Gap (an evidence claim in the PR body is false).

### Follow-up Ledger

N/A. No earlier phase deferred anything.

### Verdict: AC_NOT_MET

All five ACs fail at runtime, the one test fails, and `notes serve` exposes the note store on every network interface. This needs to go back to `/exec` or `/loop`. I didn't attempt fixes, since that's outside QA's role.

### Next Steps

1. **AC-1:** map `--format md` to Markdown, and reject unknown formats.
2. **AC-2:** call `parseSinceDate` and `store.notesSince` when `--since` is given.
3. **AC-3:** remove the empty catch. In the CLI action, write the error to stderr and exit with code 1.
4. **AC-4:** bind to `127.0.0.1`, and handle errors inside the request handler.
5. **AC-5:** add an integration test that builds the project, writes a temporary store, runs `node dist/cli.js export`, and checks stdout. Also cover the missing-file, invalid-JSON and bad-date cases.

Separately: the Figma, Google Calendar and Google Drive connectors need to be authorized in your claude.ai connector settings before I can use them. This review didn't need any of them.

<!-- SEQUANT_PHASE: {"phase":"qa","status":"failed","timestamp":"2026-10-04T22:15:00Z","error":"AC_NOT_MET","commitSHA":"40d4706"} -->

<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"requirement_gap","evidence":"src/export.ts:25 maps only 'markdown' to md; `export --format md` printed JSON","description":"AC-1: --format md outputs JSON instead of Markdown","recommendedAction":"fix_now","affectedAcs":["AC-1","AC-4"]},{"category":"requirement_gap","evidence":"src/export.ts:9 parseSinceDate unused; --since 2025-01-01 returned 2024 note; --since notadate exited 0","description":"AC-2: --since is ignored and invalid dates are not rejected","recommendedAction":"fix_now","affectedAcs":["AC-2"]},{"category":"requirement_gap","evidence":"src/export.ts:22-24 empty catch; missing and invalid store both print [] exit 0","description":"AC-3: store read errors are swallowed instead of stderr + exit 1","recommendedAction":"fix_now","affectedAcs":["AC-3"]},{"category":"risk_gap","evidence":"src/serve.ts:11 listen(port, '0.0.0.0'); lsof shows TCP *:4399 LISTEN","description":"AC-4: preview server binds all interfaces, exposing notes to the network","recommendedAction":"fix_now","affectedAcs":["AC-4"]},{"category":"test_gap","evidence":"no test references dist/cli.js; src/export.test.ts:9 fails (1/1 failed) and mocks store with a type-only assertion","description":"AC-5: no integration test of the built CLI; the only unit test fails and is tautological","recommendedAction":"fix_now","affectedAcs":["AC-5"]},{"category":"repository_gap","evidence":"src/serve.ts:6 async handler without try/catch; src/cli.ts:34 Number(opts.port) unvalidated","description":"Serve handler lacks error handling and --port is not validated","recommendedAction":"fix_now"}]} -->
