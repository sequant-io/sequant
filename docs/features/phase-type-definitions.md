# Phase Type Definitions

Workflow phases (`spec`, `exec`, `qa`, etc.) are defined once in a canonical Zod schema. All modules that need the `Phase` type import from this single source.

## Prerequisites

1. **Zod** — already a project dependency (`import { z } from "zod"`)

## Where Phase Is Defined

The canonical definition lives in `src/lib/workflow/types.ts`:

```typescript
export const PhaseSchema = z.enum([
  "spec",
  "security-review",
  "exec",
  "testgen",
  "test",
  "verify",
  "qa",
  "loop",
  "merger",
]);

export type Phase = z.infer<typeof PhaseSchema>;
```

Two other files re-export it (they do **not** define their own copy):

| File | Re-exports | Also exports |
|------|-----------|--------------|
| `state-schema.ts` | `PhaseSchema`, `Phase` | `WORKFLOW_PHASES` (derived from `PhaseSchema.options`) |
| `run-log-schema.ts` | `PhaseSchema`, `Phase` | — |

## Adding a New Phase

1. Add the phase string to the `z.enum([...])` array in `src/lib/workflow/types.ts`
2. Add prompt entries in `src/lib/workflow/phase-executor.ts` (`PHASE_PROMPTS` and `AIDER_PHASE_PROMPTS`)
3. Run `npm run build` — TypeScript will flag any `Record<Phase, ...>` maps missing the new entry
4. Run `npx vitest run src/lib/workflow/phase-types.test.ts` to verify schema identity

No changes needed in `state-schema.ts` or `run-log-schema.ts` — they derive from the canonical source automatically.

## Verdict Types

Merge-check verdict types follow the same pattern in `src/lib/merge-check/types.ts`:

```typescript
export const CHECK_VERDICTS = ["PASS", "WARN", "FAIL"] as const;
export const CheckVerdictSchema = z.enum(CHECK_VERDICTS);
export type CheckVerdict = z.infer<typeof CheckVerdictSchema>;
```

## What to Expect

- `PhaseSchema.options` returns the readonly tuple of all phase strings
- `PhaseSchema.safeParse(value)` validates a string at runtime
- `WORKFLOW_PHASES` in `state-schema.ts` is `PhaseSchema.options` (same object, not a copy)

## Troubleshooting

### Build error: "Property 'newPhase' is missing in type"

**Symptoms:** After adding a phase, `npm run build` fails on `Record<Phase, string>` maps.

**Solution:** Add the new phase to every `Record<Phase, ...>` in the codebase. The two known locations are `PHASE_PROMPTS` and `AIDER_PHASE_PROMPTS` in `phase-executor.ts`.

### Test failure: "expected X toBe Y"

**Symptoms:** `phase-types.test.ts` fails with identity check errors.

**Solution:** A file is defining its own `PhaseSchema` instead of importing from `types.ts`. Check for independent `z.enum` definitions containing `"spec"` and replace with an import.

---

*Generated for Issue #401 on 2026-03-25*
