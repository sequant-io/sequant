# Release Checklist

Before tagging a release, verify:

## Build & Test
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] `npm run lint` passes

## Validation
- [ ] All skills validate: `npm run validate:skills`
- [ ] `sequant doctor` passes in a test project

## Package
- [ ] Version bumped in `package.json`
- [ ] CHANGELOG.md updated
- [ ] No uncommitted changes: `git status`

## Plugin Version Sync

**Both npm and plugin must use the same version.**

- [ ] `.claude-plugin/plugin.json` version matches `package.json`
- [ ] Validate plugin manifest: `/plugin validate .` (in Claude Code)

To update both versions together:
```bash
# Bump version in both files
npm version patch --no-git-tag-version
# Update plugin.json to match
node -e "
const pkg = require('./package.json');
const plugin = require('./.claude-plugin/plugin.json');
plugin.version = pkg.version;
require('fs').writeFileSync('./.claude-plugin/plugin.json', JSON.stringify(plugin, null, 2) + '\n');
"
```

Or use the `/release` skill which handles this automatically.

## Issue Integration

Before merging, verify the full trail for each issue:

1. **Issue comments** - Check for spec/exec/qa progress:
   ```bash
   gh api repos/:owner/:repo/issues/<N>/comments --jq '.[].body' | head -50
   ```

2. **Worktrees** - Check for active feature branches:
   ```bash
   git worktree list
   ```

3. **Branch diff** - Verify work exists:
   ```bash
   git -C <worktree-path> diff main...HEAD --stat
   ```

4. **PRs** - Check if PR exists:
   ```bash
   gh pr list --head feature/<N>-*
   ```

5. **Main branch** - Only check main after confirming no pending worktree/PR

## Smoke Test
- [ ] `sequant init` works in a fresh directory
- [ ] `sequant run <issue> --dry-run` works

## Plugin Smoke Test

After release, verify the plugin works for new users:

```bash
# In a fresh Claude Code session (different project)
/plugin marketplace add sequant-io/sequant
/plugin install sequant

# Verify skills are available
/sequant:setup
```
