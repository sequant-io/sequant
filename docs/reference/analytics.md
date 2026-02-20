# Local Analytics

Sequant collects local workflow analytics to help you understand your patterns and optimize issue sizing. **All data stays on your machine** - no telemetry is ever sent remotely.

## Overview

Every `sequant run` execution records metrics to `.sequant/metrics.json`. This enables:

- Understanding optimal issue complexity for AI-assisted workflows
- Identifying patterns in success vs. failure
- Tracking changes over time
- Optimizing workflow configuration

## Privacy Principles

1. **Local-only** - Data never leaves your machine
2. **Transparent** - You can inspect `.sequant/metrics.json` anytime
3. **Minimal** - Only collects what's needed for insights
4. **No PII** - No file paths, code content, issue titles, or error messages
5. **User-owned** - Delete anytime with `rm .sequant/metrics.json`

## What We Collect

| Field | Description | Privacy |
|-------|-------------|---------|
| `id` | Unique run identifier (UUID) | Anonymous |
| `date` | Run timestamp | No personal data |
| `issues` | Issue numbers only | No titles/content |
| `phases` | Phases executed | Configuration |
| `outcome` | success/partial/failed | Aggregate status |
| `duration` | Total run time (seconds) | Performance metric |
| `model` | Model used (e.g., "opus") | Configuration |
| `flags` | CLI flags used | Configuration |
| `metrics.filesChanged` | Number of files changed | Aggregate count |
| `metrics.linesAdded` | Lines of code added | Aggregate count |
| `metrics.qaIterations` | QA retry count | Performance metric |
| `metrics.tokensUsed` | Total tokens (input + output) | Usage metric |
| `metrics.inputTokens` | Input tokens consumed | Usage metric |
| `metrics.outputTokens` | Output tokens generated | Usage metric |
| `metrics.cacheTokens` | Cache tokens (creation + read) | Usage metric |

## What We DON'T Collect

- File paths or names
- Code content
- Issue titles or descriptions
- Error messages (could contain sensitive info)
- API keys or credentials
- Any personally identifiable information

## Viewing Analytics

```bash
# Human-readable analytics with insights
sequant stats

# JSON output for programmatic access
sequant stats --json
```

### Example Output

```
📊 Sequant Analytics (local data only)

  Runs: 47 total
    Success: 38 (81%)
    Partial: 6
    Failed: 3

  Averages
  ─────────────────────────────────
  Files changed: 6.2
  Lines added: 380
  Duration: 8m 30s

  Insights
  ─────────────────────────────────
  • Strong success rate: 81%
  • Your sweet spot: 6.2 files changed avg
  • Optimal LOC range: ~380 lines avg

  Data stored locally in .sequant/metrics.json
```

## Insights

The analytics engine generates insights based on your historical data:

### Success Rate Insights
- **Strong** (≥80%): Your workflow is effective
- **Moderate** (60-79%): Consider simpler acceptance criteria
- **Low** (<60%): Review issue complexity

### File Change Insights
- **Sweet spot** (≤5 files): Optimal scope
- **Moderate** (5-10 files): Acceptable scope
- **High** (>10 files): Consider splitting issues

### Lines of Code Insights
- **Optimal** (200-400 LOC): Good issue sizing
- **Large** (>500 LOC): Consider splitting issues

### Mode Comparison
- Compares chain mode vs. single issue success rates
- Compares multi-issue vs. single issue runs

## JSON Schema

### Metrics File (version 1)

```typescript
interface Metrics {
  version: 1;
  runs: MetricRun[];
}

interface MetricRun {
  id: string;              // UUID
  date: string;            // ISO 8601
  issues: number[];        // Issue numbers only
  phases: Phase[];         // Executed phases
  outcome: "success" | "partial" | "failed";
  duration: number;        // Seconds
  model: string;           // e.g., "opus"
  flags: string[];         // e.g., ["--chain"]
  metrics: RunMetrics;
}

interface RunMetrics {
  tokensUsed: number;        // Total tokens (input + output)
  filesChanged: number;
  linesAdded: number;
  acceptanceCriteria: number;
  qaIterations: number;
  inputTokens?: number;      // Input tokens consumed
  outputTokens?: number;     // Output tokens generated
  cacheTokens?: number;      // Cache tokens (creation + read)
}

type Phase = "spec" | "security-review" | "testgen" | "exec" | "test" | "qa" | "loop";
```

## Token Usage Tracking

Sequant captures token usage from Claude Code sessions via a `SessionEnd` hook. This populates `metrics.tokensUsed` (previously always 0) with actual consumption data.

### How It Works

1. A `SessionEnd` hook (`.claude/hooks/capture-tokens.sh`) parses the Claude Code transcript JSONL
2. Token totals are written to `.sequant/.token-usage-<session-id>.json`
3. After a run completes, `run.ts` reads and aggregates all token files
4. Totals are recorded in metrics with input/output/cache breakdown
5. Token files are cleaned up after reading

### Viewing Token Usage

```bash
# See token averages in stats output
sequant stats

# Query token data with jq
jq '.runs[] | select(.metrics.tokensUsed > 0) |
  {date, tokens: .metrics.tokensUsed,
   input: .metrics.inputTokens,
   output: .metrics.outputTokens}' \
  .sequant/metrics.json
```

### Limitations

- Token data is per-run, not per-phase
- Requires the `SessionEnd` hook to be registered in `.claude/settings.json`
- Transcript must be available at session end

## Configuration

Metrics collection is automatic and cannot be disabled (it's privacy-respecting by design). The file is stored at `.sequant/metrics.json` in your project.

### Gitignore

The `.sequant/` directory is already in the default `.gitignore` template, so your local analytics won't be committed:

```
# .gitignore
.sequant/
```

## Analyzing with jq

```bash
# Count total runs
jq '.runs | length' .sequant/metrics.json

# Get success rate
jq '[.runs[].outcome] | group_by(.) | map({outcome: .[0], count: length})' .sequant/metrics.json

# Average files changed
jq '[.runs[].metrics.filesChanged] | add / length' .sequant/metrics.json

# Runs with >10 files changed
jq '.runs[] | select(.metrics.filesChanged > 10) | {date, issues, filesChanged: .metrics.filesChanged}' .sequant/metrics.json

# Chain mode runs
jq '.runs[] | select(.flags | contains(["--chain"]))' .sequant/metrics.json
```

## Deleting Analytics

To remove all local analytics:

```bash
rm .sequant/metrics.json
```

A new file will be created on the next `sequant run`.

## Comparison with Logging

| Feature | Logging (.sequant/logs/) | Analytics (.sequant/metrics.json) |
|---------|--------------------------|-----------------------------------|
| Purpose | Debugging, audit trail | Pattern analysis, insights |
| Contains | Full execution details | Aggregate metrics only |
| Privacy | May contain file paths | Privacy-focused, no paths |
| Size | Grows with each run | Single file, compact |
| Retention | Rotated by size/count | Kept indefinitely |

Use **logging** when you need to debug specific runs.
Use **analytics** when you want to understand patterns over time.
