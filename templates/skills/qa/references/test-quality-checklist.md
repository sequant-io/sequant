# Test Quality Checklist

## Purpose

This checklist helps QA evaluate the quality of tests added or modified during implementation. Tests that pass but don't actually validate behavior create false confidence.

## When to Apply

Apply this checklist when:
- New test files are added
- Existing test files are modified
- AC items specifically mention testing requirements

**Skip if:** No test files were added or modified.

## Checklist Sections

### 1. Behavior vs Implementation

Tests should assert on **observable outputs**, not internal state.

| Check | Pass | Fail |
|-------|------|------|
| Tests assert on return values, rendered output, or API responses | ✅ | ❌ Asserts on private variables or internal state |
| Refactoring internals wouldn't require test changes | ✅ | ❌ Tests break when implementation changes but behavior doesn't |
| Tests describe "what" not "how" | ✅ | ❌ Test names describe implementation details |

**Example - Good:**
```typescript
it('returns user profile when authenticated', async () => {
  const result = await getProfile(validToken);
  expect(result.name).toBe('John');
});
```

**Example - Bad:**
```typescript
it('calls internal _fetchUser method', async () => {
  const spy = jest.spyOn(service, '_fetchUser');
  await getProfile(validToken);
  expect(spy).toHaveBeenCalled(); // Testing implementation, not behavior
});
```

### 2. Coverage Depth

Tests should cover more than the happy path.

| Check | Pass | Fail |
|-------|------|------|
| Error paths tested (what happens when things fail?) | ✅ | ❌ Only success scenarios |
| Boundary conditions tested (empty, null, max values) | ✅ | ❌ Only typical inputs |
| Edge cases identified and tested | ✅ | ❌ Assumes inputs are always valid |

**Required error path tests:**
- [ ] Empty input handling
- [ ] Null/undefined handling
- [ ] Invalid format handling
- [ ] Network/API failure handling (if applicable)
- [ ] Permission denied handling (if applicable)

### 3. Mock Hygiene

Mocks should be minimal and purposeful.

| Check | Pass | Fail |
|-------|------|------|
| Only external dependencies mocked (APIs, DB, file system) | ✅ | ❌ Internal modules mocked |
| Not mocking the thing being tested | ✅ | ❌ Subject under test is partially mocked |
| Mock return values match real API contracts | ✅ | ❌ Mocks return impossible data |
| Mocks cleaned up after tests | ✅ | ❌ Mocks leak between tests |

**Over-mocking indicators:**
- More than 3 modules mocked in a single test file
- Mock setup is longer than the test itself
- Tests pass but feature doesn't work in production

**Example - Over-mocked (bad):**
```typescript
jest.mock('../utils');
jest.mock('../helpers');
jest.mock('../validators');
jest.mock('../formatters');
// 4 mocks for a simple unit test = over-mocking
```

### 4. Test Reliability

Tests should be deterministic and independent.

