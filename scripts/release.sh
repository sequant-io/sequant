#!/bin/bash
# Release script for sequant
# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 1.1.0

set -e

VERSION=$1
DATE=$(date +%Y-%m-%d)
REMOTE="origin"
MAIN_BRANCH="main"

if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/release.sh <version>"
  echo "Example: ./scripts/release.sh 1.1.0"
  exit 1
fi

# Validate version format (semver)
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  echo "Error: Version must be semver format (e.g., 1.0.0, 1.1.0-beta.1)"
  exit 1
fi

echo "🚀 Releasing sequant v$VERSION"
echo ""

# Check we're on main branch
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "$MAIN_BRANCH" ]]; then
  echo "Error: Must be on $MAIN_BRANCH branch (currently on $BRANCH)"
  exit 1
fi

# Check for uncommitted changes
if [[ -n $(git status --porcelain) ]]; then
  echo "Error: Uncommitted changes detected. Commit or stash first."
  git status --short
  exit 1
fi

# Pull latest
echo "📥 Pulling latest changes..."
git pull $REMOTE $MAIN_BRANCH

# Run tests/build to verify
echo "🔍 Running pre-release checks..."
npm run build
npm run lint

# Update CHANGELOG
echo "📝 Updating CHANGELOG.md..."
if grep -q "## \[Unreleased\]" CHANGELOG.md; then
  # macOS sed syntax
  sed -i '' "s/## \[Unreleased\]/## [Unreleased]\n\n## [$VERSION] - $DATE/" CHANGELOG.md

  # Update comparison links at bottom
  if grep -q "\[Unreleased\]:.*compare" CHANGELOG.md; then
    # Get previous version from changelog
    PREV_VERSION=$(grep -oE '\[[0-9]+\.[0-9]+\.[0-9]+\]' CHANGELOG.md | head -2 | tail -1 | tr -d '[]')
    if [[ -n "$PREV_VERSION" ]]; then
      sed -i '' "s|\[Unreleased\]:.*|[Unreleased]: https://github.com/admarble/sequant/compare/v$VERSION...HEAD\n[$VERSION]: https://github.com/admarble/sequant/compare/v$PREV_VERSION...v$VERSION|" CHANGELOG.md
    fi
  fi
else
  echo "Warning: No [Unreleased] section found in CHANGELOG.md"
fi

# Bump version in package.json
echo "📦 Bumping version to $VERSION..."
npm version "$VERSION" --no-git-tag-version

# Commit release
echo "💾 Committing release..."
git add -A
git commit -m "chore: release v$VERSION

Release highlights:
$(grep -A 20 "## \[$VERSION\]" CHANGELOG.md | grep -E '^\s*-' | head -5)

🤥 Generated with [Claude Code](https://claude.com/claude-code)"

# Create tag
echo "🏷‏  Creating tag v$VERSION..."
git tag -a "v$VERSION" -m "Release v$VERSION"

# Send to remote
echo "🚀 Sending to remote..."
git push $REMOTE $MAIN_BRANCH
git push $REMOTE "v$VERSION"

# Create GitHub release
echo "📋 Creating GitHub release..."
RELEASE_NOTES=$(awk "/## \[$VERSION\]/,/## \[/" CHANGELOG.md | head -n -1 | tail -n +2)
gh release create "v$VERSION" \
  --title "v$VERSION" \
  --notes "$RELEASE_NOTES"

# Publish to npm (if configured)
if [[ -f ".npmrc" ]] || npm whoami &>/dev/null; then
  echo "📦 Publishing to npm..."
  npm publish
else
  echo "⚠️  Skipping npm publish (not logged in)"
  echo "   Run 'npm login' and then 'npm publish' manually"
fi

echo ""
echo "✅ Released sequant v$VERSION"
echo ""
echo "Next steps:"
echo "  - Verify GitHub release: https://github.com/admarble/sequant/releases/tag/v$VERSION"
echo "  - Verify npm package: https://www.npmjs.com/package/sequant"
echo "  - Announce release (if applicable)"
