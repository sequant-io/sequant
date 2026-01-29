# Quality Gates & Verdict Criteria

## Automated Check Synthesis

Combine agent outputs into a unified quality assessment:

| Agent | Output | Weight |
|-------|--------|--------|
| Type Safety Checker | Type issues count, verdict | High - blocking if issues > 3 |
| Scope/Size Checker | Files changed, LOC, assessment | Medium - warning if very large |
| Security Scanner | Critical/warning/info counts | High - blocking if criticals > 0 |
| Semgrep Static Analysis | Critical/warning findings | High - blocking if criticals > 0 |
| RLS Checker (conditional) | Violations found | High - blocking if violations |

**Synthesis Rules:**
- **Any FAIL verdict** → Flag as blocker in manual review
- **Security criticals (including Semgrep)** → Block merge, require fix before proceeding
- **All PASS** → Proceed with confidence to manual review
- **WARN verdicts** → Note in review, verify manually

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
