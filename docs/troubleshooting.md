# Troubleshooting Guide

Common issues and solutions when using Sequant.

## Worktree Issues

### "Branch already exists" error

**Problem:** Creating a new feature worktree fails with "branch already exists".

**Solutions:**

1. Check if worktree already exists:
   ```bash
   git worktree list
   ```

2. If worktree exists but is stale, remove it:
   ```bash
   # Remove the worktree directory
   rm -rf ../worktrees/feature/<issue-number>-*

   # Prune worktree references
   git worktree prune
   ```

3. If branch exists without worktree, delete the branch:
   ```bash
   git branch -D feature/<issue-number>-*
   ```

### Orphaned worktrees after failed runs

**Problem:** Failed `/exec` or `/fullsolve` leaves behind orphaned worktrees.

**Solutions:**

1. List all worktrees to find orphans:
   ```bash
   git worktree list
   ls ../worktrees/feature/
   ```

2. Clean up using the cleanup script:
   ```bash
   ./scripts/cleanup-worktree.sh feature/<issue-number>-*
   ```

3. Or clean manually:
   ```bash
   rm -rf ../worktrees/feature/<issue-number>-*
   git worktree prune
   git branch -D feature/<issue-number>-*
   ```

### Worktree not found during /qa or /exec

**Problem:** Skills report "worktree not found" even though work was started.

**Solutions:**

1. Verify the worktree path:
   ```bash
   ls ../worktrees/feature/ | grep <issue-number>
   ```

2. If path exists but skill can't find it, specify explicitly:
   ```bash
   cd ../worktrees/feature/<issue-number>-*/
   # Then run skill from within the worktree
   ```

3. If worktree was accidentally deleted, recreate it:
   ```bash
   ./scripts/new-feature.sh <issue-number>
   ```

### Commits landed on main instead of feature branch

**Problem:** After running `/exec` or `/fullsolve`, commits ended up on `main` instead of the feature branch. This can happen when sub-agents or shell context resets silently switch the working directory back to the main repo root.

**Prevention:** Both `/exec` and `/fullsolve` now include branch verification gates that block commits on main/master. If you see the error "On main — do NOT commit here", navigate to the correct worktree before continuing.

**Recovery if it already happened:**

1. Check which commits need to move:
   ```bash
   git log --oneline main ^origin/main
   ```

2. Switch to the feature branch and cherry-pick:
   ```bash
   git checkout feature/<issue-number>-*
   git cherry-pick <commit-hash>
   ```

3. Remove the commits from main:
   ```bash
   git checkout main
   git reset --soft origin/main
   git stash  # save any uncommitted changes
   ```

---

## Project Type Support

### Using Sequant with non-Node.js projects

**Context:** Sequant is optimized for Node.js/TypeScript projects, but the core worktree workflow works with any git repository.

**What works universally:**
- `/spec` - Issue planning and AC extraction
- `/exec` - Implementation in isolated worktree
- `/qa` - Code review (adapts to project type)
- `/fullsolve` - Complete workflow orchestration
- Git worktree isolation

**Node.js specific features:**
- `npm test` / `npm run build` verification
- Hook-based test running (detects npm/yarn/pnpm/bun)
- Prettier formatting for JS/TS files

**For non-Node.js projects:**

1. Skills will attempt to detect your build/test commands
2. You may see warnings about missing `package.json` - these are safe to ignore
3. Customize test commands in your constitution:
   ```markdown
   ## Project-Specific Notes
   - Build: `cargo build` (Rust) / `go build` (Go) / `pytest` (Python)
   - Test: `cargo test` / `go test ./...` / `pytest`
   ```

**Stack guides available:**
- [Rust](stacks/rust.md)
- [Python](stacks/python.md)
- [Go](stacks/go.md)

---

## Installation Issues (npm)

### `sequant: command not found`

**Problem:** After installing, the `sequant` command isn't recognized.

**Solutions:**

1. Ensure global npm bin is in your PATH:
   ```bash
   npm config get prefix
   # Add [prefix]/bin to your PATH
   ```

2. Use npx instead:
   ```bash
   npx sequant init
   ```

3. Reinstall globally:
   ```bash
   npm install -g sequant       # npm
   pnpm add -g sequant          # pnpm
   yarn global add sequant      # yarn
   bun add -g sequant           # bun
   ```

### Stray `$HOME/node_modules/sequant` install

**Problem:** On startup the CLI prints:

```text
!  Sequant is running from /Users/<you>/node_modules/sequant — this pollutes
   resolution for every subdirectory of your home directory.

   If accidental (usually is — one stray `npm install sequant` from ~ does it):
       remove /Users/<you>/node_modules
       remove $HOME/package.json and $HOME/package-lock.json

   If intentional: use `npm install -g sequant` or the Claude Code plugin.
```

**Cause:** A `npm install sequant` was run from `$HOME` at some point. Node's module resolution walks up the directory tree, so every subdirectory of home now resolves to that stale copy before reaching the npx cache. The result: `npx sequant` from any project silently runs the home-stray version instead of the latest.

**Solutions:**

