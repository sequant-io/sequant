# Run Command

**Quick Start:** Execute the Sequant workflow (`/spec` → `/exec` → `/qa`) for one or more GitHub issues with a single command. Use this to automate issue resolution through sequential AI phases.

## Access

- **Command:** `npx sequant run <issues...> [options]`
- **Requirements:**
  - Sequant initialized (`sequant init`)
  - Claude CLI installed and configured
  - GitHub CLI authenticated (`gh auth login`)

## Usage

### Running a Single Issue

```bash
npx sequant run 123
```

Executes the default workflow phases (spec → exec → qa) for issue #123.

### Running Multiple Issues

```bash
npx sequant run 100 101 102
```

Processes issues #100, #101, and #102. By default, issues continue processing even if one fails.

### Sequential Mode with Dependencies

```bash
npx sequant run 100 101 102 --sequential
```

Processes issues in order, stopping if any issue fails. Use this when later issues depend on earlier ones.

### Preview with Dry Run

```bash
npx sequant run 100 --dry-run
```

Shows what would be executed without actually running any phases. Useful for verifying configuration.

## Options & Settings

| Option | Description | Default |
|--------|-------------|---------|
| `--phases <list>` | Comma-separated phases to run | `spec,exec,qa` |
| `--sequential` | Stop on first failure | `false` |
| `-d, --dry-run` | Preview without execution | `false` |
| `-v, --verbose` | Show detailed output | `false` |
| `--timeout <seconds>` | Timeout per phase | `1800` (30 min) |
| `-q, --quality-loop` | Enable auto-retry on failures | `false` |
| `--max-iterations <n>` | Max iterations for quality loop | `3` |
| `--testgen` | Run testgen phase after spec | `false` |
| `--batch "<issues>"` | Group issues to run together | - |

### Available Phases

| Phase | Description |
|-------|-------------|
| `spec` | Planning and specification review |
| `testgen` | Generate test stubs from spec |
| `exec` | Implementation execution |
| `test` | Run tests and verify |
| `qa` | Quality review and approval |
| `loop` | Quality iteration loop |

## Common Workflows

### Standard Issue Resolution

Run the default workflow for a single issue:

```bash
npx sequant run 42
```

**What happens:**
1. `/spec 42` - Reviews issue and creates implementation plan
2. `/exec 42` - Implements the solution
3. `/qa 42` - Reviews code and validates against acceptance criteria

### Quick Fix (Skip Planning)

For simple fixes where planning isn't needed:

```bash
npx sequant run 42 --phases exec,qa
```

### Full Workflow with Tests

Include test generation and execution:

```bash
npx sequant run 42 --phases spec,testgen,exec,test,qa
```

### Batch Processing

Process a sprint's worth of issues:

```bash
npx sequant run 100 101 102 103 104 --sequential
```

### Quality Loop Mode

Enable automatic fix iterations when phases fail:

```bash
npx sequant run 42 --quality-loop
```

**What happens:**
1. Runs phases normally (spec → exec → qa)
2. If a phase fails, runs `/loop` to fix issues
3. Re-runs failed phases after fixes
4. Iterates up to 3 times (configurable with `--max-iterations`)

This is useful for complex issues where initial implementation may need refinement.

```bash
# Quality loop with more iterations
npx sequant run 42 --quality-loop --max-iterations 5
```

### CI/Scripting Mode

Run without colors for CI environments:

```bash
npx sequant run 42 --no-color
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PHASE_TIMEOUT` | Override default timeout (seconds) | `1800` |
| `PHASES` | Override default phases | `spec,exec,qa` |
| `SEQUANT_QUALITY_LOOP` | Enable quality loop | `false` |
| `SEQUANT_MAX_ITERATIONS` | Max quality loop iterations | `3` |
| `SEQUANT_SMART_TESTS` | Enable smart test detection | `true` |
| `SEQUANT_TESTGEN` | Enable testgen phase | `false` |

Example:
```bash
PHASE_TIMEOUT=3600 npx sequant run 42  # 1 hour timeout
SEQUANT_QUALITY_LOOP=true npx sequant run 42  # Enable quality loop
```

## Settings File

You can configure defaults in `.sequant/settings.json`:

```json
{
  "version": "1.0",
  "run": {
    "logJson": true,
    "logPath": ".sequant/logs",
    "autoDetectPhases": true,
    "timeout": 1800,
    "sequential": false,
    "qualityLoop": false,
    "maxIterations": 3,
    "smartTests": true
  }
}
```

Settings hierarchy (highest priority wins):
1. CLI flags (`--quality-loop`)
2. Environment variables (`SEQUANT_QUALITY_LOOP`)
3. Project settings (`.sequant/settings.json`)
4. Package defaults

## Output

### Success Output

```
🚀 Sequant Workflow Execution

  Stack: nextjs
  Phases: spec → exec → qa
  Mode: parallel
  Issues: #42

  Issue #42
    ⏳ spec...
    ✓ spec (2m 30s)
    ⏳ exec...
    ✓ exec (15m 45s)
    ⏳ qa...
    ✓ qa (1m 20s)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Results: 1 passed, 0 failed
  ✓ #42: spec → exec → qa (19m 35s)
```

### Failure Output

```
  Issue #42
    ⏳ spec...
    ✓ spec (2m 30s)
    ⏳ exec...
    ✗ exec: Exit code 1

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Results: 0 passed, 1 failed
  ✗ #42: spec → exec (2m 30s)
```

## Worktree Isolation

By default, `sequant run` creates isolated git worktrees for each issue. This ensures:

- **Clean separation**: Each issue's changes are isolated from others
- **Parallel safety**: Multiple issues can be worked on simultaneously
- **Easy cleanup**: Worktrees can be removed without affecting other work

### Fresh Baseline

When creating a new worktree, Sequant:

1. **Fetches latest main**: Runs `git fetch origin main`
2. **Branches from origin/main**: Creates the branch from `origin/main`

This guarantees every new issue starts from the latest remote state.

### Worktree Location

Worktrees are created in a `worktrees/` directory alongside your repository:

```text
parent-directory/
├── your-repo/           # Main repository
└── worktrees/
    ├── feature/123-add-login/
    └── feature/124-fix-bug/
```

### Reusing Worktrees

If a worktree already exists for an issue's branch, Sequant reuses it.
This preserves any in-progress work.

### Phase Isolation

Not all phases run in the worktree:

| Phase  | Location  | Reason                           |
| ------ | --------- | -------------------------------- |
| `spec` | Main repo | Planning only, no code changes   |
| `exec` | Worktree  | Implementation happens here      |
| `test` | Worktree  | Tests run against implementation |
| `qa`   | Worktree  | Review happens in context        |

## Troubleshooting

### "Sequant is not initialized"

**Symptoms:** Error message says Sequant is not initialized

**Solution:** Run `sequant init` in your project root first:
```bash
sequant init
```

### Phase timeout

**Symptoms:** Phase fails with "Timeout after 1800s"

**Solution:** Increase the timeout:
```bash
npx sequant run 42 --timeout 3600  # 1 hour
```

### Claude CLI not found

**Symptoms:** Error about `claude` command not found

**Solution:** Install and configure Claude CLI:
```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

### GitHub authentication

**Symptoms:** Issues can't be fetched or commented on

**Solution:** Authenticate GitHub CLI:
```bash
gh auth login
gh auth status
```

## See Also

- [Customization Guide](customization.md) - Configure phases and timeouts
- [Troubleshooting](troubleshooting.md) - Common issues and solutions
- [Testing Guide](testing.md) - Cross-platform testing matrix

---

*Generated for Issue #1 on 2026-01-06*
