---
name: setup
description: "Initialize Sequant in your project - prerequisites, config, worktrees, and constitution"
license: MIT
metadata:
  author: sequant
  version: "2.0"
allowed-tools:
  - Read
  - Write
  - Bash(mkdir:*)
  - Bash(cp:*)
  - Bash(ls:*)
  - Bash(cat:*)
  - Bash(sed:*)
  - Bash(git --version)
  - Bash(git remote:*)
  - Bash(gh auth status:*)
  - Bash(gh --version:*)
  - Bash(basename:*)
  - Bash(jq:*)
  - Bash(grep:*)
  - Bash(head:*)
  - Bash(node --version:*)
  - Bash(node -e:*)
  - Bash(npm --version:*)
  - Bash(which:*)
  - Bash(yarn --version:*)
  - Bash(pnpm --version:*)
  - Bash(curl:*)
---

# Sequant Setup

Initialize Sequant workflow system in your current project.

## Purpose

When invoked as `/sequant:setup` or `/setup`, this skill configures everything a plugin user needs — the equivalent of `sequant init` for npm users.

## Usage

```
/sequant:setup
```

## What It Does

### 1. Check Prerequisites

Verify all required tools are installed and authenticated.

```bash
echo "=== Sequant Prerequisites Check ==="

# 1. Git
if git --version >/dev/null 2>&1; then
  echo "✅ git: $(git --version | head -1)"
else
  echo "❌ git: not found — install from https://git-scm.com"
  PREREQ_FAIL=true
fi

# 2. GitHub CLI
if gh --version >/dev/null 2>&1; then
  echo "✅ gh: $(gh --version | head -1)"
  if gh auth status >/dev/null 2>&1; then
    echo "✅ gh auth: authenticated"
  else
    echo "❌ gh auth: not authenticated — run 'gh auth login'"
    PREREQ_FAIL=true
  fi
else
  echo "❌ gh: not found — install from https://cli.github.com"
  PREREQ_FAIL=true
fi

# 3. Node.js 20+ (for MCP server via npx)
if node --version >/dev/null 2>&1; then
  NODE_VER=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ] 2>/dev/null; then
    echo "✅ node: $(node --version) (>= 20)"
  else
    echo "⚠️  node: $(node --version) — MCP server requires Node.js 20+. Upgrade recommended."
  fi
else
  echo "⚠️  node: not found — MCP server (npx sequant serve) requires Node.js 20+"
fi

if [ "$PREREQ_FAIL" = "true" ]; then
  echo ""
  echo "Fix the issues above, then re-run /sequant:setup"
fi
```

If any critical prerequisite fails (git or gh), stop and report. Node.js is a warning (needed for MCP server but not skills).

### 2. Create Worktrees Directory

```bash
mkdir -p ../worktrees/feature
echo "✅ Created ../worktrees/feature/"
```

### 3. Detect Project Name

The skill automatically detects your project name from available sources in priority order:

1. **package.json** - Node.js projects (`name` field)
2. **Cargo.toml** - Rust projects (`[package] name`)
3. **pyproject.toml** - Python projects (`[project] name` or `[tool.poetry] name`)
4. **go.mod** - Go projects (module path, last segment)
5. **Git remote** - Extract repo name from origin URL
6. **Directory name** - Fallback to current directory name

