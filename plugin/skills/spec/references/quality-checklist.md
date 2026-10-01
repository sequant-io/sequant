# Feature Quality Planning — Full Checklist

Use this checklist for **Complex** tier issues or when the exception-based summary in SKILL.md flags significant gaps. For Simple/Standard tiers, the exception-based approach in the main prompt is sufficient.

## Section Applicability

| Issue Type | Sections Required |
|------------|-------------------|
| Bug fix | Completeness, Error Handling, Test Coverage |
| New feature | All sections |
| Refactor | Completeness, Code Quality, Test Coverage |
| UI change | All sections including Polish |
| Backend/API | Completeness, Error Handling, Code Quality, Test Coverage, Best Practices |
| CLI/Script | Completeness, Error Handling, Test Coverage, Best Practices |
| Docs only | Completeness only |

## Completeness Check

- [ ] All AC items have corresponding implementation steps
- [ ] Integration points with existing features identified
- [ ] No partial implementations or TODOs planned
- [ ] State management considered (if applicable)
- [ ] Data flow is complete end-to-end

## Error Handling

- [ ] Invalid input scenarios identified
- [ ] API/external service failures handled
- [ ] Edge cases documented (empty, null, max values)
- [ ] Error messages are user-friendly
- [ ] Graceful degradation planned

## Code Quality

- [ ] Types fully defined (no `any` planned)
- [ ] Follows existing patterns in codebase
- [ ] Error boundaries where needed
- [ ] No magic strings/numbers
- [ ] Consistent naming conventions

## Test Coverage Plan

- [ ] Unit tests for business logic
- [ ] Integration tests for data flow
- [ ] Edge case tests identified
- [ ] Mocking strategy appropriate
- [ ] Critical paths have test coverage

## Best Practices

- [ ] Logging for debugging/observability
- [ ] Accessibility considerations (if UI)
- [ ] Performance implications considered
- [ ] Security reviewed (auth, validation, sanitization)
- [ ] Documentation updated (if behavior changes)

## Polish (UI features only)

- [ ] Loading states planned
- [ ] Error states have UI
- [ ] Empty states handled
- [ ] Responsive design considered
- [ ] Keyboard navigation works

## Derived ACs

Based on quality planning, identify additional ACs:

| Source | Derived AC | Priority |
|--------|-----------|----------|
| Error Handling | AC-N: Handle [specific error] with [specific response] | High/Medium/Low |
| Test Coverage | AC-N+1: Add tests for [specific scenario] | High/Medium/Low |
| Best Practices | AC-N+2: Add logging for [specific operation] | High/Medium/Low |

Derived ACs are numbered sequentially after original ACs.
