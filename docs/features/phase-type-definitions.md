# Phase Type Definitions

Workflow phases (`spec`, `exec`, `qa`, etc.) are defined once in the **phase registry** and exposed through a Zod refinement schema. All modules that need the `Phase` type import from a single source.

## Prerequisites

1. **Zod** — already a project dependency (`import { z } from "zod"`)

## Where Phase Is Defined

Two cooperating files in `src/lib/workflow/`:

- `phase-registry.ts` — the registry singleton plus the built-in `phaseRegistry.register(...)` calls at the bottom of the file (canonical pipeline order).
- `types.ts` — exports `PhaseSchema` (a Zod string refinement backed by `phaseRegistry.has(name)`) and the `Phase` type alias (`string`).

```typescript
// src/lib/workflow/types.ts
import { phaseRegistry, getPhaseNames } from "./phase-registry.js";

export const PhaseSchema = z
  .string()
  .refine((name) => phaseRegistry.has(name), {
    error: (issue) =>
      `Unknown phase "${String(issue.input)}". Available: ${getPhaseNames().join(", ")}`,
  });

export type Phase = string;
```

Two other files re-export it (they do **not** define their own copy):

| File | Re-exports | Also exports |
|------|-----------|--------------|
| `state-schema.ts` | `PhaseSchema`, `Phase` | `WORKFLOW_PHASES` (derived from `getPhaseNames()`) |
| `run-log-schema.ts` | `PhaseSchema`, `Phase` | — |

## Adding a New Phase

1. Add a `phaseRegistry.register({ ... })` call in the built-in section at the bottom of `src/lib/workflow/phase-registry.ts`. Required fields: `name`, `skill`, `promptTemplate`, `requiresWorktree`. Optional: `retryStrategy`, `detect`, `driverOverrides`, `order`.
2. Insertion order in `phase-registry.ts` IS the canonical pipeline order — place the new entry where it should run.
3. Run `npm run build` — the build will pass because `Phase` is now `string`; there are no `Record<Phase, ...>` maps left to update.
4. Run `npx vitest run src/lib/workflow/phase-types.test.ts` to verify schema identity and registry consistency.

No changes needed in `types.ts`, `state-schema.ts`, or `run-log-schema.ts` — they read from the registry automatically.

## Verdict Types

Merge-check verdict types still follow the simpler typed-enum pattern in `src/lib/merge-check/types.ts`:

```typescript
export const CHECK_VERDICTS = ["PASS", "WARN", "FAIL"] as const;
export const CheckVerdictSchema = z.enum(CHECK_VERDICTS);
export type CheckVerdict = z.infer<typeof CheckVerdictSchema>;
```

The phase registry pattern is only used for `Phase` because phases carry per-entry metadata (prompts, retry strategy, detect rules) that a typed-enum cannot express.

## What to Expect

- `getPhaseNames()` (from `phase-registry.ts`) returns all registered phase names in insertion order. This replaces the prior `PhaseSchema.options` array.
- `phaseRegistry.get(name)` returns the full `PhaseDefinition` (prompts, worktree flag, etc.); throws with a "did you mean" list on unknown names.
- `PhaseSchema.safeParse(value)` validates a string at runtime against the registry.
- `WORKFLOW_PHASES` in `state-schema.ts` is `getPhaseNames()` (a snapshot of the registry).

## Troubleshooting

### Runtime error: `Unknown phase "..."`

**Symptoms:** `PhaseSchema.parse(name)` or `phaseRegistry.get(name)` throws with the registered-names list.

**Solution:** Either typo in the phase name, or a new phase wasn't registered. Confirm a `phaseRegistry.register(...)` call exists in `phase-registry.ts` for the name.

### Test failure: `phase-types.test.ts` identity check

**Symptoms:** Test fails with "expected X toBe Y" or similar.

**Solution:** A file is defining its own `PhaseSchema` instead of importing from `types.ts`, or registering a phase twice. Check for independent `z.enum`/`z.string` definitions containing `"spec"`, and check for duplicate `phaseRegistry.register({ name: "..." })` calls.

---

*Generated for Issue #401 on 2026-03-25. Updated for Issue #505 (registry migration).*
