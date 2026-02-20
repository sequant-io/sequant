# Call-Site Review Checklist

## Purpose

When new exported functions are added, QA must review not just the function itself but **where** and **how** it's called. A function can be perfectly implemented but called incorrectly at the call site.

**Origin:** Issue #295 — `rebaseBeforePR()` had thorough unit tests but was called for every issue in a chain loop when the AC specified "only the final branch."

## When to Apply

This review is **triggered** when new exported functions are detected in the diff:

```bash
# Detect new exported functions (added lines only)
git diff main...HEAD | grep -E '^\+export (async )?function \w+' | sed 's/^+//'
```

## Review Steps

### Step 1: Inventory All Call Sites

For each new exported function, find where it's called:

```bash
# Find call sites for a function
grep -rn "functionName(" --include="*.ts" --include="*.tsx" . | grep -v "\.test\." | grep -v "__tests__"
```

### Step 2: Analyze Call-Site Conditions

For each call site, identify:

1. **What conditions gate the call?**
   - `if` statements, `&&` guards, ternaries
   - Mode flags, feature flags, environment checks

2. **Is it in a loop?**
   - `for`, `while`, `forEach`, `.map()`, `.filter()`, etc.
   - If yes: Should it run for every iteration or only specific ones?

3. **Is it in an async context?**
   - Is `await` used appropriately?
   - Could it cause race conditions?

4. **Error handling at call site?**
   - Is the call wrapped in try/catch?
   - What happens if the function throws?

### Step 3: AC Constraint Matching

Compare call-site conditions against AC constraints:

| AC Constraint | Call Site Check |
|---------------|-----------------|
| "Only for X" | Is there a guard: `if (X)` before the call? |
| "When Y happens" | Is the call triggered by the Y event/condition? |
| "Not in Z mode" | Is there a guard: `if (!Z)` or similar? |
| "Final item only" | If in loop, is there an index check or break? |

### Step 4: Loop Iteration Review

When a function is called inside a loop, answer:

1. **Iteration scope:**
   - Should it run for ALL iterations? → OK
   - Should it run for FIRST/LAST only? → Check for index guard
   - Should it run for SOME iterations? → Check for condition filter

2. **Common patterns to verify:**
   ```typescript
   // LAST only - should have index check
   for (let i = 0; i < items.length; i++) {
     if (i === items.length - 1) {
       newFunction(); // ✅ Guarded for last
     }
   }

   // FIRST only - should have index check
   items.forEach((item, index) => {
     if (index === 0) {
       newFunction(); // ✅ Guarded for first
     }
   });

   // CONDITIONAL - should have filter
   for (const item of items) {
     if (item.shouldProcess) {
       newFunction(item); // ✅ Conditionally called
     }
   }
   ```

3. **Red flags:**
   - Function called unconditionally in loop when AC says "only once"
   - No break/return after the call when AC implies single execution
   - Missing mode/flag guard when AC specifies conditions

### Step 5: Mode/Flag Sensitivity

If the function behaves differently based on mode flags:

1. **Identify mode parameters:**
   - Does the function accept `options` or `config`?
   - Are there mode-specific code paths inside?

2. **Verify at call site:**
   - Is the mode passed correctly?
   - Does the caller's context match the mode expected?

## Output Format

```markdown
### Call-Site Review

**New exported functions detected:** N

| Function | Call Sites | Loop? | Conditions | AC Match |
|----------|-----------|-------|------------|----------|
| `newFunction()` | `file.ts:123` | No | `if (condition)` | ✅ Matches AC-2 |
| `anotherFunc()` | `run.ts:456` | Yes (forEach) | None | ⚠️ Missing guard (AC-3 says "final only") |
| `thirdFunc()` | Not called | - | - | ⚠️ Unused export |

**Findings:**
- `anotherFunc()` is called in a loop without iteration guard. AC-3 specifies "only for the final item."

**Recommendations:**
1. Add index check: `if (index === items.length - 1)` before calling `anotherFunc()`
```

## Verdict Impact

| Finding | Verdict Impact |
|---------|----------------|
| All call sites match AC | No impact |
| Call site missing AC-required guard | `AC_NOT_MET` |
| Function not called anywhere | `AC_MET_BUT_NOT_A_PLUS` (dead export) |
| Call site in loop, AC unclear about iteration | `NEEDS_VERIFICATION` |

## Examples

### Example 1: Missing Chain Mode Guard (Issue #295)

**AC:** "Rebase only the final branch in a chain"

**Detection:**
```bash
grep -rn "rebaseBeforePR(" --include="*.ts" .
# Output: src/run.ts:2977:  await rebaseBeforePR(worktreePath)
```

**Analysis:**
```typescript
// Found in loop over all chain issues
for (const result of chainResults) {
  if (result.success && result.worktreePath) {
    await rebaseBeforePR(result.worktreePath);  // ⚠️ Called for ALL
  }
}
```

**Finding:** No guard for "final only" — function called for every issue in chain.

**Fix:** Add final-issue check:
```typescript
for (let i = 0; i < chainResults.length; i++) {
  const result = chainResults[i];
  const isFinal = i === chainResults.length - 1;
  if (result.success && result.worktreePath && isFinal) {
    await rebaseBeforePR(result.worktreePath);  // ✅ Only final
  }
}
```

### Example 2: Correct Guard Present

**AC:** "Send notification only when status is 'complete'"

**Detection:**
```bash
grep -rn "sendNotification(" --include="*.ts" .
# Output: src/handlers.ts:89:  sendNotification(user.email, message)
```

**Analysis:**
```typescript
// Found with proper guard
if (task.status === 'complete') {
  sendNotification(user.email, message);  // ✅ Guarded
}
```

**Finding:** Call site condition matches AC constraint. No issues.
