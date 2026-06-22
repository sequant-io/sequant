# Quality Gates & Verdict Criteria

## Automated Check Synthesis

Combine agent outputs into a unified quality assessment:

| Agent | Output | Weight |
|-------|--------|--------|
| Type Safety Checker | Type issues count, verdict | High - blocking if issues > 3 |
| Scope/Size Checker | Files changed, LOC, assessment | Medium - warning if very large |
| Security Scanner | Critical/warning/info counts | High - blocking if criticals > 0 |
| Semgrep Static Analysis | Critical/warning findings | High - blocking if criticals > 0 |
| Test Tautology Detector | Tautological test count, percentage | High - blocking if >50% tautological |
| RLS Checker (conditional) | Violations found | High - blocking if violations |

**Synthesis Rules:**
- **Any FAIL verdict** → Flag as blocker in manual review
- **Security criticals (including Semgrep)** → Block merge, require fix before proceeding
- **Build regression detected** → Block merge, require fix before proceeding
- **Test tautology >50%** → Block merge, tests provide no regression protection
- **All PASS** → Proceed with confidence to manual review
- **WARN verdicts** → Note in review, verify manually

## Build Verification

When `npm run build` fails on the feature branch, QA must verify whether the failure is a regression (new) or pre-existing (already on main).

### Verification Logic

| Feature Build | Main Build | Error Match | Classification |
|---------------|------------|-------------|----------------|
| ❌ Fail | ✅ Pass | N/A | **Regression** - failure introduced by PR |
| ❌ Fail | ❌ Fail | Same error | **Pre-existing** - not blocking |
| ❌ Fail | ❌ Fail | Different | **Unknown** - requires manual review |
| ✅ Pass | * | N/A | N/A - no verification needed |

### Verdict Mapping

| Build Verification Result | QA Verdict Impact |
|---------------------------|-------------------|
| **Regression detected** | **BLOCKING** - `AC_NOT_MET`, must fix before merge |
| **Pre-existing failure** | Non-blocking - document and proceed |
| **Unknown (different errors)** | `AC_MET_BUT_NOT_A_PLUS` - manual review recommended |
| **Build passes** | No impact |

### Output Format

```markdown
### Build Verification

| Check | Status |
|-------|--------|
| Feature branch build | ❌ Failed |
| Main branch build | ❌ Failed |
| Error match | ✅ Same error |
| Regression | **No** (pre-existing) |

**Note:** Build failure is pre-existing on main branch. Not blocking this PR.
```

### Implementation

The `quality-checks.sh` script includes:
- `run_build_with_verification()` - runs build and triggers verification on failure
- `verify_build_against_main()` - compares build results against main branch

**How it works:**
1. Run `npm run build` on feature branch
2. If build fails, capture exit code and error output
3. Run build on main branch (via main repo directory, not checkout)
4. Compare exit codes and first error line
5. Output Build Verification table with classification

## Semgrep Integration

Semgrep provides static analysis for security vulnerabilities and anti-patterns.

### Verdict Mapping

| Semgrep Result | QA Verdict Impact |
|----------------|-------------------|
| Critical findings > 0 | **BLOCKING** - `AC_NOT_MET` |
| Warning findings only | Non-blocking - note in review |
| No findings | Pass - no impact |
| Semgrep not installed | Skipped - graceful degradation |
| Semgrep error | Non-blocking - log error |

### Output Format

```markdown
## Static Analysis (Semgrep)

✅ No critical findings
⚠️ 2 warnings:
  - src/api/users.ts:47 - Potential SQL injection (user input in query)
  - src/utils/exec.ts:12 - Command injection risk (unsanitized shell arg)
```

### Stack-Aware Rulesets

Semgrep uses stack-specific rulesets for targeted analysis:

| Stack | Rulesets |
|-------|----------|
| Next.js | p/typescript, p/javascript, p/react, p/security-audit, p/secrets |
| Python | p/python, p/django, p/flask, p/security-audit, p/secrets |
| Go | p/golang, p/security-audit, p/secrets |
| Rust | p/rust, p/security-audit, p/secrets |
| Generic | p/security-audit, p/secrets |

### Custom Rules

Projects can add custom rules in `.sequant/semgrep-rules.yaml`. These are loaded alongside stack rules automatically.

## Test Tautology Detection

Tautological tests are tests that pass but don't call any production code. They provide zero regression protection as they only assert on local values.

### Detection Logic

