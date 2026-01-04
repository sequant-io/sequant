# Parallel Groups for Implementation

When the implementation involves 3+ independent tasks that could be parallelized, include a `## Parallel Groups` section to enable `/exec` to run them concurrently. This can reduce execution time by 50-70%.

## When to Include Parallel Groups

- Creating multiple independent files (types, migrations, components)
- Tasks that don't share dependencies
- Issues with 5+ implementation steps

## Dependency Analysis Rules

- **Group 1 (no dependencies):** Tasks that create new files without importing from other new files
- **Group 2+ (depends on previous):** Tasks that import from files created in earlier groups
- **Sequential (final):** Tests, integration work, and tasks that depend on multiple groups

## File-Level Heuristics

- `types/*.ts` → Usually Group 1 (no imports from other new files)
- `migrations/*.sql` → Usually Group 1 (independent of TypeScript)
- `lib/services/*.ts` → Group 2 if they import new types
- `components/*.tsx` → Group 2 if they import new types/services
- `app/**/*.tsx` → Sequential (integrates components)
- `__tests__/*.ts` → Sequential (tests all the above)

## Model Selection

Include a `[model: haiku]` or `[model: sonnet]` annotation at the end of each task line:

| Task Type | Recommended Model |
|-----------|------------------|
| Single file, explicit path | `[model: haiku]` |
| New file with template | `[model: haiku]` |
| <5 lines changed | `[model: haiku]` |
| Edit requiring context | `[model: sonnet]` |
| Multiple related files | `[model: sonnet]` |
| Refactoring | `[model: sonnet]` |
| Import/dependency changes | `[model: sonnet]` |

## Format Example

```markdown
## Parallel Groups

### Group 1 (no dependencies)
- [ ] Create `types/metrics.ts` with MetricEvent interface [model: haiku]
- [ ] Add `migrations/add_metrics_table.sql` [model: haiku]

### Group 2 (depends on Group 1)
- [ ] Create `lib/services/metrics-service.ts` [model: haiku]
- [ ] Refactor `lib/hooks/useMetrics.ts` to use new service [model: sonnet]

### Sequential (depends on Group 2)
- [ ] Integrate into `app/shops/[slug]/page.tsx`
- [ ] Add tests in `__tests__/metrics.test.ts`
```

## Important Rules

- Maximum 3 parallel tasks per group (prevents resource exhaustion)
- If all tasks are sequential, omit this section entirely
- `/exec` will fall back to sequential execution if this section is missing
- If no model annotation is provided, `/exec` defaults to haiku
- Use `CLAUDE_PARALLEL_MODEL=sonnet` env var to override all annotations

## No Parallel Groups

If the implementation is purely sequential, don't add this section. Examples:
- Bug fixes affecting a single file
- Simple additions to existing components
- Config changes
- Documentation updates
