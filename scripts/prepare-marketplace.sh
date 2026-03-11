#!/bin/bash
# Prepare plugin package for official Claude Code marketplace submission
# Usage: ./scripts/prepare-marketplace.sh [--validate-only]
#
# Builds the external_plugins/sequant/ directory structure required by
# https://github.com/anthropics/claude-plugins-official

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/dist/marketplace/external_plugins/sequant"
VALIDATE_ONLY=false

if [[ "$1" == "--validate-only" ]]; then
  VALIDATE_ONLY=true
fi

echo "📦 Preparing marketplace package..."
echo ""

# Verify prerequisites
if [[ ! -f "$PROJECT_ROOT/package.json" ]]; then
  echo "❌ package.json not found. Run from project root."
  exit 1
fi

if [[ ! -f "$PROJECT_ROOT/.claude-plugin/plugin.json" ]]; then
  echo "❌ .claude-plugin/plugin.json not found."
  exit 1
fi

# Get version from package.json
VERSION=$(node -e "console.log(require('$PROJECT_ROOT/package.json').version)")
echo "Version: $VERSION"

# Check version sync
PLUGIN_VERSION=$(node -e "console.log(require('$PROJECT_ROOT/.claude-plugin/plugin.json').version)")
if [[ "$VERSION" != "$PLUGIN_VERSION" ]]; then
  echo "❌ Version mismatch: package.json ($VERSION) != plugin.json ($PLUGIN_VERSION)"
  echo "   Run ./scripts/release.sh to sync versions."
  exit 1
fi

if [[ "$VALIDATE_ONLY" == "true" ]]; then
  echo ""
  echo "🔍 Validating existing marketplace package..."

  if [[ ! -d "$OUTPUT_DIR" ]]; then
    echo "❌ No marketplace package found at $OUTPUT_DIR"
    echo "   Run without --validate-only first to build the package."
    exit 1
  fi
else
  # Clean previous build
  rm -rf "$PROJECT_ROOT/dist/marketplace"
  mkdir -p "$OUTPUT_DIR"

  # 1. Copy .claude-plugin/ (plugin.json only — marketplace.json is for self-hosted)
  echo "📋 Copying plugin metadata..."
  mkdir -p "$OUTPUT_DIR/.claude-plugin"
  cp "$PROJECT_ROOT/.claude-plugin/plugin.json" "$OUTPUT_DIR/.claude-plugin/plugin.json"

  # 2. Copy skills from templates/ (these are the distributable versions)
  echo "📋 Copying skills..."
  if [[ -d "$PROJECT_ROOT/templates/skills" ]]; then
    cp -r "$PROJECT_ROOT/templates/skills" "$OUTPUT_DIR/skills"
  fi

  # 3. Copy hooks configuration
  echo "📋 Copying hooks..."
  if [[ -d "$PROJECT_ROOT/templates/hooks" ]]; then
    mkdir -p "$OUTPUT_DIR/hooks"
    # Copy hook scripts
    cp "$PROJECT_ROOT/templates/hooks/"* "$OUTPUT_DIR/hooks/" 2>/dev/null || true
  fi

  # 4. Generate README for the marketplace listing
  echo "📋 Generating README..."
  cat > "$OUTPUT_DIR/README.md" << 'README_EOF'
# Sequant

Structured workflow system for Claude Code — GitHub issue resolution with spec, exec, test, and QA phases.

## Installation

```
/plugin install sequant@claude-plugin-directory
```

Or browse in `/plugin > Discover`.

## Features

- **16 workflow skills** for planning, implementation, testing, and code review
- **Automated quality gates** with test and QA loops
- **GitHub integration** for issue tracking and PR creation
- **Multi-stack support** (Next.js, Python, Go, Rust, and more)

## Skills

| Skill | Purpose |
|-------|---------|
| `/spec` | Plan implementation and extract acceptance criteria |
| `/exec` | Implement changes in a feature worktree |
| `/test` | Browser-based UI testing |
| `/qa` | Code review and AC validation |
| `/fullsolve` | End-to-end issue resolution |
| `/solve` | Generate recommended workflow for issues |

## Documentation

- [Getting Started](https://github.com/sequant-io/sequant/tree/main/docs/getting-started)
- [Configuration](https://github.com/sequant-io/sequant/tree/main/docs/reference)

## License

MIT
README_EOF
fi

# Validate the package structure
echo ""
echo "🔍 Validating marketplace structure..."
ERRORS=0

# Required: .claude-plugin/plugin.json
if [[ -f "$OUTPUT_DIR/.claude-plugin/plugin.json" ]]; then
  echo "  ✅ .claude-plugin/plugin.json"

  # Validate plugin.json has required fields
  for field in name description version author; do
    if ! node -e "const p=JSON.parse(require('fs').readFileSync('$OUTPUT_DIR/.claude-plugin/plugin.json','utf8')); if(!p.$field) process.exit(1)" 2>/dev/null; then
      echo "  ❌ plugin.json missing required field: $field"
      ERRORS=$((ERRORS + 1))
    fi
  done

  # Validate recommended fields for official marketplace
  for field in homepage repository license keywords; do
    if ! node -e "const p=JSON.parse(require('fs').readFileSync('$OUTPUT_DIR/.claude-plugin/plugin.json','utf8')); if(!p.$field) process.exit(1)" 2>/dev/null; then
      echo "  ⚠️  plugin.json missing recommended field: $field"
    fi
  done
else
  echo "  ❌ .claude-plugin/plugin.json (MISSING)"
  ERRORS=$((ERRORS + 1))
fi

# Optional but expected: skills/
if [[ -d "$OUTPUT_DIR/skills" ]]; then
  SKILL_COUNT=$(find "$OUTPUT_DIR/skills" -name "SKILL.md" -maxdepth 2 | wc -l | tr -d ' ')
  echo "  ✅ skills/ ($SKILL_COUNT skills found)"
else
  echo "  ⚠️  skills/ (not found — no skills will be installed)"
fi

# Optional: hooks/
if [[ -d "$OUTPUT_DIR/hooks" ]]; then
  echo "  ✅ hooks/"
else
  echo "  ℹ️  hooks/ (not included)"
fi

# Optional: README.md
if [[ -f "$OUTPUT_DIR/README.md" ]]; then
  echo "  ✅ README.md"
else
  echo "  ⚠️  README.md (recommended for marketplace listing)"
fi

# Summary
echo ""
if [[ $ERRORS -gt 0 ]]; then
  echo "❌ Validation failed with $ERRORS error(s)."
  exit 1
else
  echo "✅ Marketplace package is valid!"
  echo ""
  echo "Package location: $OUTPUT_DIR"
  echo ""
  echo "Next steps:"
  echo "  1. Review the package: ls -la $OUTPUT_DIR"
  echo "  2. Submit via: https://clau.de/plugin-directory-submission"
  echo "  3. Reference: https://github.com/anthropics/claude-plugins-official"
fi