A test block is flagged as tautological if:
1. It's an `it()` or `test()` block
2. It contains zero calls to functions imported from source modules
3. Source modules are relative imports (`./`, `../`) excluding mocks/fixtures/test libraries

### Verdict Mapping

| Tautology Result | QA Verdict Impact |
|------------------|-------------------|
| >50% of test blocks tautological | **BLOCKING** - `AC_NOT_MET` |
| 1-50% of test blocks tautological | Warning - `AC_MET_BUT_NOT_A_PLUS` |
| 0% tautological | No impact |
| No test blocks in diff | No impact (skipped) |

### Output Format

```markdown
### Test Quality Review

| Category | Status | Notes |
|----------|--------|-------|
| Tautology Check | ⚠️ WARN | 2 tautological test blocks found (25%) |

**Tautological Tests Found:**
- `src/lib/foo.test.ts:45` - `it("should work")` - No production function calls
- `src/lib/bar.test.ts:12` - `test("validates")` - No production function calls
```

### Example - Tautological vs Real Test

```typescript
// TAUTOLOGICAL — flags as warning/blocker
import { executePhaseWithRetry } from "./run.js";
it("should retry", () => {
  const retry = true;
  expect(retry).toBe(true);  // No production function called!
});

// REAL — this is fine
import { executePhaseWithRetry } from "./run.js";
it("should retry", async () => {
  const result = await executePhaseWithRetry(123, "exec", config, ...);
  expect(result.success).toBe(true);  // Calls production function
});
```

### Implementation

The `quality-checks.sh` script includes:
- Tautology detector CLI: `scripts/qa/tautology-detector-cli.ts`
- Detection library: `src/lib/test-tautology-detector.ts`

**How it works:**
1. Get test files from `git diff main...HEAD`
2. For each test file, extract imports and test blocks
3. Check if any imported production function is called within each test block
4. Report tautological tests with file:line references
5. Block if >50% of test blocks are tautological

## Verdict Criteria

### `READY_FOR_MERGE`

Must meet ALL of:
- ✅ All AC items marked `MET`
- ✅ Type issues = 0 (no `any` additions)
- ✅ Deleted tests = 0 (or justified)
- ✅ Purpose Test: All files necessary
- ✅ Proportionality Test: Size matches AC complexity
- ✅ Risk Test: Blast radius understood and acceptable
- ✅ Reversibility Test: Clean revert possible
- ✅ **Adversarial Test: Failure path tested**
- ✅ **Edge Case Test: At least 1 edge case per AC tested**
- ✅ **Execution Evidence: Complete or waived** (see below)

### `AC_MET_BUT_NOT_A_PLUS`

AC met, but one or more issues:

- ⚠️ Minor scope creep (1-2 extra files)
- ⚠️ Over-engineering (abstraction not required)
- ⚠️ Size larger than expected but justified
- ⚠️ Type issues present but necessary
- ⚠️ Code works but could be cleaner

**Action:** List specific improvements, but don't block merge if working

### `NEEDS_VERIFICATION`

All AC items are `MET`, but one or more items have `PENDING` status requiring external verification:

- ⏳ CI/CD verification pending
- ⏳ Manual testing not yet performed
- ⏳ External dependency verification needed
- ⏳ Production environment validation required

**Action:** Complete pending verification, then re-run `/qa`

### `AC_NOT_MET`

Any of:

- ❌ One or more AC items `NOT_MET` or `PARTIALLY_MET`
- ❌ Deleted tests without justification
- ❌ Major scope creep (many unrelated files)
- ❌ Type safety violations (adding `any` without reason)
- ❌ Schema changes without migrations
- ❌ Breaking changes to shared code

**Action:** Block merge, list required fixes

## Verdict Determination Algorithm

**CRITICAL:** Follow this algorithm exactly when determining the verdict. Do NOT give `READY_FOR_MERGE` unless ALL conditions are met.

```text
1. Count AC statuses:
   - met_count = ACs with status MET
   - partial_count = ACs with status PARTIALLY_MET
   - pending_count = ACs with status PENDING
   - not_met_count = ACs with status NOT_MET

2. Determine verdict (in order):
   - IF not_met_count > 0 OR partial_count > 0:
       → AC_NOT_MET (block merge)
   - ELSE IF pending_count > 0:
       → NEEDS_VERIFICATION (wait for verification)
   - ELSE IF improvement_suggestions.length > 0:
       → AC_MET_BUT_NOT_A_PLUS (can merge with notes)
   - ELSE:
       → READY_FOR_MERGE (A+ implementation)
```

