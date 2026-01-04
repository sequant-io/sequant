# Verification Criteria Guide

## Why Verification Criteria Matter

The #452 hooks issue passed all workflow phases but failed in production because we didn't validate the assumption "Claude Code passes data via stdin JSON" until after implementation.

Verification criteria force you to:
- Define HOW to verify each AC works (not just WHAT to build)
- List assumptions explicitly so they can be validated BEFORE coding
- Identify integration points that need testing

## Verification Method Guidelines

| Method | Use When | Example |
|--------|----------|---------|
| **Unit Test** | Pure logic, utilities, helpers | `formatCurrency()`, `validateEmail()` |
| **Integration Test** | External APIs, database, file system | Hook scripts, Supabase queries |
| **Browser Test** | UI interactions, forms, modals | Admin dashboard, form validation |
| **Manual Test** | One-time setup, visual verification | Deployment checks, design review |
| **N/A - Trivial** | Config changes, simple renames | Env var addition, label change |

## If Verification Method Unclear

- Add a warning: `⚠️ Verification unclear - consider breaking down this AC`
- Ask clarifying questions before proceeding
- Default to "Manual Test" with explicit steps if truly simple

## Example: How Verification Criteria Would Have Caught #452

### Original AC (no verification criteria)

```markdown
AC-1: Timing logs capture start/end of each tool call
```

### Enhanced AC (with verification criteria)

```markdown
### AC-1: Timing logs capture start/end of each tool call

**Verification Method:** Integration Test

**Test Scenario:**
- Given: Claude Code session with hooks enabled
- When: Any tool is invoked (e.g., Edit, Read)
- Then: /tmp/claude-timing.log contains START and END with tool name and timestamp

**Integration Points:**
- Claude Code hook system (stdin JSON input)
- File system (/tmp directory)

**Assumptions to Validate:**
- [ ] Claude Code passes tool data via stdin JSON (NOT env vars) ← WOULD HAVE CAUGHT THE BUG
- [ ] stdin JSON contains tool_name field
- [ ] stdin JSON contains tool_input field
- [ ] Hook can parse JSON with jq
- [ ] Hook has write permission to /tmp
```

The assumption "Claude Code passes tool data via stdin JSON" would have been explicitly listed, forcing validation BEFORE implementation. The bug would have been caught at planning time, not after 3 merged PRs.

## Verification Summary Template

Use this format in the issue comment:

```markdown
## Verification Summary

| AC | Verification Method | Key Assumption |
|----|---------------------|----------------|
| AC-1 | Integration Test | stdin JSON format |
| AC-2 | Unit Test | None |
| AC-3 | Browser Test | Modal renders correctly |

### Assumptions to Validate (Before Implementation)
- [ ] [Assumption from AC-1]
- [ ] [Assumption from AC-3]
```

## Common Assumptions to Validate

**For API Integrations:**
- Response format matches documentation
- Authentication method works as expected
- Error codes are handled appropriately
- Rate limits are within acceptable bounds

**For Database Features:**
- Table schema matches TypeScript types
- RLS policies allow required access
- Indexes exist for query patterns
- Foreign key relationships are correct

**For UI Features:**
- Component renders without hydration mismatch
- Mobile/desktop breakpoints work correctly
- Loading states display properly
- Error states show appropriate messages

**For External Integrations:**
- Environment variables are set correctly
- Network connectivity works in all environments
- Timeouts are appropriate
- Fallback behavior is defined