```bash
# Detection script (run each step until a name is found)

# 1. Try package.json
if [ -f "package.json" ]; then
  PROJECT_NAME=$(cat package.json | jq -r '.name // empty' 2>/dev/null)
fi

# 2. Try Cargo.toml
if [ -z "$PROJECT_NAME" ] && [ -f "Cargo.toml" ]; then
  PROJECT_NAME=$(grep -A5 '^\[package\]' Cargo.toml | grep '^name' | head -1 | sed 's/.*=\s*["'\'']\([^"'\'']*\)["'\''].*/\1/' || true)
fi

# 3. Try pyproject.toml
if [ -z "$PROJECT_NAME" ] && [ -f "pyproject.toml" ]; then
  # Try [project] section first (PEP 621)
  PROJECT_NAME=$(grep -A5 '^\[project\]' pyproject.toml | grep '^name' | head -1 | sed 's/.*=\s*["'\'']\([^"'\'']*\)["'\''].*/\1/' || true)
  # Fallback to [tool.poetry] section
  if [ -z "$PROJECT_NAME" ]; then
    PROJECT_NAME=$(grep -A5 '^\[tool\.poetry\]' pyproject.toml | grep '^name' | head -1 | sed 's/.*=\s*["'\'']\([^"'\'']*\)["'\''].*/\1/' || true)
  fi
fi

# 4. Try go.mod
if [ -z "$PROJECT_NAME" ] && [ -f "go.mod" ]; then
  MODULE_PATH=$(grep '^module ' go.mod | head -1 | awk '{print $2}' || true)
  PROJECT_NAME=$(basename "$MODULE_PATH")
fi

# 5. Try git remote
if [ -z "$PROJECT_NAME" ]; then
  REMOTE_URL=$(git remote get-url origin 2>/dev/null)
  if [ -n "$REMOTE_URL" ]; then
    # Handle both SSH and HTTPS formats
    PROJECT_NAME=$(echo "$REMOTE_URL" | sed 's/.*[:/]\([^/]*\)\.git$/\1/' | sed 's/.*\/\([^/]*\)$/\1/')
  fi
fi

# 6. Fallback to directory name
if [ -z "$PROJECT_NAME" ]; then
  PROJECT_NAME=$(basename "$(pwd)")
fi

echo "Detected project name: $PROJECT_NAME"
```

### 4. Create .sequant/ Configuration

```bash
mkdir -p .sequant
```

Create `.sequant/settings.json` with sensible defaults:

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
    "mcp": true,
    "retry": true,
    "staleBranchThreshold": 5
  },
  "agents": {
    "parallel": false,
    "model": "haiku"
  }
}
```

Use the Write tool to create `.sequant/settings.json` with the above content.

### 5. Detect Package Manager

```bash
# Detect package manager
PM_RUN="npm run"
if [ -f "pnpm-lock.yaml" ]; then
  PM_RUN="pnpm run"
  echo "✅ Detected package manager: pnpm"
elif [ -f "yarn.lock" ]; then
  PM_RUN="yarn"
  echo "✅ Detected package manager: yarn"
elif [ -f "bun.lockb" ]; then
  PM_RUN="bun run"
  echo "✅ Detected package manager: bun"
elif [ -f "package-lock.json" ]; then
  PM_RUN="npm run"
  echo "✅ Detected package manager: npm"
else
  echo "ℹ️  No lock file found — defaulting to npm"
fi
```

Store `PM_RUN` in settings for use by `/exec` and `/spec`:

After detecting PM_RUN, use the Edit tool to add it to `.sequant/settings.json` under the `run` section:
```json
{
  "run": {
    "pmRun": "<detected PM_RUN value>"
  }
}
```

### 6. Detect Dev Server URL

```bash
# Detect dev server URL from common patterns
DEV_URL=""

if [ -f "package.json" ]; then
  # Check for common dev scripts
  DEV_SCRIPT=$(cat package.json | jq -r '.scripts.dev // empty' 2>/dev/null)

  if echo "$DEV_SCRIPT" | grep -q "next"; then
    DEV_URL="http://localhost:3000"
    echo "✅ Detected Next.js dev server: $DEV_URL"
  elif echo "$DEV_SCRIPT" | grep -q "vite"; then
    DEV_URL="http://localhost:5173"
    echo "✅ Detected Vite dev server: $DEV_URL"
  elif echo "$DEV_SCRIPT" | grep -q "nuxt"; then
    DEV_URL="http://localhost:3000"
    echo "✅ Detected Nuxt dev server: $DEV_URL"
  elif echo "$DEV_SCRIPT" | grep -q "remix"; then
    DEV_URL="http://localhost:3000"
    echo "✅ Detected Remix dev server: $DEV_URL"
  elif [ -n "$DEV_SCRIPT" ]; then
    DEV_URL="http://localhost:3000"
    echo "ℹ️  Dev script found but server URL unclear — defaulting to $DEV_URL"
    echo "    Update .sequant/settings.json if your dev server uses a different port."
  fi
fi