1. If you didn't intend to install sequant in `$HOME`:
   ```bash
   rm -rf "$HOME/node_modules"
   rm -f "$HOME/package.json" "$HOME/package-lock.json"
   ```
   Re-run `npx sequant@latest <command>` — resolution now falls through to the npx cache.

2. If you genuinely want sequant available everywhere, install it the right way:
   ```bash
   npm install -g sequant
   ```
   Or use the [Claude Code plugin](features/plugin-distribution.md), which doesn't rely on Node's `node_modules` walk-up at all.

The warning only fires when the resolved install path is *exactly* `$HOME/node_modules/sequant`. Legitimate project-local installs (`<project>/node_modules/sequant`), global installs, and npx cache paths are not flagged.

### Permission errors during install

**Problem:** `EACCES` permission denied errors.

**Solutions:**

1. Use a Node version manager (recommended):
   ```bash
   # Using nvm
   nvm install --lts
   nvm use --lts
   npm install -g sequant
   ```

2. Fix npm permissions:
   ```bash
   mkdir ~/.npm-global
   npm config set prefix '~/.npm-global'
   # Add ~/.npm-global/bin to PATH
   ```

## Initialization Issues

### Stack not detected

**Problem:** `sequant init` doesn't detect your project stack.

**Solutions:**

1. Specify the stack manually:
   ```bash
   sequant init --stack nextjs
   ```

2. Ensure detection files exist:
   - Next.js: `next.config.js` or `next` in package.json
   - Rust: `Cargo.toml`
   - Python: `pyproject.toml` or `requirements.txt`
   - Go: `go.mod`

### Already initialized error

**Problem:** Error saying Sequant is already initialized.

**Solutions:**

1. Use force flag to reinitialize:
   ```bash
   sequant init --force
   ```

2. Or remove existing config:
   ```bash
   rm -rf .claude .sequant-manifest.json
   sequant init
   ```

## Skill Execution Issues

### Skills not recognized

**Problem:** `/spec` or other skills aren't recognized in Claude Code.

**Solutions:**

1. Verify skills are installed:
   ```bash
   ls .claude/skills/
   ```

2. Run doctor to check installation:
   ```bash
   sequant doctor
   ```

3. Restart Claude Code to reload skills.

### Permission denied on hooks

**Problem:** Hook scripts fail with permission errors.

**Solutions:**

1. Make hooks executable:
   ```bash
   chmod +x .claude/hooks/*.sh
   ```

2. Run doctor with fix:
   ```bash
   sequant doctor --fix
   ```

## Run Command Issues

### `claude` command not found

**Problem:** `npx sequant run` fails because `claude` CLI isn't available.

**Solutions:**

1. Install Claude Code CLI:
   ```bash
   # Follow Claude Code installation instructions
   ```

2. Verify installation:
   ```bash
   claude --version
   ```

3. Use dry-run to test without execution:
   ```bash
   npx sequant run 123 --dry-run
   ```

### Timeout errors

**Problem:** Phases timeout before completing.

**Solutions:**

1. Increase timeout:
   ```bash
   npx sequant run 123 --timeout 3600  # 1 hour
   ```

2. Or set via environment:
   ```bash
   PHASE_TIMEOUT=3600 npx sequant run 123
   ```

### GitHub CLI not authenticated

**Problem:** Skills fail when trying to access GitHub issues.

**Solutions:**

1. Authenticate GitHub CLI:
   ```bash
   gh auth login
   ```

2. Verify authentication:
   ```bash
   gh auth status
   ```

### Claude Code process exited with code 1

**Problem:** `sequant run` fails with "Claude Code process exited with code 1" during a phase.

**Causes:**
- Outdated sequant version in local node_modules
- MCP server configuration issues
- Invalid project settings in `.claude/settings.json`

**Solutions:**

1. Update sequant to latest version:
   ```bash
   npx sequant@latest run 123
   # or update your local install with your package manager
   # npm update sequant / pnpm update sequant / yarn upgrade sequant / bun update sequant
   ```

2. Try running without MCP servers to isolate the issue:
   ```bash
   npx sequant run 123 --no-mcp
   ```

3. Run with verbose mode to see detailed error output:
   ```bash
   npx sequant run 123 -v
   ```

4. Check for invalid hook scripts in `.claude/hooks/`:
   ```bash
   # Test hooks manually
   echo '{}' | .claude/hooks/pre-tool.sh
   ```

5. Verify Claude Code CLI works standalone:
   ```bash
   claude --version
   claude -p "Say hello" --print
   ```

## Update Issues

### Conflicts during update

**Problem:** `sequant update` shows conflicts with local changes.

**Solutions:**

1. Review the diff:
   ```bash
   sequant update --dry-run
   ```

2. Force update (overwrites local changes to package files):
   ```bash
   sequant update --force
   ```

