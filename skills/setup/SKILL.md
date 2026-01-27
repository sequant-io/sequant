---
name: setup
description: "Initialize Sequant in your project - copies constitution and creates worktrees directory"
license: MIT
metadata:
  author: sequant
  version: "1.1"
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
  - Bash(basename:*)
  - Bash(jq:*)
  - Bash(grep:*)
  - Bash(head:*)
---

# Sequant Setup

Initialize Sequant workflow system in your current project.

## Purpose

When invoked as `/sequant:setup` or `/setup`, this skill:

1. Creates the worktrees directory structure
2. Detects your project name automatically
3. Copies the constitution.md template with project name filled in
4. Validates prerequisites (git, gh CLI)

## Usage

```
/sequant:setup
```

## What It Does

### 1. Validate Prerequisites

```bash
git --version
gh auth status
```

### 2. Create Worktrees Directory

```bash
mkdir -p ../worktrees/feature
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
  PROJECT_NAME=$(grep -A5 '^\[package\]' Cargo.toml | grep '^name' | head -1 | sed 's/.*=\s*["'\'']\([^"'\'']*\)["'\''].*/\1/')
fi

# 3. Try pyproject.toml
if [ -z "$PROJECT_NAME" ] && [ -f "pyproject.toml" ]; then
  # Try [project] section first (PEP 621)
  PROJECT_NAME=$(grep -A5 '^\[project\]' pyproject.toml | grep '^name' | head -1 | sed 's/.*=\s*["'\'']\([^"'\'']*\)["'\''].*/\1/')
  # Fallback to [tool.poetry] section
  if [ -z "$PROJECT_NAME" ]; then
    PROJECT_NAME=$(grep -A5 '^\[tool\.poetry\]' pyproject.toml | grep '^name' | head -1 | sed 's/.*=\s*["'\'']\([^"'\'']*\)["'\''].*/\1/')
  fi
fi

# 4. Try go.mod
if [ -z "$PROJECT_NAME" ] && [ -f "go.mod" ]; then
  MODULE_PATH=$(grep '^module ' go.mod | head -1 | awk '{print $2}')
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

### 4. Copy Constitution Template

```bash
mkdir -p .claude/memory
cp "${CLAUDE_PLUGIN_ROOT}/memory/constitution.md" .claude/memory/constitution.md
```

### 5. Replace Project Name Placeholder

```bash
# Replace {{PROJECT_NAME}} with detected project name
sed -i.bak "s/{{PROJECT_NAME}}/$PROJECT_NAME/g" .claude/memory/constitution.md
rm -f .claude/memory/constitution.md.bak
```

### 6. Verify Setup

```bash
# Show the constitution header to confirm project name was applied
head -3 .claude/memory/constitution.md
```

## Post-Setup

1. Review `.claude/memory/constitution.md` - project name should be filled in
2. Add any project-specific guidelines to the constitution
3. Run `/assess <issue>` to start working
4. Run `/fullsolve <issue>` for end-to-end resolution

## Troubleshooting

**Project name shows as directory name instead of package name:**
- Ensure your `package.json`, `Cargo.toml`, `pyproject.toml`, or `go.mod` has a valid `name` field
- Check that the file is valid JSON/TOML

**Project name placeholder not replaced:**
- Check that `sed` is available on your system
- Manually edit the constitution file if needed