| Check | Pass | Fail |
|-------|------|------|
| No timing-dependent assertions | ✅ | ❌ Uses setTimeout, expects specific timing |
| Tests are deterministic (same result every run) | ✅ | ❌ Flaky tests that sometimes fail |
| Tests are independent (order doesn't matter) | ✅ | ❌ Tests depend on previous test state |
| Async operations properly awaited | ✅ | ❌ Fire-and-forget async calls |

**Flaky test indicators:**
- Tests that pass locally but fail in CI
- Tests that fail intermittently
- Tests with `setTimeout` or `sleep` calls
- Tests that depend on system time

**Use instead:**
```typescript
// Bad: setTimeout
await new Promise(resolve => setTimeout(resolve, 1000));

// Good: waitFor
await waitFor(() => expect(element).toBeVisible());
```

## Common Anti-Patterns

### 1. Snapshot Abuse

**Problem:** Snapshots used for complex objects instead of specific assertions.

**Detection:**
Use the Glob tool to count snapshot and test files:
```
# Count snapshot files
Glob(pattern="**/*.snap")  # Count results

# Count test files
Glob(pattern="**/*.test.*")  # Count results

# Ratio > 0.5 may indicate overuse
```

**Flag if:**
- Snapshots contain >50 lines
- Snapshot changes are approved without review
- Tests only use `toMatchSnapshot()` with no other assertions

### 2. Test Data Coupling

**Problem:** Tests share mutable state or depend on database seeding order.

**Detection:**
- Look for `beforeAll` that sets up shared state
- Tests that fail when run in isolation (`it.only`)

### 3. Implementation Mirroring

**Problem:** Tests that duplicate the implementation logic.

**Example - Bad:**
```typescript
it('calculates total', () => {
  const items = [{price: 10}, {price: 20}];
  // This mirrors the implementation exactly
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});
```

**Better:**
```typescript
it('calculates total', () => {
  const items = [{price: 10}, {price: 20}];
  expect(calculateTotal(items)).toBe(30); // Known correct value
});
```

### 4. Tautological Tests (Automated Detection)

**Problem:** Tests that pass but don't call any production code. These tests provide zero regression protection.

**Detection:** Automated via `tautology-detector-cli.ts` — runs during QA quality checks.

**Example - Tautological (BAD):**
```typescript
import { processData } from './processor';

it('should process correctly', () => {
  const result = true;  // Never calls processData!
  expect(result).toBe(true);
});
```

**Example - Real Test (GOOD):**
```typescript
import { processData } from './processor';

it('should process correctly', () => {
  const result = processData({ value: 42 });  // Actually calls production code
  expect(result.success).toBe(true);
});
```

**Detection Heuristic:**
1. Extract imports from source modules (relative paths like `./`, `../`)
2. Exclude test libraries (`vitest`, `jest`, `@testing-library`, etc.)
3. Exclude mock/fixture imports (paths containing `mock`, `fixture`, `stub`, etc.)
4. For each `it()` / `test()` block, check if any imported function is called
5. Flag blocks where zero production functions are invoked

**Blocking Threshold:** If >50% of test blocks in the diff are tautological, merge is blocked.

## Output Format

Include this section in QA output when test files are modified:

```markdown
### Test Quality Review

| Category | Status | Notes |
|----------|--------|-------|
| Tautology Check | ✅ OK | All tests call production code |
| Behavior vs Implementation | ✅ OK | Tests assert on outputs |
| Coverage Depth | ⚠️ WARN | Missing error path tests |
| Mock Hygiene | ✅ OK | Minimal mocking |
| Test Reliability | ✅ OK | No timing dependencies |

**Issues Found:**
- `auth.test.ts:45` - Missing error path for invalid token
- `utils.test.ts` - 4 modules mocked (over-mocking)

**Suggestions:**
1. Add test for invalid token scenario
2. Reduce mocks in utils.test.ts to external dependencies only
```

### Tautology Check Output (Automated)

When tautological tests are detected:

```markdown
### Test Quality Review

| Category | Status | Notes |
|----------|--------|-------|
| Tautology Check | ⚠️ WARN | 2 tautological test blocks found (25%) |

**Tautological Tests Found:**
- `src/lib/foo.test.ts:45` - `it("should work")` - No production function calls
- `src/lib/bar.test.ts:12` - `test("validates input")` - No production function calls

**Verdict Impact:** 25% tautological — warning only, review tests before merge
```

When >50% are tautological (blocking):

```markdown
### Test Quality Review

| Category | Status | Notes |
|----------|--------|-------|
| Tautology Check | ❌ FAIL | 3 tautological test blocks found (75%) |

**Tautological Tests Found:**
- `src/lib/foo.test.ts:45` - `it("should work")` - No production function calls
- `src/lib/foo.test.ts:52` - `it("should handle input")` - No production function calls
- `src/lib/bar.test.ts:12` - `test("validates")` - No production function calls

**Verdict Impact:** >50% tautological — blocks `READY_FOR_MERGE`
```

## Verdict Impact

| Test Quality | Verdict Impact |
|--------------|----------------|
| All checks pass | No impact |
| 1-2 warnings | Note in QA, no verdict change |
| Over-mocking (4+ mocks) | `AC_MET_BUT_NOT_A_PLUS` |
| No error path tests | `AC_MET_BUT_NOT_A_PLUS` |
| Tests mirror implementation | `AC_MET_BUT_NOT_A_PLUS` |
| Tautological tests (1-50%) | `AC_MET_BUT_NOT_A_PLUS` |
| **Tautological tests (>50%)** | `AC_NOT_MET` (blocker) |
| Flaky tests introduced | `AC_NOT_MET` (blocker) |
| Tests deleted without justification | `AC_NOT_MET` (blocker) |
