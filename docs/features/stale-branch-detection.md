# Stale Branch Detection

**Quick Start:** Sequant's pre-flight checks now detect when a feature branch has fallen behind `main`, preventing wasted QA cycles and false merge-readiness verdicts. Configure the threshold in `.sequant/settings.json` to control how many commits behind triggers a warning or block.

## How It Works

Before `/qa`, `/test`, or `/exec` begin their main work, a pre-flight check counts how many commits the feature branch is behind `origin/main`. Depending on the count and which skill is running, Sequant either warns or blocks execution.

| Skill | 0 commits behind | 1 to threshold | Above threshold |
|-------|-------------------|----------------|-----------------|
| `/qa` | Proceed normally | Warning, continues | **Blocked** (STALE_BRANCH) |
| `/test` | Proceed normally | Warning, continues | **Blocked** (STALE_BRANCH) |
| `/exec` | Proceed normally | Info message | Warning (never blocks) |

The default threshold is **5 commits**.

## Usage

### Default Behavior

Stale branch detection runs automatically during pre-flight checks for `/qa`, `/test`, and `/exec`. No configuration is required.

When a branch is stale, you will see a table like this in the skill output:

| Check | Value |
|-------|-------|
| Commits behind main | 8 |
| Threshold | 5 |
| Status | Blocked |

### Resolving a Stale Branch

When stale branch detection blocks QA or testing, rebase before retrying:

1. Fetch the latest remote state:
   ```bash
   git fetch origin
   ```
2. Rebase onto main:
   ```bash
   git rebase origin/main
   ```
3. Re-run the skill (`/qa`, `/test`, etc.)

### Customizing the Threshold

Edit `.sequant/settings.json` to change when blocking kicks in:

```json
{
  "run": {
    "staleBranchThreshold": 10
  }
}
```

Set a higher value for repositories with frequent commits to main, or a lower value for stricter merge hygiene.

## Options & Settings

| Option | Description | Default |
|--------|-------------|---------|
| `staleBranchThreshold` | Number of commits behind main before `/qa` and `/test` block execution | `5` |

This setting lives under the `run` key in `.sequant/settings.json`.

## Common Workflows

### QA After Active Main Development

1. Finish implementation with `/exec`
2. Before running `/qa`, check how far behind your branch is:
   ```bash
   git fetch origin && git rev-list --count HEAD..origin/main
   ```
3. If the count exceeds the threshold, rebase first
4. Run `/qa` -- the pre-flight check confirms the branch is current

### Skipping Detection During Orchestration

When running as part of `sequant run` or `/fullsolve`, the orchestrator handles branch freshness checks. Individual skills skip their own stale branch detection when the `SEQUANT_ORCHESTRATOR` environment variable is set.

## Troubleshooting

### QA blocked with STALE_BRANCH but branch looks current

**Symptoms:** `/qa` reports the branch is behind main even though you recently rebased.

**Solution:** Ensure you fetched the latest remote state. Run `git fetch origin` before retrying. The check compares against `origin/main`, not your local `main`.

### Threshold too aggressive for my workflow

**Symptoms:** Branches are frequently blocked because main moves fast.

**Solution:** Increase `staleBranchThreshold` in `.sequant/settings.json`. For high-velocity repositories, a threshold of 10-15 may be more practical.

---

*Generated for Issue #304 on 2026-03-12*
