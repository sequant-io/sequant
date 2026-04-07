#!/bin/bash

# Clean up a worktree after PR is merged
# Usage: ./scripts/cleanup-worktree.sh <branch-name>
# Example: ./scripts/cleanup-worktree.sh feature/123-add-user-dashboard

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

BRANCH_NAME=$1

# Check if branch name provided
if [ -z "$BRANCH_NAME" ]; then
    echo -e "${RED}❌ Error: Branch name required${NC}"
    echo "Usage: ./scripts/cleanup-worktree.sh <branch-name>"
    echo ""
    echo "Active worktrees:"
    git worktree list
    exit 1
fi

# Find worktree path
WORKTREE_PATH=$(git worktree list | grep "$BRANCH_NAME" | awk '{print $1}')

if [ -z "$WORKTREE_PATH" ]; then
    echo -e "${RED}❌ Error: Worktree not found for branch: $BRANCH_NAME${NC}"
    echo ""
    echo "Active worktrees:"
    git worktree list
    exit 1
fi

echo -e "${BLUE}🧹 Cleaning up worktree for: $BRANCH_NAME${NC}"
echo -e "${BLUE}Path: $WORKTREE_PATH${NC}"
echo ""

# Check if PR is merged
PR_STATUS=$(gh pr list --head "$BRANCH_NAME" --state merged --json number,state --jq '.[0].state' 2>/dev/null || echo "")

if [ "$PR_STATUS" != "MERGED" ]; then
    echo -e "${YELLOW}⚠️  Warning: PR for this branch is not merged${NC}"
    read -p "Are you sure you want to delete this worktree? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}Cancelled.${NC}"
        exit 0
    fi
fi

# Clean up any exec-agent sub-worktrees first (from parallel isolation)
EXEC_AGENTS_DIR="$WORKTREE_PATH/.exec-agents"
if [ -d "$EXEC_AGENTS_DIR" ]; then
    echo -e "${BLUE}🧹 Cleaning up exec-agent sub-worktrees...${NC}"
    for agent_dir in "$EXEC_AGENTS_DIR"/agent-*; do
        if [ -d "$agent_dir" ]; then
            echo -e "${BLUE}   Removing: $(basename "$agent_dir")${NC}"
            git worktree remove "$agent_dir" --force 2>/dev/null || true
        fi
    done
    # Clean up orphaned exec-agent branches
    git branch --list 'exec-agent-*' 2>/dev/null | while read -r branch; do
        branch=$(echo "$branch" | tr -d ' *')
        git branch -D "$branch" 2>/dev/null || true
    done
    rmdir "$EXEC_AGENTS_DIR" 2>/dev/null || true
fi

# Remove worktree
echo -e "${BLUE}📂 Removing worktree...${NC}"
git worktree remove "$WORKTREE_PATH" --force

# Delete local branch
echo -e "${BLUE}🌿 Deleting local branch...${NC}"
git branch -D "$BRANCH_NAME" 2>/dev/null || true

# Delete remote branch
echo -e "${BLUE}☁️  Deleting remote branch...${NC}"
git push origin --delete "$BRANCH_NAME" 2>/dev/null || true

# Update main
echo -e "${BLUE}📥 Updating main branch...${NC}"
git checkout main
git fetch origin main

# Handle divergent branches gracefully
if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    # Local is behind or diverged - fast-forward or rebase
    if git merge-base --is-ancestor origin/main HEAD 2>/dev/null; then
        # Local is ahead - nothing to do
        echo -e "${BLUE}   Local main is ahead of origin${NC}"
    else
        # Diverged or behind - try fast-forward first
        if ! git pull --ff-only origin main 2>/dev/null; then
            echo -e "${YELLOW}   Divergent branches detected, rebasing...${NC}"
            git rebase origin/main
        fi
    fi
else
    git pull --ff-only origin main 2>/dev/null || true
fi

echo ""
echo -e "${GREEN}✅ Cleanup complete!${NC}"
echo ""

# Reminder for new dependencies
echo -e "${YELLOW}💡 Tip: If new dependencies were added, run: npm install${NC}"
echo ""

echo -e "${BLUE}🗂️  Remaining worktrees:${NC}"
git worktree list
echo ""
