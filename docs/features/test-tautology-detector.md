# Test Tautology Detector

**Quick Start:** Automatically flags test blocks that pass but never call production code. Integrated into `/qa` quality gates to catch tautological tests before they ship.

## What It Detects

A **tautological test** is one that passes without invoking any imported production function. These tests provide zero regression protection.

```typescript
// TAUTOLOGICAL — flagged
import { executePhaseWithRetry } from "./run.js";
it("should retry", () => {
  const retry = true;
  expect(retry).toBe(true); // Only asserts on a local variable
});

// REAL — not flagged
import { executePhaseWithRetry } from "./run.js";
it("should retry", async () => {
  const result = await executePhaseWithRetry(123, "exec", config);
  expect(result.success).toBe(true); // Asserts on production code output
});
```

## How It Works

For each test file in the diff:

1. Extracts imports from source modules (relative paths like `./foo` or `../bar`)
2. Extracts `it()` and `test()` blocks (including `.skip` and `.only` variants)
3. Checks if any imported function name appears in the test body
4. Flags blocks where zero production functions are referenced

**Excluded from detection** (not counted as production imports):
- Test libraries: vitest, jest, @testing-library, mocha, chai, sinon
- Mocks/fixtures: paths containing `mock`, `fixture`, `stub`, `fake`, `test-utils`
- Node built-ins: `node:*` modules

## Integration with QA

The tautology detector runs automatically during `/qa` as part of the quality checks. Results appear in the **Test Quality Review** section.

### Verdict Impact

| Tautological % | QA Impact |
|-----------------|-----------|
| 0% | No impact |
| 1–50% | Warning — noted in QA output |
| >50% | **Blocking** — prevents `READY_FOR_MERGE` verdict |

### QA Output Example

```markdown
### Test Quality Review

| Category | Status | Notes |
|----------|--------|-------|
| Tautology Check | ⚠️ WARN | 2 tautological test blocks found (15.4%) |

**Tautological Tests Found:**

- `src/lib/foo.test.ts:45` - `it("should handle retry")` - No production function calls
- `src/lib/foo.test.ts:62` - `test("validates input")` - No production function calls
```

## CI (Phase A, advisory)

**#940.** A `tautology-advisory` CI job runs the same detector on every PR,
diffing test files changed vs the base branch. This is deliberately
**advisory-only** — the job always exits 0, regardless of findings. It exists
to accumulate a false-positive rate across real PRs before deciding whether
to enforce (Phase B).