3. Move skill customizations into an overrides file (not a full `SKILL.md` copy —
   Claude Code never loads `.claude/.local/skills/<name>/SKILL.md`). Put only the
   behavior you changed into `overrides.md`, then restore the managed skill:
   ```bash
   mkdir -p .claude/.local/skills/spec
   # Write your deltas into .claude/.local/skills/spec/overrides.md, then:
   sequant update --force   # restore the managed spec/SKILL.md
   ```
   The overlay directive in `spec/SKILL.md` makes `overrides.md` authoritative at
   invocation. See the [Customization Guide](guides/customization.md#modifying-an-existing-skill).

### `update` crashes or exits in CI / scripts

**Problem:** `sequant update` is interactive by default. When run without a
terminal (a pipe, a non-interactive shell) — or in a detected CI environment,
even one that allocates a pseudo-TTY — it has no way to answer its
`Apply updates?` prompt.

**Solution:** Pass `--yes` (`-y`) to apply updates non-interactively:

```bash
sequant update --yes
```

Without `--yes` in a non-interactive or CI shell, `update` now exits with a
clear message naming the reason and a non-zero status (instead of a raw
`ExitPromptError` stack trace or a hung job), so scripts can detect the misuse.
To preview what would change without applying — and without prompting — run
`sequant update --dry-run`, which is safe in any shell. It exits non-zero when
updates are pending (and `0` when nothing is to apply), so CI can gate on it
directly without parsing stdout — parity with `sync --dry-run`. For a fast,
CI-safe content-drift check that never prompts, use `sequant sync`.

## Build/Test Issues

### Tests fail during /exec

**Problem:** The execution phase fails because tests don't pass.

**Solutions:**

1. Run tests manually first:
   ```bash
   npm test  # or your test command
   ```

2. Fix failing tests before running the workflow.

3. Skip verification (not recommended):
   ```bash
   SKIP_VERIFICATION=true npx sequant run 123
   ```

### Lint errors blocking commit

**Problem:** The workflow can't commit due to lint errors.

**Solutions:**

1. Run lint manually:
   ```bash
   npm run lint  # or your lint command
   ```

2. Fix lint errors before running the workflow.

3. Check your lint configuration is correct for your stack.

## Windows Issues

### "bash: command not found" or scripts don't work

**Problem:** Shell scripts (hooks, `new-feature.sh`) fail because bash isn't available.

**Solution:** Install WSL (Windows Subsystem for Linux):

1. Open PowerShell as Administrator
2. Run: `wsl --install`
3. Restart your computer
4. Open Ubuntu from Start menu and complete setup
5. Run Sequant commands from within WSL

See the [README Windows Users section](../README.md#windows-users) for full setup instructions.

### Line ending issues (CRLF vs LF)

**Problem:** Git shows all files as modified, or scripts fail with "bad interpreter" errors.

**Solution:** Configure Git to use LF line endings:

```bash
# Set global config
git config --global core.autocrlf input

# Fix existing repo
git rm --cached -r .
git reset --hard
```

If using VSCode, add to `.vscode/settings.json`:
```json
{
  "files.eol": "\n"
}
```

### Path issues between Windows and WSL

**Problem:** Paths like `C:\Users\...` don't work in WSL, or vice versa.

**Solutions:**

1. **Access Windows files from WSL:**
   ```bash
   cd /mnt/c/Users/YourName/Projects
   ```

2. **Access WSL files from Windows:**
   ```
   \\wsl$\Ubuntu\home\username
   ```

3. **Best practice:** Keep your projects in the WSL filesystem (`~/projects/`) for better performance.

### npm/node not found in WSL

**Problem:** Node.js works in Windows but not in WSL.

**Solution:** Install Node.js inside WSL (it's a separate environment):

```bash
# Using nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install --lts

# Or using NodeSource
# See: https://github.com/nodesource/distributions
```

## Git Issues

### GPG signing failed

**Problem:** Commits fail with "gpg failed to sign the data" or "No pinentry".

**Solutions:**

1. Commit without GPG signing (if allowed):
   ```bash
   git commit --no-gpg-sign -m "message"
   ```

2. Fix GPG agent:
   ```bash
   gpgconf --kill gpg-agent
   gpg-agent --daemon
   ```

3. Configure Git to skip signing:
   ```bash
   git config --global commit.gpgsign false
   ```

4. Fix pinentry (macOS):
   ```bash
   brew install pinentry-mac
   echo "pinentry-program $(which pinentry-mac)" >> ~/.gnupg/gpg-agent.conf
   gpgconf --kill gpg-agent
   ```

## Common Error Messages

### "Sequant is not initialized"

Run `sequant init` in your project directory.

### "No valid issue numbers provided"

Provide at least one issue number:
```bash
npx sequant run 123
```

### "Manifest not found"

The `.sequant-manifest.json` file is missing. Reinitialize:
```bash
sequant init --force
```

## Getting Help

1. Run diagnostics:
   ```bash
   sequant doctor
   ```

2. Check status:
   ```bash
   sequant status
   ```

3. View help:
   ```bash
   sequant --help
   sequant run --help
   ```

4. File an issue: [GitHub Issues](https://github.com/sequant-io/sequant/issues)

## See Also

- [Customization Guide](guides/customization.md)
- [Stack Guides](stacks/)