| Verdict                  | When to Use                                              |
|--------------------------|----------------------------------------------------------|
| `READY_FOR_MERGE`        | ALL ACs are `MET`, no improvements needed                |
| `AC_MET_BUT_NOT_A_PLUS`  | ALL ACs are `MET`, but minor improvements suggested      |
| `NEEDS_VERIFICATION`     | ALL ACs are `MET` or `PENDING`, at least one is `PENDING`|
| `AC_NOT_MET`             | ANY AC is `NOT_MET` or `PARTIALLY_MET`                   |

**Important:** `PARTIALLY_MET` is NOT sufficient for merge. It must be treated as `NOT_MET` for verdict purposes.

## CI Status Impact on Verdict

**Purpose:** CI status directly affects verdict when AC items depend on CI (e.g., "Tests pass in CI").

### CI Status Mapping

| State | Bucket | AC Status | Verdict Impact |
|-------|--------|-----------|----------------|
| `SUCCESS` | `pass` | `MET` | No impact |
| `FAILURE` | `fail` | `NOT_MET` | Blocks merge |
| `CANCELLED` | `fail` | `NOT_MET` | Blocks merge |
| `SKIPPED` | `pass` | `N/A` | No impact |
| `PENDING` | `pending` | `PENDING` | → `NEEDS_VERIFICATION` |
| `QUEUED` | `pending` | `PENDING` | → `NEEDS_VERIFICATION` |
| `IN_PROGRESS` | `pending` | `PENDING` | → `NEEDS_VERIFICATION` |
| (no checks) | - | `N/A` | No CI configured |

### CI-Related AC Detection

Identify AC items that depend on CI by matching patterns:
- "Tests pass in CI"
- "CI passes"
- "Build succeeds in CI"
- "GitHub Actions pass"
- "Pipeline passes"
- "Workflow passes"
- "Checks pass"
- "Actions succeed"
- "CI/CD passes"

### Error Handling

If `gh pr checks` fails:
- **`gh` not installed** → Skip CI section: "CI status unavailable (gh CLI not found)"
- **`gh` not authenticated** → Skip CI section: "CI status unavailable (gh auth required)"
- **Network/auth error** → Treat as N/A: "CI status unavailable"
- **No PR exists** → Skip CI check entirely
- **Empty response** → No CI configured (not an error)

**Portability:** CI detection requires GitHub (`gh` CLI). GitLab, Bitbucket, Azure DevOps not supported.

### CI Verdict Rules

1. **CI failure → AC_NOT_MET:** Any failed CI check that maps to an AC item means that AC is NOT_MET
2. **CI pending → NEEDS_VERIFICATION:** If CI is still running for a CI-related AC, verdict is NEEDS_VERIFICATION
3. **No CI configured → N/A:** Mark CI-related AC items as N/A, don't block on missing CI
4. **CI success → MET:** CI-related AC items are MET when all relevant checks pass

**Example Scenario:**

```markdown
AC-1: "Feature implemented" → MET (code review)
AC-2: "Tests pass locally" → MET (npm test passed)
AC-3: "Tests pass in CI" → PENDING (CI in progress)
AC-4: "Docs updated" → MET (README updated)

Verdict: NEEDS_VERIFICATION (due to AC-3 PENDING)
```

## Code Review Decision Framework

### 1. Purpose Test
**Question:** Can I explain why each changed file was necessary for the AC?
- ✅ **Yes, all files:** Strong signal for `READY_FOR_MERGE`
- ⚠️ **Yes, most files:** May indicate minor scope creep → `AC_MET_BUT_NOT_A_PLUS`
- ❌ **No, many files unclear:** Scope creep → `AC_NOT_MET`

### 2. Proportionality Test
**Question:** Is the diff size reasonable for AC complexity?

**Reference:**
- 1-3 simple AC: <100 LOC expected
- 4-6 medium AC: 100-300 LOC expected
- 7+ complex AC: 300-500 LOC expected

### 3. Risk Test
**Question:** What's the blast radius if this breaks?
- ✅ **Isolated feature, easy to revert:** Lower bar for approval
- ⚠️ **Touches shared utilities:** Scrutinize more carefully
- ❌ **Changes core types, schemas, or auth:** Highest bar

### 4. Reversibility Test
**Question:** Would reverting lose anything besides the AC?
- ✅ **No, only AC work:** Clean implementation
- ⚠️ **Yes, minor refactors:** Document them, may still approve
- ❌ **Yes, major refactors/features:** Scope creep

## Check Interpretation

