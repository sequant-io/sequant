# QA Small-Diff Fast Path

**Quick Start:** For trivial diffs, `/qa` skips sub-agent spawning and runs inline quality checks instead, saving ~30s latency and reducing token cost. Configure the threshold in `.sequant/settings.json`.

## How It Works

Before spawning quality check sub-agents, `/qa` evaluates a size gate with three conditions:

| Check | Condition for Fast Path |
|-------|------------------------|
| Diff size | `additions + deletions < threshold` (default: 100) |
| Dependencies | `package.json` unchanged |
| Security paths | No files matching `auth|payment|security|server-action|middleware|admin` |

If **all three** conditions pass, inline checks run directly (type safety, deleted tests, scope, security patterns). If **any** condition fails, the standard sub-agent pipeline runs.

## Usage

### Default Behavior

The size gate runs automatically during `/qa`. Diffs under 100 lines with no dependency or security-sensitive changes use the fast path. No configuration required.

### Customizing the Threshold

Edit `.sequant/settings.json`:

```json
{
  "qa": {
    "smallDiffThreshold": 50
  }
}
```

Only specify if you want to change the default. Setting a lower value makes the fast path more selective; a higher value allows larger diffs to skip sub-agents.

### Output

When the fast path triggers, `/qa` uses a simplified output template that omits sections typically N/A for small fixes (Quality Plan, Incremental QA, Call-Site Review, Product Review, Smoke Test, CLI Registration, Skill Command Verification). The verdict and AC coverage sections are always present.

## Fallback Behavior

The fast path falls back to the full sub-agent pipeline when:

- The size gate evaluation encounters errors (e.g., `git` fails)
- Any of the three conditions is not met
- The diff touches security-sensitive paths, regardless of size
