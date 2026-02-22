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
| `--sequential` | Run issues in order, stop on first failure (see [Execution Model](#execution-model)) | `false` |
| `--chain` | Chain issues: each branches from previous (requires `--sequential`) | `false` |
| `--qa-gate` | Wait for QA pass before starting next issue (requires `--chain`) | `false` |
| `-d, --dry-run` | Preview without execution | `false` |
| `-v, --verbose` | Show detailed output | `false` |
| `--timeout <seconds>` | Timeout per phase | `1800` (30 min) |
| `-q, --quality-loop` | Enable auto-retry on failures | `false` |
| `--max-iterations <n>` | Max iterations for quality loop | `3` |
| `--testgen` | Run testgen phase after spec | `false` |
| `--batch "<issues>"` | Group issues to run together | - |
| `--no-mcp` | Disable MCP servers for faster/cheaper runs | `false` |

### Available Phases

| Phase | Description |
|-------|-------------|
| `spec` | Planning and specification review |
| `testgen` | Generate test stubs from spec |
| `exec` | Implementation execution |
| `test` | Run tests and verify |
| `qa` | Quality review and approval |
| `loop` | Quality iteration loop |

## Execution Model

Issues are always processed **one at a time** (serially). The `--sequential` flag controls **failure behavior**, not concurrency:

| Mode | Flag | Behavior on Failure |
|------|------|---------------------|
| Default | _(none)_ | Continue to next issue |
| Sequential | `--sequential` | Stop immediately |

**Why not concurrent?** The Claude Agent SDK processes one agent session at a time. True concurrent execution (e.g., via listr2) is a potential future enhancement, but the current architecture runs issues serially regardless of the `--sequential` flag.

**What `--sequential` actually controls:**

```bash
# Default: process all issues, continue if #101 fails
npx sequant run 100 101 102
#   ✓ #100 → ✗ #101 → ✓ #102  (all attempted)

# Sequential: stop on first failure
npx sequant run 100 101 102 --sequential
#   ✓ #100 → ✗ #101  (stopped, #102 skipped)
```

> **Note:** The settings file and logs may show `"sequential": false` and `Mode: parallel`. This refers to the failure behavior described above — issues still run one at a time.

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

### Chain Mode

Run dependent issues where each branches from the previous:

```bash
npx sequant run 1 2 3 --sequential --chain
```

**What happens:**

1. Issue #1 branches from `origin/main`
2. Issue #2 branches from `feature/1-xxx` (Issue #1's completed branch)
3. Issue #3 branches from `feature/2-xxx` (Issue #2's completed branch)

```text
origin/main
    └─→ feature/1-add-auth (Issue #1)
            └─→ feature/2-add-login-page (Issue #2)
                    └─→ feature/3-add-logout (Issue #3)
```

**Checkpoint Commits:**

After each issue passes QA, a checkpoint commit is automatically created. This serves as a recovery point if later issues in the chain fail.

**Requirements:**

- `--chain` requires `--sequential` (issues must run in order)
- Cannot be combined with `--batch` mode

**Warnings:**

A warning is shown for chains longer than 5 issues. Long chains:
- Increase merge complexity
- Make code review more difficult
- Are harder to recover from if failures occur

Consider breaking long chains into smaller batches.

**Use Cases:**

- Implementing features that build on each other
- Multi-part refactoring where each step depends on the previous
- Building a feature incrementally (auth → login → logout)

**Merging Chain PRs:**

Option A: Sequential merge to main (recommended)
```bash
# Merge each PR in order, rebasing as needed
gh pr merge 1 --squash --delete-branch
# Update PR 2's base after 1 is merged
gh pr merge 2 --squash --delete-branch
gh pr merge 3 --squash --delete-branch
```

Option B: Single combined review
- Review the final branch which contains all changes

### QA Gate Mode

Add `--qa-gate` to pause the chain when QA fails, preventing downstream issues from building on potentially broken code:

```bash
npx sequant run 1 2 3 --sequential --chain --qa-gate
```

**What happens:**

1. Issue #1 runs through spec → exec → qa
2. If QA passes: Continue to Issue #2
3. If QA fails: Chain pauses with clear messaging

**QA Gate Pause Output:**

```text
  ⏸️  QA Gate
     Issue #1 QA did not pass. Chain paused.
     Fix QA issues and re-run, or run /loop to auto-fix.
```

**State Tracking:**

When QA gate pauses a chain, the issue status is set to `waiting_for_qa_gate`. Check status with:

```bash
sequant status --issues
```

**When to Use QA Gate:**

- Complex chains where later issues depend heavily on earlier ones
- When QA findings in early issues could invalidate later implementations
- Production-critical chains where you want to ensure quality at each step

**When NOT to Use QA Gate:**

- Simple, independent issues that don't build on each other
- When you want maximum speed and can fix issues later
- Chains where issues are mostly independent despite the branch structure

**Recovery from QA Gate Pause:**

Option A: Fix and re-run
```bash
# Fix the QA issues manually
cd ../worktrees/feature/1-xxx
# Make fixes...
git commit -m "fix: address QA findings"

# Re-run the full chain
npx sequant run 1 2 3 --sequential --chain --qa-gate
```

Option B: Use /loop to auto-fix
```bash
# In the worktree, run loop to auto-fix
/loop 1

# Then re-run the chain
npx sequant run 1 2 3 --sequential --chain --qa-gate
```

**Combining with Quality Loop:**

You can combine `--qa-gate` with `--quality-loop` for automatic retry:

```bash
npx sequant run 1 2 3 --sequential --chain --qa-gate --quality-loop
```

This will:
1. Run each issue through phases
2. If a phase fails, automatically retry with `/loop`
3. If QA still fails after max iterations, pause the chain

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

## MCP Server Support

`sequant run` supports MCP (Model Context Protocol) servers for enhanced functionality in headless mode. When enabled, MCP servers configured in Claude Desktop are automatically passed to the Claude Agent SDK.

### How It Works

1. **Reads Claude Desktop config** from the platform-specific path:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - Linux: `~/.config/claude/claude_desktop_config.json`

2. **Passes `mcpServers`** to the SDK `query()` call for each phase

3. **Graceful degradation**: If the config doesn't exist or is invalid, runs without MCPs

### Configuration

| Option | Setting | Default | Description |
|--------|---------|---------|-------------|
| `--no-mcp` | - | - | Disable MCPs for faster/cheaper runs |
| - | `run.mcp` | `true` | Enable MCP servers by default |

**Priority:** CLI flag (`--no-mcp`) → Settings (`run.mcp`) → Default (`true`)

### Usage Examples

```bash
# Default: MCPs enabled (reads from Claude Desktop config)
npx sequant run 42

# Disable MCPs for faster execution
npx sequant run 42 --no-mcp

# Disable MCPs via settings
# In .sequant/settings.json: { "run": { "mcp": false } }
```

### Checking MCP Availability

Run `sequant doctor` to verify MCP availability for headless mode:

```bash
sequant doctor
```

Look for the "MCP Servers (headless)" check:
- ✓ **Pass**: MCPs available for `sequant run`
- ⚠ **Warn**: No Claude Desktop config found or empty `mcpServers`

### Supported MCPs

MCPs that enhance Sequant skills in headless mode:

| MCP | Skills Enhanced | Purpose |
|-----|-----------------|---------|
| Context7 | `/exec`, `/fullsolve` | External library documentation lookup |
| Sequential Thinking | `/fullsolve` | Complex multi-step reasoning |
| Chrome DevTools | `/test`, `/testgen`, `/loop` | Browser automation for UI testing |

### Adding MCPs for Headless Mode

To add MCP servers for use with `sequant run`, edit the Claude Desktop config file directly.

**1. Locate your config file:**

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/claude/claude_desktop_config.json` |

**2. Add MCPs to the `mcpServers` object:**

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}
```

**3. Config format:**

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "npx",           // Command to run
      "args": ["-y", "<package>"], // Arguments (use -y for auto-install)
      "env": {                     // Optional: environment variables
        "API_KEY": "..."
      }
    }
  }
}
```

**4. Verify configuration:**

```bash
sequant doctor
```

Look for:
- ✓ `MCP Servers: All optional MCPs configured`
- ✓ `MCP Servers (headless): Available for sequant run (N servers configured)`

**Note:** Changes to Claude Desktop config require restarting Claude Desktop (for interactive use) but take effect immediately for `sequant run` (headless mode).

### When to Disable MCPs

Use `--no-mcp` when:
- Running on a system without Claude Desktop installed
- Optimizing for cost (MCPs add token overhead)
- Running simple issues that don't need external documentation
- Debugging to isolate MCP-related issues

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
    "smartTests": true,
    "mcp": true
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
  Mode: continue-on-failure
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

In **chain mode**, existing worktrees are automatically rebased onto the previous chain link. If a rebase conflict occurs, the rebase is aborted and the worktree continues in its original state with a warning.

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

- [Customization Guide](../guides/customization.md) - Configure phases and timeouts
- [Troubleshooting](../troubleshooting.md) - Common issues and solutions
- [Testing Guide](../internal/testing.md) - Cross-platform testing matrix

---

*Generated for Issue #1 on 2026-01-06*
