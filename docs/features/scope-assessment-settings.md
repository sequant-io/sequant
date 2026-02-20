# Scope Assessment Settings

**Quick Start:** Customize how Sequant evaluates issue scope during `/spec` by configuring thresholds in `.sequant/settings.json`. Use this to tune scope warnings for your project's size and complexity.

## How It Works

During `/spec`, Sequant runs scope assessment to detect overscoped issues. It checks four metrics against configurable thresholds:

| Metric | What It Measures | Default Yellow | Default Red |
|--------|------------------|----------------|-------------|
| Feature count | Distinct features in the issue | 2 | 3 |
| AC items | Number of acceptance criteria | 6 | 9 |
| File estimate | Estimated files to change | 8 | 13 |
| Directory spread | Directories affected | 3 | 5 |

Issues below the trivial thresholds skip assessment entirely:

| Trivial Threshold | What It Controls | Default |
|-------------------|------------------|---------|
| Max AC items | AC count below this is trivial | 3 |
| Max directories | Directory count below this is trivial | 1 |

## Usage

### Default Behavior

Scope assessment runs automatically during `/spec` with built-in defaults. No configuration required.

### Customizing Thresholds

Edit `.sequant/settings.json` to override any threshold:

```json
{
  "scopeAssessment": {
    "thresholds": {
      "acItems": { "yellow": 10, "red": 15 },
      "directorySpread": { "yellow": 5, "red": 8 }
    }
  }
}
```

Only specify the values you want to change. Omitted fields use defaults.

### Disabling Scope Assessment

```json
{
  "scopeAssessment": {
    "enabled": false
  }
}
```

### Adjusting Trivial Issue Detection

Raise the trivial thresholds to skip assessment for larger issues:

```json
{
  "scopeAssessment": {
    "trivialThresholds": {
      "maxACItems": 5,
      "maxDirectories": 2
    }
  }
}
```

## Options & Settings

All settings live under `scopeAssessment` in `.sequant/settings.json`:

| Option | Description | Default |
|--------|-------------|---------|
| `enabled` | Enable/disable scope assessment | `true` |
| `skipIfSimple` | Skip assessment for trivial issues | `true` |
| `trivialThresholds.maxACItems` | Max AC items for trivial classification | `3` |
| `trivialThresholds.maxDirectories` | Max directories for trivial classification | `1` |
| `thresholds.featureCount.yellow` | Feature count yellow warning | `2` |
| `thresholds.featureCount.red` | Feature count red warning | `3` |
| `thresholds.acItems.yellow` | AC items yellow warning | `6` |
| `thresholds.acItems.red` | AC items red warning | `9` |
| `thresholds.fileEstimate.yellow` | File estimate yellow warning | `8` |
| `thresholds.fileEstimate.red` | File estimate red warning | `13` |
| `thresholds.directorySpread.yellow` | Directory spread yellow warning | `3` |
| `thresholds.directorySpread.red` | Directory spread red warning | `5` |

## Common Workflows

### Tuning Thresholds for a Large Project

Large projects with many directories may trigger false scope warnings. Raise the thresholds:

```json
{
  "scopeAssessment": {
    "trivialThresholds": {
      "maxACItems": 5,
      "maxDirectories": 3
    },
    "thresholds": {
      "acItems": { "yellow": 10, "red": 15 },
      "fileEstimate": { "yellow": 15, "red": 25 },
      "directorySpread": { "yellow": 5, "red": 10 }
    }
  }
}
```

### Strict Mode for Small Projects

Lower thresholds to catch scope creep earlier:

```json
{
  "scopeAssessment": {
    "thresholds": {
      "featureCount": { "yellow": 1, "red": 2 },
      "acItems": { "yellow": 4, "red": 6 }
    }
  }
}
```

### Partial Configuration

You only need to specify values you want to change. Everything else uses defaults:

```json
{
  "scopeAssessment": {
    "thresholds": {
      "acItems": { "yellow": 8, "red": 12 }
    }
  }
}
```

This only changes AC item thresholds. Feature count, file estimate, directory spread, and trivial thresholds all remain at their defaults.

## Troubleshooting

### Custom Thresholds Not Taking Effect

**Symptoms:** Scope assessment still uses default thresholds after editing settings.

**Solution:**
1. Verify `.sequant/settings.json` is valid JSON (`cat .sequant/settings.json | jq .`)
2. Ensure thresholds are nested under `scopeAssessment`, not at the root
3. Check that field names match exactly (e.g., `acItems`, not `ac_items`)

### Scope Assessment Skipped Unexpectedly

**Symptoms:** Issues that should be assessed are marked "trivial" and skipped.

**Solution:** Your issue falls below the trivial thresholds. Either:
- Lower `trivialThresholds.maxACItems` or `trivialThresholds.maxDirectories`
- Set `skipIfSimple: false` to assess all issues regardless of size

### Invalid Settings File

**Symptoms:** Scope assessment runs with defaults despite settings file existing.

**Solution:** If `.sequant/settings.json` contains invalid JSON, Sequant silently falls back to defaults. Fix the JSON syntax:

```bash
# Check for JSON errors
cat .sequant/settings.json | jq . 2>&1
```

---

*Generated for Issue #249 on 2026-02-20*
