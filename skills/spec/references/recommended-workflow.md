# Recommended Workflow Format

This document shows the expected output format for the `## Recommended Workflow` section in `/spec` output. The `parseRecommendedWorkflow()` function parses this format to determine which phases to execute.

## Format

```markdown
## Recommended Workflow

**Phases:** spec → exec → qa
**Quality Loop:** disabled
**Reasoning:** Brief explanation of why this workflow was chosen.
```

## Examples

### Simple Bug Fix

```markdown
## Recommended Workflow

**Phases:** exec → qa
**Quality Loop:** disabled
**Reasoning:** Straightforward bug fix with clear root cause. No planning needed.
```

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
