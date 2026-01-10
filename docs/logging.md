# Logging System

Sequant provides structured JSON logging for workflow runs, enabling analysis, debugging, and integration with external tools.

## Overview

Every `sequant run` execution produces a JSON log file in `.sequant/logs/`. These logs capture:

- Run configuration (phases, settings)
- Issue execution details (timing, status)
- Phase-level metrics (duration, errors)
- Summary statistics

## Configuration

Logging is enabled by default. Configure via `.sequant/settings.json`:

```json
{
  "version": "1.0",
  "run": {
    "logJson": true,
    "logPath": ".sequant/logs",
    "rotation": {
      "enabled": true,
      "maxSizeMB": 10,
      "maxFiles": 100
    }
  }
}
```

### CLI Flags

| Flag | Description |
|------|-------------|
| `--log-json` | Enable JSON logging (default: true) |
| `--no-log` | Disable logging for this run |
| `--log-path <path>` | Custom log directory |

## Log Rotation

To prevent unbounded log growth, Sequant automatically rotates old logs when thresholds are exceeded.

### Thresholds

- **Size**: Rotate when total log size exceeds `maxSizeMB` (default: 10MB)
- **Count**: Rotate when file count exceeds `maxFiles` (default: 100)

When rotation triggers, the oldest logs are deleted until the directory is at 90% of the threshold (a 10% buffer prevents immediate re-rotation).

### Manual Rotation

```bash
# Preview what would be deleted
sequant logs --rotate --dry-run

# Actually rotate logs
sequant logs --rotate
```

## Statistics

Use `sequant stats` for aggregate analysis across all runs:

```bash
# Human-readable summary
sequant stats

# CSV export
sequant stats --csv > runs.csv

# JSON output
sequant stats --json
```

### Output Includes

- Total runs and issues processed
- Success/failure rates
- Average phase durations
- Common failure points

## JSON Schema Reference

### Run Log (version 1)

```typescript
interface RunLog {
  version: 1;
  runId: string;           // UUID
  startTime: string;       // ISO 8601
  endTime: string;         // ISO 8601
  config: RunConfig;
  issues: IssueLog[];
  summary: RunSummary;
}

interface RunConfig {
  phases: Phase[];         // ["spec", "exec", "qa"]
  sequential: boolean;
  qualityLoop: boolean;
  maxIterations: number;
}

interface IssueLog {
  issueNumber: number;
  title: string;
  labels: string[];
  status: "success" | "failure" | "partial";
  phases: PhaseLog[];
  totalDurationSeconds: number;
}

interface PhaseLog {
  phase: Phase;
  issueNumber: number;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  status: "success" | "failure" | "timeout" | "skipped";
  error?: string;
  iterations?: number;     // For loop phase
  filesModified?: string[];
  testsRun?: number;
  testsPassed?: number;
}

interface RunSummary {
  totalIssues: number;
  passed: number;
  failed: number;
  totalDurationSeconds: number;
}

type Phase = "spec" | "testgen" | "exec" | "test" | "qa" | "loop";
```

### Log File Naming

Files are named: `run-<timestamp>-<uuid>.json`

Example: `run-2024-01-15T14-30-00-a1b2c3d4-e5f6-7890-abcd-ef1234567890.json`

## Parsing Logs with jq

[jq](https://stedolan.github.io/jq/) is a powerful command-line JSON processor. Here are useful examples:

### List Failed Runs

```bash
jq 'select(.summary.failed > 0) | {runId, failed: .summary.failed}' .sequant/logs/*.json
```

### Calculate Average Run Duration

```bash
jq -s 'map(.summary.totalDurationSeconds) | add / length' .sequant/logs/*.json
```

### Find Runs for Specific Issue

```bash
jq 'select(.issues[].issueNumber == 42)' .sequant/logs/*.json
```

### Show Phase Breakdown

```bash
jq '.issues[].phases[] | {phase, status, duration: .durationSeconds}' .sequant/logs/*.json
```

### Common Errors by Phase

```bash
jq '.issues[].phases[] | select(.error) | {phase, error}' .sequant/logs/*.json | sort | uniq -c | sort -rn
```

### Get Success Rate

```bash
jq -s '[.[].issues[] | .status] | group_by(.) | map({status: .[0], count: length})' .sequant/logs/*.json
```

### Total Time by Phase Type

```bash
jq -s '[.[].issues[].phases[] | {phase, duration: .durationSeconds}] | group_by(.phase) | map({phase: .[0].phase, total: (map(.duration) | add)})' .sequant/logs/*.json
```

### Export to CSV (Manual)

```bash
jq -r '[.runId, .startTime, .summary.totalDurationSeconds, .summary.totalIssues, .summary.passed, .summary.failed] | @csv' .sequant/logs/*.json
```

Or use the built-in CSV export:

```bash
sequant stats --csv
```

## Integration Examples

### GitHub Actions

```yaml
- name: Run Sequant
  run: npx sequant run 42

- name: Upload logs
  uses: actions/upload-artifact@v4
  with:
    name: sequant-logs
    path: .sequant/logs/
```

### Slack Notification on Failure

```bash
#!/bin/bash
FAILED=$(jq -s '[.[].summary.failed] | add' .sequant/logs/*.json)
if [ "$FAILED" -gt 0 ]; then
  curl -X POST "$SLACK_WEBHOOK" \
    -d "{\"text\": \"Sequant: $FAILED issues failed\"}"
fi
```

## Troubleshooting

### Logs Not Generated

1. Check `--no-log` wasn't passed
2. Verify `.sequant/settings.json` has `logJson: true`
3. Ensure `.sequant/logs/` is writable

### Log Directory Growing

Configure rotation thresholds or run manual rotation:

```bash
sequant logs --rotate
```

### Parsing Errors

Log files use Zod validation. If a log is malformed:

```bash
# Validate a log file
npx zod-to-json-schema .sequant/logs/run-*.json
```
