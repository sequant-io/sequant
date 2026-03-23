# GitHub Actions Integration

Run Sequant workflows as CI steps — label an issue, get a PR back.

## Prerequisites

1. **GitHub repository** with Actions enabled
2. **Sequant initialized** in the repo — `npx sequant init`
3. **API key** stored as a GitHub Actions secret:
   - Claude Code (default): `ANTHROPIC_API_KEY`
   - Aider or Codex: `OPENAI_API_KEY`

   Add secrets at: **Settings > Secrets and variables > Actions > New repository secret**

## Setup

Copy one of the example workflows below into `.github/workflows/` in your repository.

### Option A: Label trigger (recommended)

The simplest setup. Label an issue with `sequant:solve` and the action runs the full workflow.

Create `.github/workflows/sequant-solve.yml`:

```yaml
name: AI Solve Issue

on:
  issues:
    types: [labeled]

concurrency:
  group: sequant-issue-${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  solve:
    if: github.event.label.name == 'sequant:solve'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions:
      contents: write
      issues: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v4

      - uses: sequant-io/sequant-action@v1
        with:
          issues: ${{ github.event.issue.number }}
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Option B: Manual dispatch

Trigger from the Actions UI with custom inputs — useful for batch processing or selecting specific phases.

Create `.github/workflows/sequant-dispatch.yml`:

```yaml
name: Sequant Dispatch

on:
  workflow_dispatch:
    inputs:
      issues:
        description: "Issue numbers (space-separated)"
        required: true
      phases:
        description: "Phases to run (comma-separated)"
        default: "spec,exec,qa"
      agent:
        description: "Agent backend"
        default: "claude-code"
        type: choice
        options:
          - claude-code
          - aider
          - codex
      timeout:
        description: "Phase timeout (seconds)"
        default: "1800"

concurrency:
  group: sequant-dispatch
  cancel-in-progress: false

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    permissions:
      contents: write
      issues: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v4

      - uses: sequant-io/sequant-action@v1
        with:
          issues: ${{ github.event.inputs.issues }}
          phases: ${{ github.event.inputs.phases }}
          agent: ${{ github.event.inputs.agent }}
          timeout: ${{ github.event.inputs.timeout }}
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Option C: Comment trigger

Comment `@sequant run spec,exec,qa` on any issue to trigger a workflow.

Create `.github/workflows/sequant-comment.yml`:

```yaml
name: Sequant Comment Trigger

on:
  issue_comment:
    types: [created]

concurrency:
  group: sequant-issue-${{ github.event.issue.number }}
  cancel-in-progress: false

jobs:
  parse-and-run:
    if: contains(github.event.comment.body, '@sequant run')
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions:
      contents: write
      issues: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v4

      - id: parse
        shell: bash
        env:
          COMMENT_BODY: ${{ github.event.comment.body }}
        run: |
          PHASES=$(echo "$COMMENT_BODY" | sed -n 's/.*@sequant[[:space:]]\+run[[:space:]]\+\([a-zA-Z,_-]\+\).*/\1/p' | head -1)
          if [[ -z "$PHASES" ]]; then
            PHASES="spec,exec,qa"
          fi
          echo "phases=$PHASES" >> "$GITHUB_OUTPUT"

      - uses: sequant-io/sequant-action@v1
        with:
          issues: ${{ github.event.issue.number }}
          phases: ${{ steps.parse.outputs.phases }}
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## What You Can Do

### Solve an issue from a label

1. Open any GitHub issue
2. Add the label `sequant:solve`
3. The action runs spec, exec, and QA phases
4. On success: a PR appears linked to the issue
5. On failure: findings are posted as an issue comment

### Run specific phases

Use phase-specific labels to run only part of the workflow:

| Label | Phases run |
|-------|-----------|
| `sequant:solve` | spec, exec, qa |
| `sequant:spec-only` | spec |
| `sequant:exec` | exec |
| `sequant:qa` | qa |

Or with comment triggers: `@sequant run exec,qa` (skip spec).

### Process multiple issues at once

With manual dispatch, pass space-separated issue numbers:

```
Issues: 42 99 105
```

Each issue gets its own worktree, phases, and PR.

## What to Expect

- **Duration:** 10-30 minutes per issue depending on complexity and phases
- **Labels change during the run:** `sequant:solve` is replaced by `sequant:solving`, then `sequant:done` or `sequant:failed`
- **Results are posted as issue comments** with a summary table showing phases, duration, and outcome
- **Run logs are uploaded as artifacts** (retained for 30 days) — find them in the Actions run details under "Artifacts"
- **Concurrency is enforced** — only one Sequant run per issue at a time; additional runs queue

## Action Reference

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `issues` | No | *(from event)* | Issue numbers, space-separated. Auto-detected from label/comment events. |
| `phases` | No | `spec,exec,qa` | Phases to execute, comma-separated. |
| `agent` | No | `claude-code` | Agent backend: `claude-code`, `aider`, or `codex`. |
| `timeout` | No | `1800` | Phase timeout in seconds (min: 60, max: 7200). |
| `quality-loop` | No | `false` | Enable quality loop with auto-retry on QA failure. |
| `api-key` | **Yes** | — | API key for the selected agent. Pass via `${{ secrets.* }}`. |
| `sequant-version` | No | `^1` | Sequant npm version range. Pin for reproducible builds. |

### Outputs

| Output | Description |
|--------|-------------|
| `success` | `"true"` or `"false"` — whether all phases passed |
| `pr-url` | URL of the created PR (empty if no PR) |
| `summary` | JSON array of phase results |
| `issue` | Issue number(s) processed |
| `duration` | Total duration in seconds |

Use outputs in downstream steps:

```yaml
- uses: sequant-io/sequant-action@v1
  id: sequant
  with:
    issues: "42"
    api-key: ${{ secrets.ANTHROPIC_API_KEY }}

