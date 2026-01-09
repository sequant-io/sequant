# Troubleshooting Guide

Common issues and solutions when using Sequant.

## Installation Issues

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

- [Customization Guide](customization.md)
- [Stack Guides](stacks/)
