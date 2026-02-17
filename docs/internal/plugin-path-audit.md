# Plugin Path Audit

This document audits all path dependencies in Sequant skills and scripts to ensure compatibility with both npm installation and Claude Code plugin installation.

## Installation Methods

| Method | Skills Location | Scripts Location | Hooks Location |
|--------|-----------------|------------------|----------------|
| npm install | `.claude/skills/` | `scripts/` | `.claude/hooks/` |
| Plugin install | `~/.claude/plugins/cache/sequant/skills/` | `~/.claude/plugins/cache/sequant/scripts/` | `~/.claude/plugins/cache/sequant/hooks/` |

## Path Resolution Strategy

### Scripts

All Sequant scripts use **git-based path resolution** rather than hardcoded paths:

```bash
# Used in scripts/new-feature.sh, cleanup-worktree.sh, list-worktrees.sh
git rev-parse --show-toplevel  # Gets project root
```

**Why this works:** Scripts operate on the user's project, not the plugin location. They need to find the project root regardless of where Sequant is installed.

### Hooks

Plugin hooks use `${CLAUDE_PLUGIN_ROOT}` for self-reference:

```json
// hooks/hooks.json
{
  "hooks": {
    "PreToolUse": [{
      "command": "\"${CLAUDE_PLUGIN_ROOT}/hooks/pre-tool.sh\""
    }]
  }
}
```

**Key insight:** `${CLAUDE_PLUGIN_ROOT}` is expanded at skill/hook load time by Claude Code, not at runtime. This means:
- ✅ Works in hook configuration files
- ✅ Works in skill markdown content
- ❌ Not available as environment variable to scripts

### Skills

Skills reference scripts via project-relative paths or rely on tools being in PATH:

| Skill | Path Dependencies | Resolution |
|-------|-------------------|------------|
| `/spec` | `gh`, `git` | System PATH |
| `/exec` | `npm`, `git`, `gh` | System PATH |
| `/test` | `npm`, `git`, `gh`, `lsof` | System PATH |
| `/qa` | `npm`, `git`, `gh` | System PATH |
| `/fullsolve` | Orchestrates other skills | No direct path deps |

## Audit Results

### ✅ Compatible Components

| Component | Why It Works |
|-----------|--------------|
| `scripts/new-feature.sh` | Uses `git rev-parse` for project root |
| `scripts/cleanup-worktree.sh` | Uses `git rev-parse` for project root |
| `scripts/list-worktrees.sh` | Uses `git worktree list` (git-relative) |
| `hooks/hooks.json` | Uses `${CLAUDE_PLUGIN_ROOT}` |
| `hooks/pre-tool.sh` | Uses `$CLAUDE_PROJECT_DIR` or falls back to `git rev-parse` |
| `hooks/post-tool.sh` | Uses `$CLAUDE_PROJECT_DIR` or falls back to `git rev-parse` |

### ⚠️ Template Tokens

Some skills use template tokens that need substitution:

| Token | Default | Purpose |
|-------|---------|---------|
| `{{PM_RUN}}` | `npm run` | Package manager run command |
| `{{DEV_URL}}` | `http://localhost:3000` | Development server URL |

**Resolution:** These tokens are:
1. Replaced during `sequant init` (npm installation)
2. Used as-is with documented defaults (plugin installation)
3. Skills include fallback behavior when tokens aren't substituted

### npm-Specific References

| File | npm Reference | Impact |
|------|---------------|--------|
| `scripts/release.sh` | `npm run build`, `npm publish` | Release-only, not user-facing |
| `scripts/new-feature.sh` | `npm install` | Worktree dependency install |
| `skills/exec/SKILL.md` | `npm test`, `npm run build` | With `{{PM_RUN}}` token |

**Mitigation:**
- Hooks detect package manager (npm, yarn, pnpm, bun) automatically
- Skills use `{{PM_RUN}}` token or document alternatives
- User projects may use any package manager

