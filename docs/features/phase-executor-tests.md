# Phase Executor Unit Tests

Unit test coverage for `src/lib/workflow/phase-executor.ts`, a core orchestration module that handles phase execution, cold-start retry logic, MCP fallback, and QA verdict parsing.

## What's Tested

### `parseQaVerdict()`

Parses QA verdict strings from agent output. Covers all four verdict types across multiple formats:

| Format | Example |
|--------|---------|
| Markdown header | `### Verdict: READY_FOR_MERGE` |
| Bold label | `**Verdict:** AC_NOT_MET` |
| Bold-wrapped value | `**Verdict:** **AC_MET_BUT_NOT_A_PLUS**` |
| Plain text | `Verdict: NEEDS_VERIFICATION` |

Also tests case insensitivity, multi-line extraction, and null returns for empty/invalid input.

### `formatDuration()`

Formats elapsed seconds into human-readable strings:

| Input | Output |
|-------|--------|
| `0` | `0.0s` |
| `30.5` | `30.5s` |
| `90` | `1m 30s` |
| `3661` | `61m 1s` |

### `getPhasePrompt()`

Generates phase-specific prompts with issue number substitution. Tests:

- `{issue}` placeholder substitution in all positions
- AGENTS.md content inclusion when the file exists
- Graceful handling when AGENTS.md is absent
- Prompt selection for Claude vs non-Claude agents (aider uses direct CLI instructions)

### `executePhaseWithRetry()`

Tests the cold-start retry and MCP fallback logic using an injected `executePhaseFn`:

| Scenario | Expected Behavior |
|----------|-------------------|
| First-attempt success | Returns immediately, 1 call |
| Cold-start failures (< 60s) | Retries up to 2 times before fallback |
| MCP fallback | Disables MCP after retry exhaustion, tries once more |
| `retry: false` | No retries, returns on first failure |
| Genuine failure (>= 60s) | No retry — treated as real failure, not cold-start |
| MCP already disabled | Skips MCP fallback step |
| MCP fallback also fails | Returns original error, not fallback error |

## Running the Tests

```bash
npx vitest run src/lib/workflow/phase-executor.test.ts
```

## Troubleshooting

### Tests fail after modifying phase-executor.ts

**Symptoms:** `getPhasePrompt` tests fail with unexpected content.

**Solution:** The tests check for specific prompt content like `/spec 42` or `/exec 10`. If you change the prompt templates in `PHASE_PROMPTS` or `AIDER_PHASE_PROMPTS`, update the test assertions to match.

### Mock setup errors

**Symptoms:** `readAgentsMd` is not a function or mock not working.

**Solution:** The test file mocks `../agents-md.js` at the module level with `vi.mock()`. Ensure the import path hasn't changed if you've restructured the module.

---

*Generated for Issue #378 on 2026-03-25*
