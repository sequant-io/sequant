# Troubleshooting Guide

Common issues and solutions when using Sequant.

## Plugin Installation Issues

### Marketplace not found

**Problem:** `/plugin marketplace add admarble/sequant` shows "marketplace not found".

**Solutions:**

1. Check the marketplace name is correct (owner/repo format):
   ```
   /plugin marketplace add admarble/sequant
   ```

2. Verify GitHub access - the marketplace requires read access to the repo:
   ```bash
   gh repo view admarble/sequant
   ```

3. If behind a proxy, ensure GitHub is accessible from Claude Code.

### Plugin install fails

**Problem:** `/plugin install sequant` fails after adding the marketplace.

**Solutions:**

1. Verify the marketplace was added successfully:
   ```
   /plugin marketplace list
   ```

2. Try reinstalling with explicit marketplace reference:
   ```
   /plugin install sequant@admarble/sequant
   ```

3. Check for conflicting plugin names:
   ```
   /plugin list
   ```

4. Remove and re-add the marketplace:
   ```
   /plugin marketplace remove admarble/sequant
   /plugin marketplace add admarble/sequant
   /plugin install sequant
   ```

### Skills not available after plugin install

**Problem:** After installing, `/fullsolve` or other Sequant skills aren't recognized.

**Solutions:**

1. Restart Claude Code to reload plugins:
   - Close the terminal or IDE session
   - Reopen Claude Code

2. Verify plugin is enabled:
   ```
   /plugin list
   ```
   Look for `sequant` in the enabled plugins.

3. Check skill namespace - plugin skills may require prefix:
   ```
   /sequant:fullsolve 123    # Namespaced version
   /fullsolve 123            # Direct version (if no conflicts)
   ```

4. Re-enable the plugin if disabled:
   ```
   /plugin enable sequant
   ```

### `/sequant:setup` fails

**Problem:** The setup skill fails to initialize worktrees directory or copy constitution.

**Solutions:**

1. Verify you're in a git repository:
   ```bash
   git status
   ```

2. Check git is configured:
   ```bash
   git config user.name
   git config user.email
   ```

3. Verify GitHub CLI is authenticated:
   ```bash
   gh auth status
   ```

4. Create worktrees directory manually if needed:
   ```bash
   mkdir -p ../worktrees/feature
   ```

5. Copy constitution template manually:
   ```bash
   # From the plugin cache (path varies)
   cp ~/.claude/plugins/cache/sequant/memory/constitution.md .claude/memory/constitution.md
   ```

### Plugin updates not applying

**Problem:** After a new version releases, you still have the old version.

**Solutions:**

1. Third-party marketplaces don't auto-update by default. Update manually:
   ```
   /plugin marketplace update admarble/sequant
   ```

2. Verify update applied:
   ```
   /plugin list
   ```
   Check the version number.

3. If still outdated, try reinstall:
   ```
   /plugin uninstall sequant
   /plugin install sequant@admarble/sequant
   ```

### Hook permission errors

**Problem:** Plugin hooks fail with permission errors.

**Solutions:**

1. Plugin hooks should be executable by default. If not, locate and fix:
   ```bash
   # Find plugin cache location
   ls ~/.claude/plugins/cache/

   # Make hooks executable
   chmod +x ~/.claude/plugins/cache/sequant*/hooks/*.sh
   ```

2. Check your shell - hooks are bash scripts:
   - Works: bash, zsh
   - May need configuration: fish, tcsh

### Conflict with npm install

**Problem:** Both npm-installed Sequant and plugin are present.

**Solutions:**

This is fine - both can coexist. The plugin provides Claude Code skills, while npm provides the CLI.

**Recommended approach:**
- Use plugin for `/fullsolve`, `/spec`, `/exec`, etc. (Claude Code integration)
- Use npm for `npx sequant run` (headless CLI mode)

If you want only one:
- **Plugin only:** Uninstall npm package: `npm uninstall sequant`
- **npm only:** Uninstall plugin: `/plugin uninstall sequant`

### Settings merge behavior

**Problem:** Confusion about how plugin settings interact with existing `.claude/settings.json`.

**How it works:**

Plugins do **not** automatically merge settings. Instead:
- Plugin provides skills, hooks, and scripts
- Your existing `.claude/settings.json` remains unchanged
- Plugin configuration stored in `enabledPlugins` key

**Settings scope cascade (highest to lowest priority):**

| Scope | File | Purpose |
|-------|------|---------|
| `local` | `.claude/settings.local.json` | Project-specific, gitignored |
| `project` | `.claude/settings.json` | Team settings, version controlled |
| `user` | `~/.claude/settings.json` | Personal settings across all projects |
| `managed` | `managed-settings.json` | Admin-controlled (read-only) |

**Key points:**
- Plugin skills are immediately available after install (no settings merge needed)
- Plugin hooks are registered automatically
- Your existing project settings (permissions, MCPs, etc.) are preserved
- To override plugin behavior, add settings to your project's `.claude/settings.json`

**Common scenarios:**

1. **Plugin installed, want to disable a hook:**
   ```json
   // .claude/settings.json
   {
     "hooks": {
       "PreToolUse": []  // Disables pre-tool hooks
     }
   }
   ```

2. **Plugin installed, want custom MCP config:**
   - Add your MCP config to `.claude/settings.json` - it won't conflict with plugin

3. **Plugin installed, want to override a skill:**
   - Create your own version in `.claude/skills/<skill-name>/SKILL.md`
   - Local skills take precedence over plugin skills

---

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
   npm install -g sequant
   ```

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
   npm update sequant
   # or remove local and use npx
   npm uninstall sequant
   npx sequant@latest run 123
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

3. Move customizations to `.local/`:
   ```bash
   mkdir -p .claude/.local/skills/spec
   mv .claude/skills/spec/SKILL.md .claude/.local/skills/spec/
   sequant update
   ```

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

4. File an issue: [GitHub Issues](https://github.com/admarble/sequant/issues)

## See Also

- [Customization Guide](guides/customization.md)
- [Stack Guides](stacks/)
