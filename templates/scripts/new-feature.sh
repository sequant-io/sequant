#!/bin/bash

# Create a new feature worktree from a GitHub issue
# Usage: ./scripts/new-feature.sh <issue-number>
# Example: ./scripts/new-feature.sh 4

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if issue number is provided
if [ -z "$1" ]; then
    echo -e "${RED}❌ Error: Issue number required${NC}"
    echo "Usage: ./scripts/new-feature.sh <issue-number>"
    echo "Example: ./scripts/new-feature.sh 4"
    exit 1
fi

ISSUE_NUMBER=$1

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    echo -e "${RED}❌ GitHub CLI not found. Install from: https://cli.github.com${NC}"
    exit 1
fi

# Clear invalid GITHUB_TOKEN if set
export GITHUB_TOKEN=""

# Check if authenticated
if ! gh auth status &> /dev/null; then
    echo -e "${RED}❌ Not authenticated with GitHub. Run: unset GITHUB_TOKEN && gh auth login${NC}"
    exit 1
fi

echo -e "${BLUE}📋 Fetching issue #${ISSUE_NUMBER}...${NC}"

# Fetch issue details
ISSUE_ERROR=$(mktemp)
if ! ISSUE_DATA=$(gh issue view "$ISSUE_NUMBER" --json title,labels,number 2>"$ISSUE_ERROR"); then
    echo -e "${RED}❌ Failed to fetch issue #${ISSUE_NUMBER}${NC}"
    if [ -s "$ISSUE_ERROR" ]; then
        echo -e "${YELLOW}   Error: $(cat "$ISSUE_ERROR")${NC}"
    fi
    rm -f "$ISSUE_ERROR"
    exit 1
fi
rm -f "$ISSUE_ERROR"

# Extract issue title and create branch name
ISSUE_TITLE=$(echo "$ISSUE_DATA" | jq -r '.title')
BRANCH_NAME=$(echo "$ISSUE_TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//')
BRANCH_NAME="feature/${ISSUE_NUMBER}-${BRANCH_NAME}"

# Truncate branch name if too long (max 50 chars after feature/)
if [ ${#BRANCH_NAME} -gt 58 ]; then
    BRANCH_NAME=$(echo "$BRANCH_NAME" | cut -c1-58)
fi

# Get the git repo root (works even if run from subdirectory)
MAIN_REPO_DIR="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$MAIN_REPO_DIR" ]; then
    echo -e "${RED}❌ Not in a git repository${NC}"
    exit 1
fi

# Change to repo root for consistent behavior
cd "$MAIN_REPO_DIR"

# Worktree directory
WORKTREE_DIR="../worktrees/${BRANCH_NAME}"

echo -e "${GREEN}✨ Creating worktree for issue #${ISSUE_NUMBER}${NC}"
echo -e "${BLUE}Branch: ${BRANCH_NAME}${NC}"
echo -e "${BLUE}Worktree: ${WORKTREE_DIR}${NC}"
echo ""

# Check for uncommitted changes before switching branches
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    echo -e "${RED}❌ Working tree has uncommitted changes${NC}"
    echo -e "${YELLOW}   Commit or stash your changes first:${NC}"
    echo -e "   git stash push -m 'WIP before issue #${ISSUE_NUMBER}'"
    exit 1
fi

# Check if branch already exists
if git show-ref --verify --quiet "refs/heads/${BRANCH_NAME}"; then
    echo -e "${YELLOW}⚠️  Branch ${BRANCH_NAME} already exists${NC}"

    # Check if worktree exists too
    EXISTING_WORKTREE=$(git worktree list | grep "${BRANCH_NAME}" | awk '{print $1}')
    if [ -n "$EXISTING_WORKTREE" ]; then
        echo -e "${GREEN}✅ Worktree already exists at: ${EXISTING_WORKTREE}${NC}"
        echo -e "${BLUE}   cd ${EXISTING_WORKTREE}${NC}"
        exit 0
    else
        echo -e "${RED}❌ Branch exists but no worktree found${NC}"
        echo -e "${YELLOW}   To create worktree from existing branch:${NC}"
        echo -e "   git worktree add ../worktrees/${BRANCH_NAME} ${BRANCH_NAME}"
        echo -e "${YELLOW}   Or delete the branch first:${NC}"
        echo -e "   git branch -D ${BRANCH_NAME}"
        exit 1
    fi
fi

# Update main branch
echo -e "${BLUE}📥 Updating main branch...${NC}"
git fetch origin main
git checkout main
git pull origin main

# Create worktree
echo -e "${BLUE}🌿 Creating new worktree...${NC}"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME"

# Navigate to worktree
cd "$WORKTREE_DIR"

# Copy environment files if they exist (use absolute path from main repo)
for ENV_FILE in .env .env.local .env.development; do
    if [ -f "${MAIN_REPO_DIR}/${ENV_FILE}" ]; then
        echo -e "${BLUE}📋 Copying ${ENV_FILE}...${NC}"
        cp "${MAIN_REPO_DIR}/${ENV_FILE}" "${ENV_FILE}"
    fi
done

# Copy .claude/settings.local.json for auto-approved permissions
if [ -f "${MAIN_REPO_DIR}/.claude/settings.local.json" ]; then
    echo -e "${BLUE}📋 Copying .claude/settings.local.json...${NC}"
    mkdir -p .claude
    cp "${MAIN_REPO_DIR}/.claude/settings.local.json" .claude/settings.local.json
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}📦 Installing dependencies...${NC}"
    npm install --silent
fi

echo ""
echo -e "${GREEN}✅ Worktree created successfully!${NC}"
echo ""
echo -e "${YELLOW}📍 Next steps:${NC}"
echo -e "  1. cd ${WORKTREE_DIR}"
echo -e "  2. npm run dev"
echo -e "  3. Work on issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}"
echo -e "  4. git add . && git commit -m \"Your message\""
echo -e "  5. git push -u origin ${BRANCH_NAME}"
echo -e "  6. ./scripts/create-pr.sh ${ISSUE_NUMBER}"
echo ""
echo -e "${BLUE}🗂️  Active worktrees:${NC}"
git worktree list
echo ""