- if: steps.sequant.outputs.success == 'true'
  run: echo "PR created at ${{ steps.sequant.outputs.pr-url }}"
```

### Label lifecycle

```
sequant:solve (trigger)
    |
    v
sequant:solving (in progress)
    |
    +---> sequant:done (success, PR created)
    |
    +---> sequant:failed (failure, findings posted)
```

## Repo-Level Configuration

Set defaults for all Sequant CI runs without editing workflow files.

Create `.github/sequant.yml`:

```yaml
# Default agent for this repo
agent: claude-code

# Default phases
phases: spec,exec,qa

# Phase timeout in seconds
timeout: 1800

# Enable quality loop by default
qualityLoop: false

# Max concurrent Sequant runs
maxConcurrentRuns: 1
```

Or `.sequant/ci.json` (JSON alternative):

```json
{
  "agent": "claude-code",
  "phases": ["spec", "exec", "qa"],
  "timeout": 1800,
  "maxConcurrentRuns": 1
}
```

**Merge precedence:** workflow inputs > config file > action defaults.

## Troubleshooting

### Action fails with "No issue numbers provided"

**Symptoms:** Error in the resolve step: `No issue numbers provided and cannot detect from event context`

**Solution:** Ensure your workflow trigger provides issue context. For `workflow_dispatch`, pass issue numbers explicitly via the `issues` input. For label/comment triggers, the issue number is auto-detected from the event.

### Action fails with "GitHub CLI authentication failed"

**Symptoms:** Error in the auth step: `GitHub CLI authentication failed`

**Solution:** The action uses `${{ github.token }}` automatically. If you see this error, check that your workflow has the required permissions:

```yaml
permissions:
  contents: write
  issues: write
  pull-requests: write
```

### Labels not changing

**Symptoms:** The `sequant:solving` / `sequant:done` / `sequant:failed` labels don't appear.

**Solution:** Ensure the workflow has `issues: write` permission. The action needs permission to edit issue labels.

### Run takes too long or times out

**Symptoms:** The run exceeds `timeout-minutes` or the phase timeout.

**Solution:** Increase the timeout. The action has two timeout layers:
1. **Phase timeout** (`timeout` input, default 1800s / 30 min) — controls individual phase duration
2. **Workflow timeout** (`timeout-minutes` in the workflow YAML) — controls the entire job

Set the workflow timeout higher than the sum of all phase timeouts.

---

*Generated for Issue #370 on 2026-03-23*
