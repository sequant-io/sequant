# Testing Requirements

## Test Quality Guidelines

**The goal is NOT test quantity — it's transparency about what's actually being tested.**

### A Quality Test:
- **Tests behavior, not implementation details** - Assert on outputs, not internal state
- **Covers primary use case + at least 1 failure path** - Happy path alone is insufficient
- **Fails when the feature breaks, passes when it works** - Actually validates the feature
- **Uses realistic inputs** - Not contrived data that never occurs in production

### Avoid:
- ❌ Tests that mock everything (tests the mocks, not the code)
- ❌ Tests that only cover happy path (miss real failures)
- ❌ Tests written just to hit coverage numbers (low value)
- ❌ Snapshot tests over 50 lines (too brittle, hard to review)
- ❌ Tests that mirror implementation (break with any refactor)

### Test Value Hierarchy

| Test Type | Value | When to Use |
|-----------|-------|-------------|
| **Integration tests** | High | Critical paths, user flows |
| **Unit tests (behavior)** | Medium-High | Business logic, utilities |
| **Unit tests (implementation)** | Low | Avoid - too brittle |
| **Snapshot tests** | Low | UI components only, small snapshots |

### Test-to-Code Ratio Guidelines

Don't chase coverage percentages. Instead:

| Change Type | Recommended Approach |
|-------------|---------------------|
| **Critical path** (auth, payments) | Test thoroughly - multiple scenarios |
| **Business logic** | Test primary behavior + 1-2 edge cases |
| **Simple utilities** | Single test covering main use case |
| **UI tweaks** | Manual verification often sufficient |
| **Types/config** | No tests needed |

---

## Adversarial Thinking Checklist

**STOP and ask these questions before any READY_FOR_MERGE verdict:**

### 1. "What would break this?"
- [ ] Identified at least 2 failure scenarios
- [ ] Actually tested each failure scenario (not just thought about it)
- [ ] Documented what happens when failure occurs

### 2. "What assumptions am I making?"
- [ ] Listed key assumptions (API behavior, data format, status codes)
- [ ] Validated each assumption with actual test
- [ ] If assumption can't be tested, flagged as risk

### 3. "What's the unhappy path?"
- [ ] Tested behavior when inputs are invalid
- [ ] Tested behavior when dependencies fail
- [ ] Tested behavior when resources don't exist

### 4. "Did I test the feature's PRIMARY PURPOSE?"
- [ ] If feature handles errors → actually triggered an error
- [ ] If feature retries → actually triggered a retry
- [ ] If feature validates → actually provided invalid input
- [ ] If feature blocks → actually tried the blocked action

## Failure Path Testing by Feature Type

| Feature Type | Must Test |
|--------------|-----------|
| Retry mechanism | Force a failure, verify retry triggers |
| Validation | Submit invalid data, verify rejection |
| Error handling | Cause an error, verify graceful handling |
| Auth/permissions | Try unauthorized action, verify blocked |
| Rate limiting | Exceed limit, verify throttled |

## Red Flags (Incomplete Testing)

- ❌ "All tests pass" but no failure scenarios tested
- ❌ "Feature works" but only success path verified
- ❌ Unit tests pass but integration never tested
- ❌ No manual testing of edge cases

## Edge Case Verification

For each AC, identify and test at least ONE edge case:

| AC | Happy Path Tested | Edge Case Identified | Edge Case Tested |
|----|-------------------|---------------------|------------------|
| AC-1 | ✅ | Empty input | ✅ |
| AC-2 | ✅ | Concurrent access | ❌ (flagged as risk) |
| AC-3 | ✅ | Non-existent resource | ✅ |

**Common edge cases to consider:**
- Empty/null inputs
- Maximum/minimum values
- Concurrent operations
- Non-existent resources
- Permission denied scenarios
- Network/timeout failures
- Invalid state transitions

## Admin Feature Smoke Test

**REQUIRED for `app/admin/` changes:**

```bash
admin_modified=$(git diff main...HEAD --name-only | grep -E "^app/admin/" | head -1)
if [[ -n "$admin_modified" ]]; then
  echo "⚠️ Admin files modified - smoke test required"
fi
```

**Smoke test checklist:**
- [ ] Navigate to `/admin/news` - stat cards show data
- [ ] Navigate to affected feature page - content displays
- [ ] If feature queries `content_updates`, `content_ideas`, `fact_check_logs` - verify data appears

**Smoke test failure = BLOCKER**

## Cache & RLS Verification

**If feature displays content on public pages:**
- [ ] Verify `revalidatePath('/')` called if content appears on homepage
- [ ] Verify `revalidatePath` covers all pages displaying the content
- [ ] Test in incognito (anon client) to verify public reads work

**Check RLS allows public reads:**
```sql
SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'TABLE_NAME';
```

## Integration Smoke Test

**For external system integrations:**

1. **Identify the integration point** - Document: `Integration: <system name>`

2. **Validate assumptions**
   - [ ] API contract verified against official docs
   - [ ] Data format assumptions tested
   - [ ] Authentication method confirmed
   - [ ] Error response handling matches actual API

3. **Manual smoke test**
   - [ ] Actually invoke the integration once
   - [ ] Verify data flows end-to-end
   - [ ] Document: "Tested by: <description>"