Findings render as:
- `::warning` annotations on the changed lines (visible in the PR's Files tab)
- A markdown table in the job summary (`$GITHUB_STEP_SUMMARY`)
- A machine-readable summary line for FP-rate accounting:
  ```
  <!-- TAUTOLOGY_SUMMARY {"pr":940,"filesScanned":2,"totalTests":4,"findings":1,"skipped":0,"score":0.25} -->
  ```

The job invokes the CLI with:

```bash
npx tsx scripts/qa/tautology-detector-cli.ts \
  --base "origin/$BASE_REF" \
  --advisory \
  --github
```

`--base` is required in CI because it's passed explicitly rather than
relying on `resolveDiffBase`'s local-ref fallback. The checkout step uses
`fetch-depth: 0` (full history) — the default `fetch-depth: 1` checks out
only the PR's merge commit with no parent links, so `origin/<base>...HEAD`
has no discoverable merge-base and the diff throws `fatal: ...: no merge
base` even though `origin/<base>` itself resolves fine (confirmed on this
job's first live CI run). Full history also removes the need for a separate
fetch step — `origin/<base>` is already populated by the full clone.

**Aggregating the FP rate:** pull `TAUTOLOGY_SUMMARY` lines from recent job
summaries to compute the measured rate ahead of the Phase B decision:

```bash
gh run list --workflow=ci.yml --json databaseId -q '.[].databaseId' | \
  xargs -I{} gh api "/repos/{owner}/{repo}/actions/jobs/{}" 2>/dev/null | \
  grep -o '<!-- TAUTOLOGY_SUMMARY .* -->'
```

## CLI Usage

Run the detector standalone via the CLI wrapper:

```bash
# Markdown output (default)
npx tsx scripts/qa/tautology-detector-cli.ts

# JSON output
npx tsx scripts/qa/tautology-detector-cli.ts --json

# Verbose (shows warnings for unreadable files)
npx tsx scripts/qa/tautology-detector-cli.ts --verbose

# CI mode: explicit base ref, force exit 0, GitHub annotations + step summary (#940)
npx tsx scripts/qa/tautology-detector-cli.ts --base origin/main --advisory --github
```

| Flag | Description |
|------|--------------|
| `--json` | Output results as JSON |
| `--verbose` | Include warnings for unreadable files |
| `--base <ref>` | Diff base ref (default: `resolveDiffBase` against `main`) |
| `--advisory` | Force exit 0 even when findings exceed the blocking threshold |
| `--github` | Emit `::warning` annotations and a `$GITHUB_STEP_SUMMARY` table with a `TAUTOLOGY_SUMMARY` marker |

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success — no blocking issues |
| 1 | Blocking — >50% of tests are tautological |
| 2 | Error running detector |

### JSON Output Schema

```json
{
  "status": "none | warning | blocking",
  "summary": {
    "totalFiles": 3,
    "totalTests": 20,
    "totalTautological": 2,
    "overallPercentage": 10,
    "exceedsBlockingThreshold": false
  },
  "files": [
    {
      "path": "src/lib/foo.test.ts",
      "totalTests": 8,
      "tautologicalCount": 1,
      "tautologicalTests": [
        {
          "line": 45,
          "description": "should handle retry",
          "style": "it"
        }
      ]
    }
  ]
}
```

## Programmatic API

Import directly for custom tooling:

```typescript
import {
  detectTautologicalTests,
  formatTautologyResults,
  getTautologyVerdictImpact,
} from "./src/lib/test-tautology-detector";

const results = detectTautologicalTests([
  { path: "src/lib/foo.test.ts", content: fileContent },
]);

// Markdown report
console.log(formatTautologyResults(results));

// Verdict impact: "none" | "warning" | "blocking"
const impact = getTautologyVerdictImpact(results);
```

### Exported Functions

| Function | Description |
|----------|-------------|
| `detectTautologicalTests(files)` | Analyze multiple test files, returns `TautologyResults` |
| `formatTautologyResults(results)` | Format results as markdown table |
| `getTautologyVerdictImpact(results)` | Get verdict impact: `"none"`, `"warning"`, or `"blocking"` |
| `analyzeTestFile(content, path)` | Analyze a single test file |
| `extractImports(content)` | Extract production imports from file content |
| `extractTestBlocks(content)` | Extract `it()`/`test()` blocks with bodies |
| `testBlockCallsProductionCode(body, imports)` | Check if a test body references any imports |
| `isSourceModule(modulePath)` | Check if an import path is a production module |

## Parser Capabilities

The detector handles these patterns correctly:

- **Import styles**: named (`{ foo }`), default, namespace (`* as ns`), aliased (`foo as bar`)
- **Test styles**: `it()`, `test()`, `it.skip()`, `test.only()`, etc.
- **String awareness**: Test blocks inside template literals or string constants are ignored
- **Nested templates**: `` `outer ${`inner`} outer` `` parsed correctly
- **Comment filtering**: `it()` references inside `//` or `/* */` comments are skipped
- **Identifier boundaries**: `$`-prefixed names (jQuery-style) handled correctly; substring matches prevented (`fooBar` won't match `foo`)
- **Special characters**: Function names with regex-special characters are escaped safely

## Troubleshooting

### False Positives (test flagged but does call production code)

**Symptoms:** A test is flagged as tautological but it does invoke production code through an indirect pattern.

**Likely cause:** The detector only tracks direct name references. Dynamic invocation patterns (e.g., `obj[methodName]()`) are not detected.

**Solution:** This is a known limitation. The detection is intentionally conservative — it may produce false positives for highly dynamic test patterns, but avoids false negatives for standard usage.

### No Test Files Found

**Symptoms:** CLI outputs "No test files changed in diff" even though test files were modified.

**Solution:** The CLI reads test files from `git diff main...HEAD`. Ensure your branch has diverged from `main` and that changed files match `*.test.*` or `*.spec.*` patterns.

---

*Generated for Issue #298 on 2026-02-21*