- **Type issues** = 0: ✅ Good
- **Type issues** > 0: ⚠️ Review each case, ensure justified
- **Deleted tests** > 0: ❌ Blocker unless tests obsolete
- **Files changed**: Compare to similar features for proportionality
- **Net LOC**: Should align with AC complexity (see Size Check guidelines)
- **Unintegrated exports**: ⚠️ Warning only
- **Security criticals** > 0: ❌ Blocker
- **Security warnings** > 0: ⚠️ Review each case

---

## Execution Evidence Requirements

### Purpose

QA must actually execute code for scripts/CLI changes, not just review it. Analysis of 34 run logs shows zero `/loop` phases triggered - QA passes every time without catching runtime issues.

### Change Type Detection

Determine execution requirement based on what files were changed:

```bash
# Detect change type
scripts_changed=$(git diff main...HEAD --name-only | grep -E "^scripts/" | wc -l | xargs)
cli_changed=$(git diff main...HEAD --name-only | grep -E "(cli|commands?)" | wc -l | xargs)
ui_changed=$(git diff main...HEAD --name-only | grep -E "^(app|components|pages)/" | wc -l | xargs)
types_only=$(git diff main...HEAD --name-only | grep -E "\.d\.ts$|^types/" | wc -l | xargs)
tests_only=$(git diff main...HEAD --name-only | grep -E "\.test\.|\.spec\.|__tests__" | wc -l | xargs)
```

### Execution Matrix

| Change Type | QA Must Execute | Example Command |
|-------------|-----------------|-----------------|
| `scripts/` files | ✅ Required | `npx tsx scripts/foo.ts --help` |
| CLI commands | ✅ Required | `npx sequant <cmd> --help` or dry-run |
| UI components | ⚠️ Via `/test` | Browser testing required |
| Types/config only | ❌ Waiver OK | Note: "Types-only change, execution waived" |
| Tests only | ✅ Run tests | `npm test -- --grep "feature"` |

### Evidence Collection

For each executable change, QA must:

1. **Identify a safe smoke command:**
   - Prefer `--help`, `--dry-run`, or `--version` flags
   - For scripts: pass minimal safe arguments
   - Never execute destructive operations

2. **Execute and capture:**
   ```bash
   # Example for a script
   npx tsx scripts/analytics.ts --help 2>&1
   echo "Exit code: $?"
   ```

3. **Record in output:**
   ```markdown
   ### Execution Evidence

   | Test Type | Command | Exit Code | Result |
   |-----------|---------|-----------|--------|
   | Smoke test | `npx tsx scripts/analytics.ts --help` | 0 | Usage info displayed ✓ |
   | Dry run | `npx tsx scripts/migrate.ts --dry-run` | 0 | Plan shown, no changes ✓ |

   **Evidence status:** Complete
   ```

### Evidence Status Definitions

| Status | Definition | Verdict Eligibility |
|--------|------------|---------------------|
| **Complete** | All required commands executed successfully | `READY_FOR_MERGE` eligible |
| **Incomplete** | Some commands not run or failed | `AC_MET_BUT_NOT_A_PLUS` max |
| **Waived** | Explicit reason documented | `READY_FOR_MERGE` eligible |
| **Not Required** | No executable changes | `READY_FOR_MERGE` eligible |

### Waiver Criteria

Execution can be waived with documented reason:

| Waiver Reason | Example |
|---------------|---------|
| Types-only change | "Only `.d.ts` files modified" |
| Config-only change | "Only `tsconfig.json` or `.eslintrc` modified" |
| Documentation-only | "Only `.md` files modified" |
| Test-only change | "Only test files modified, tests run via `npm test`" |

**Waiver format:**
```markdown
### Execution Evidence

**Status:** Waived
**Reason:** Types-only change - only `.d.ts` files modified
```

### Verdict Gating

| Verdict | Evidence Requirement |
|---------|---------------------|
| `READY_FOR_MERGE` | Evidence: Complete OR Waived (with reason) OR Not Required |
| `AC_MET_BUT_NOT_A_PLUS` | Evidence: Incomplete + note explaining gap |
| `AC_NOT_MET` | N/A (AC issues take precedence) |

### Integration with /verify

For complex CLI features, `/verify` provides more comprehensive execution testing:

1. QA detects `scripts/` changes
2. Basic smoke test in QA (--help, --dry-run)
3. For full verification: recommend `/verify <issue> --command "..."`
4. `/verify` posts evidence to issue
5. Re-run QA to see verification evidence

See [/verify skill](../../verify/SKILL.md) for detailed execution verification.