if [ -z "$DEV_URL" ]; then
  echo "ℹ️  No dev server detected (not needed for CLI/backend projects)"
fi
```

Store `DEV_URL` in settings if detected. Use the Edit tool to add:
```json
{
  "run": {
    "devUrl": "<detected DEV_URL value>"
  }
}
```

### 7. Create .sequant-manifest.json

Create a manifest with version and stack info for diagnostics:

```bash
# Detect stack
STACK="unknown"
if [ -f "next.config.js" ] || [ -f "next.config.ts" ] || [ -f "next.config.mjs" ]; then
  STACK="nextjs"
elif [ -f "vite.config.ts" ] || [ -f "vite.config.js" ]; then
  STACK="vite"
elif [ -f "nuxt.config.ts" ]; then
  STACK="nuxt"
elif [ -f "Cargo.toml" ]; then
  STACK="rust"
elif [ -f "go.mod" ]; then
  STACK="go"
elif [ -f "pyproject.toml" ]; then
  STACK="python"
elif [ -f "package.json" ]; then
  STACK="node"
fi
```

Use the Write tool to create `.sequant-manifest.json`:
```json
{
  "version": "latest",
  "installedVia": "plugin",
  "stack": "<detected stack>",
  "pmRun": "<detected PM_RUN>",
  "createdAt": "<ISO-8601 timestamp>"
}
```

### 8. Copy Constitution Template

```bash
mkdir -p .claude/memory
CONST_SRC="${CLAUDE_PLUGIN_ROOT:-./templates}/memory/constitution.md"
cp "$CONST_SRC" .claude/memory/constitution.md
```

### 9. Replace Project Name Placeholder

```bash
# Replace {{PROJECT_NAME}} with detected project name
sed -i.bak "s/{{PROJECT_NAME}}/$PROJECT_NAME/g" .claude/memory/constitution.md
rm -f .claude/memory/constitution.md.bak
```

### 10. Print Summary

After setup completes, print a summary:

```markdown
## Sequant Setup Complete

### What was configured

| Item | Status |
|------|--------|
| Prerequisites | ✅ git, gh, node checked |
| Worktrees | ✅ ../worktrees/feature/ created |
| Project name | ✅ <PROJECT_NAME> |
| Config | ✅ .sequant/settings.json |
| Package manager | ✅ <PM_RUN> |
| Dev server | ✅ <DEV_URL> (or ℹ️ not detected) |
| Manifest | ✅ .sequant-manifest.json |
| Constitution | ✅ .claude/memory/constitution.md |

### MCP Tools Available

The plugin includes an MCP server that provides these tools automatically:

| Tool | Purpose |
|------|---------|
| `sequant_status` | Check issue progress and workflow state |
| `sequant_run` | Execute workflow phases (spec, exec, qa) |
| `sequant_logs` | Review past run results and debug failures |

### What's Next

You're all set — run `/assess <issue>` to start working on a GitHub issue.

**Common commands:**
- `/assess 123` — Analyze issue, get recommended workflow
- `/fullsolve 123` — End-to-end: spec → exec → qa → PR
- `/spec 123` — Plan implementation only
- `/exec 123` — Implement only
```

## Post-Setup

1. Review `.claude/memory/constitution.md` - project name should be filled in
2. Add any project-specific guidelines to the constitution
3. Optionally edit `.sequant/settings.json` to customize:
   - `devUrl` — if auto-detection picked the wrong port
   - `pmRun` — if using a non-standard package manager command
   - `agents.parallel` — set to `true` for faster but more token-expensive runs
4. Run `/assess <issue>` to start working

## Troubleshooting

**Project name shows as directory name instead of package name:**
- Ensure your `package.json`, `Cargo.toml`, `pyproject.toml`, or `go.mod` has a valid `name` field
- Check that the file is valid JSON/TOML

**MCP tools not available:**
- Ensure Node.js 20+ is installed (`node --version`)
- The MCP server starts automatically via `npx sequant@latest serve`
- Check Claude Code settings if tools don't appear

**Settings not being picked up:**
- Verify `.sequant/settings.json` is valid JSON
- Check that `.sequant/` is not gitignored in your project (it should be — these are local settings)
