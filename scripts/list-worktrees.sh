#!/bin/bash

# List all active worktrees with their status
# Usage: ./scripts/list-worktrees.sh

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}🗂️  Active Worktrees${NC}"
echo ""

# Get worktree list
WORKTREES=$(git worktree list --porcelain)

# Parse and display
echo "$WORKTREES" | awk '
BEGIN {
    path = ""
    branch = ""
    commit = ""
}
/^worktree / {
    if (path != "") {
        printf "📁 \033[0;32m%s\033[0m\n", path
        printf "   Branch: \033[0;34m%s\033[0m\n", branch
        printf "   Commit: %s\n\n", substr(commit, 1, 7)
    }
    path = substr($0, 10)
}
/^branch / {
    branch = substr($0, index($0, "refs/heads/") + 11)
}
/^HEAD / {
    commit = substr($0, 6)
}
END {
    if (path != "") {
        printf "📁 \033[0;32m%s\033[0m\n", path
        printf "   Branch: \033[0;34m%s\033[0m\n", branch
        printf "   Commit: %s\n\n", substr(commit, 1, 7)
    }
}'

# Count
WORKTREE_COUNT=$(git worktree list | wc -l | xargs)
echo -e "${YELLOW}Total: $WORKTREE_COUNT worktree(s)${NC}"
echo ""