### Project-Relative Paths

Some skills reference project-specific config files. These are **intentionally project-relative**, not plugin-relative:

| File | Reference | Fallback |
|------|-----------|----------|
| `/test` | `.claude/.sequant/config.json` | Defaults: localhost:3000 (Next.js), :4321 (Astro), :5173 (Vite) |

These paths work correctly because:
- They reference the user's project configuration, not plugin files
- Each skill documents default values when config is missing
- Plugin installation doesn't affect project-relative paths

## MCP Fallback Audit

Skills that use optional MCPs include graceful degradation:

| Skill | MCP Used | Fallback Behavior |
|-------|----------|-------------------|
| `/test` | chrome-devtools | Generates manual testing checklist |
| `/exec` | context7, sequential-thinking | WebSearch, step-by-step analysis |
| `/spec` | context7, sequential-thinking | Codebase search, explicit reasoning |
| `/qa` | context7, sequential-thinking | Codebase search, explicit reasoning |
| `/loop` | all three | Explicit analysis steps, WebSearch |
| `/fullsolve` | all three | Delegates to child skills with fallbacks |

## Recommendations

### For Plugin Users

1. **Install prerequisites:** `gh` CLI, `git` must be in PATH
2. **Optional MCPs:** chrome-devtools, context7, sequential-thinking enhance functionality
3. **Package manager:** Any (npm, yarn, pnpm, bun) - auto-detected by hooks

### For Maintainers

1. **Avoid hardcoded paths:** Use `git rev-parse` or `${CLAUDE_PLUGIN_ROOT}`
2. **Test both installations:** Verify changes work with npm and plugin install
3. **Document fallbacks:** When adding MCP features, include fallback behavior
4. **Use tokens for PM:** Use `{{PM_RUN}}` instead of hardcoding `npm run`

## Testing Checklist

### npm Installation
- [ ] `npm install -g sequant` succeeds
- [ ] `sequant init` creates proper structure
- [ ] `/fullsolve` works end-to-end
- [ ] Hooks execute without path errors

### Plugin Installation
- [ ] `/plugin install sequant@sequant-io/sequant` succeeds
- [ ] Skills are recognized after install
- [ ] Hooks execute without path errors
- [ ] `/fullsolve` works end-to-end
- [ ] Works without optional MCPs (graceful degradation)

### Plugin Verification Script

Run this in Claude Code to verify plugin installation:

```
# Step 1: Add marketplace and install
/plugin marketplace add sequant-io/sequant
/plugin install sequant

# Step 2: Verify skills are available
# Type "/" and check that sequant skills appear (sequant:spec, sequant:exec, etc.)

# Step 3: Test a skill without MCPs
# Create a test issue or use an existing one
/sequant:assess 1  # Should work even without MCPs

# Step 4: Verify hooks are registered
# Run any tool and check if hooks execute (look for timing info in output)

# Step 5: Test worktree scripts
# In a git repository:
./scripts/list-worktrees.sh  # Should list worktrees

# Expected results:
# - All skills load without errors
# - Skills that use MCPs show "MCP unavailable, using fallback" (if MCPs not installed)
# - Worktree scripts find project root correctly
```

### MCP Degradation Verification

To verify graceful degradation without MCPs:

1. **Disable MCPs temporarily** (if installed):
   - Comment out MCP config in `.claude/settings.json`
   - Restart Claude Code

2. **Run MCP-dependent skills:**
   ```
   /sequant:spec 1    # Should use explicit reasoning instead of Sequential Thinking
   /sequant:test 1    # Should generate manual checklist instead of browser automation
   ```

3. **Verify output:**
   - Skills complete without errors
   - Output indicates fallback behavior used
   - Quality of output is acceptable (may be less automated but still useful)

---

*Last updated: 2026-01-27*
*Related: [Troubleshooting](../troubleshooting.md)*
