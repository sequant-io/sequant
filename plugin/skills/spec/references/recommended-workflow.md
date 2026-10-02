# Recommended Workflow Format

This document shows the expected output format for the `## Recommended Workflow` section in `/spec` output.

## Resolution chain (#921)

`sequant run` resolves phases through an ordered chain, not `parseRecommendedWorkflow()` alone:

1. **`SEQUANT_SPEC` marker** — a structured HTML comment in the posted plan comment, e.g. `<!-- SEQUANT_SPEC: {"phases":["testgen","exec","qa"],"qualityLoop":true} -->`. This is the primary, durable channel — always emit it alongside the prose section below.
2. **Comment prose** — `parseRecommendedWorkflow()` applied to the plan comment body (same format as this doc).
3. **Chat text** — the same parser applied to the spec agent's chat output. Nondeterministic: only present if the agent happens to restate the section in chat rather than posting via a body file (#814).
4. **Label fallback** — `detectPhasesFromLabels()`. Can never produce `testgen` or `security-review`.

The marker's `phases` array excludes `spec` (it already ran) and must name only registered phases — an unknown phase name invalidates the whole marker and falls through to step 2.

## Format

```markdown
## Recommended Workflow

**Phases:** spec → exec → qa
**Quality Loop:** disabled
**Reasoning:** Brief explanation of why this workflow was chosen.

<!-- SEQUANT_SPEC: {"phases":["exec","qa"],"qualityLoop":false} -->
```

## Examples

### Simple Bug Fix (spec confirms straightforward scope)

```markdown
## Recommended Workflow

**Phases:** exec → qa
**Quality Loop:** disabled
**Reasoning:** This spec pass confirmed a clear root cause and narrow scope — no testgen or additional phases required; proceed to exec.
```

*Note:* Since #533, spec always runs by default. `**Phases:**` lists phases **after** spec — use `exec → qa` here to indicate "spec is done; only exec and qa remain."

### Standard Feature

```markdown
## Recommended Workflow

**Phases:** spec → exec → qa
**Quality Loop:** disabled
**Reasoning:** New feature with defined scope. Standard workflow applies.
```

### UI Feature

```markdown
## Recommended Workflow

**Phases:** spec → exec → test → qa
**Quality Loop:** enabled
**Reasoning:** UI feature requires browser testing and may need iteration.
```

### Security-Sensitive Feature

```markdown
## Recommended Workflow

**Phases:** spec → security-review → exec → qa
**Quality Loop:** disabled
**Reasoning:** Auth-related changes require security analysis before implementation.
```

### Complex Refactor

```markdown
## Recommended Workflow

**Phases:** spec → exec → test → qa
**Quality Loop:** enabled
**Reasoning:** Complex refactor with UI components requires browser testing and iteration.
```

## Phase Separators

The parser supports multiple separator formats:

- Arrow: `spec → exec → qa`
- ASCII arrow: `spec -> exec -> qa`
- Comma: `spec, exec, qa`

## Quality Loop Values

The parser accepts these values for the Quality Loop setting:

- Enabled: `enabled`, `true`, `yes`
- Disabled: `disabled`, `false`, `no`

## Available Phases

| Phase | Description |
|-------|-------------|
| `spec` | Plan review and verification criteria generation |
| `security-review` | Deep security analysis for sensitive features |
| `testgen` | Generate test stubs from specification |
| `exec` | Implementation of the feature |
| `test` | Browser-based testing for UI features |
| `qa` | Code review against acceptance criteria |
| `loop` | Quality iteration loop for fixing issues |
