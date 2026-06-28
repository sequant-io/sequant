#!/bin/bash

# Clean up a worktree after PR is merged
# Usage: ./scripts/cleanup-worktree.sh [flags] <branch-name>
# Example: ./scripts/cleanup-worktree.sh feature/123-add-user-dashboard
#
# The remote branch is deleted ONLY when the branch's PR is MERGED (the
# documented post-merge contract) or when an explicit override flag is passed.
# Local teardown (worktree + local branch) always runs so the branch lock is
# freed for a subsequent `gh pr merge --delete-branch`.
#
# Flags:
#   -y, --yes         Skip the confirmation prompt (non-interactive confirm).
#                     Does NOT override the merge gate on remote deletion.
#   --delete-remote   Override the merge gate and delete the remote branch even
#                     when the PR is not merged (still honors the TTY confirm).
#   --force           Implies both --yes and --delete-remote.

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Parse flags. ASSUME_YES bypasses the confirmation prompt; DELETE_REMOTE
# overrides the merge gate on remote deletion. The first non-flag argument is
# the branch name. --force is the combined opt-in (both behaviors).
BRANCH_NAME=""
ASSUME_YES=false
DELETE_REMOTE=false
while [ $# -gt 0 ]; do
    case "$1" in
        -y|--yes)
            ASSUME_YES=true
            ;;
        --delete-remote)
            DELETE_REMOTE=true
            ;;
        --force)
            ASSUME_YES=true
            DELETE_REMOTE=true
            ;;
        -*)
            echo -e "${RED}❌ Error: Unknown flag: $1${NC}"
            echo "Usage: ./scripts/cleanup-worktree.sh [-y|--yes] [--delete-remote] [--force] <branch-name>"
            exit 1
            ;;
        *)
            if [ -z "$BRANCH_NAME" ]; then
                BRANCH_NAME="$1"
            fi
            ;;
    esac
    shift
done

# Resolve main worktree (first entry in porcelain output) so subsequent git
# commands run from a stable cwd even if the caller invoked us from inside the
# worktree we are about to delete. `sed` keeps the path intact when it contains
# whitespace; `awk '{print $2}'` would truncate at the first space.
MAIN_WORKTREE=$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -n 1)

# Check if branch name provided
if [ -z "$BRANCH_NAME" ]; then
    echo -e "${RED}❌ Error: Branch name required${NC}"
    echo "Usage: ./scripts/cleanup-worktree.sh <branch-name>"
    echo ""
    echo "Active worktrees:"
    git worktree list
    exit 1
fi

# Find worktree path. Parse porcelain (which separates path/branch onto distinct
# lines) so paths containing whitespace survive intact, and so we match against
# the branch ref rather than against a free-form `grep` over the entire line —
# the latter false-matches whenever the branch name appears in the path string.
WORKTREE_PATH=$(git worktree list --porcelain | awk -v target="$BRANCH_NAME" '
  /^worktree / { sub(/^worktree /, ""); path = $0 }
  /^branch refs\/heads\// {
    sub(/^branch refs\/heads\//, "")
    if (index($0, target) > 0) { print path; exit }
  }
')

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

# Confirmation gate — only reached when the PR is NOT merged. When MERGED we
# short-circuit past this entirely (no prompt, no TTY check) so the documented
# post-merge happy path is unchanged.
if [ "$PR_STATUS" != "MERGED" ]; then
    echo -e "${YELLOW}⚠️  Warning: PR for this branch is not merged${NC}"
    if [ "$ASSUME_YES" = true ]; then
        echo -e "${BLUE}Proceeding (--yes/--force).${NC}"
    elif [ -t 0 ]; then
        read -p "Are you sure you want to delete this worktree? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${BLUE}Cancelled.${NC}"
            exit 0
        fi
    else
        # Non-interactive (no TTY) and no confirm flag: exit safely instead of
        # stalling on `read`. Pass --yes/--force to proceed without a prompt.
        echo -e "${BLUE}Non-interactive context and PR not merged — pass --yes or --force to proceed. Exiting without changes.${NC}"
        exit 0
    fi
fi

# Move to the main worktree before any destructive operation. If the caller's
# cwd is inside $WORKTREE_PATH (or any of its .exec-agents/agent-* sub-worktrees
# below), the first `git worktree remove` would invalidate cwd and every
# subsequent git/gh call would silently fail with "Unable to read current
# working directory" — including the ones with `2>/dev/null || true`.
cd "$MAIN_WORKTREE"

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

# Remove worktree (cwd already pinned to $MAIN_WORKTREE above)
echo -e "${BLUE}📂 Removing worktree...${NC}"
git worktree remove "$WORKTREE_PATH" --force

# Delete local branch
echo -e "${BLUE}🌿 Deleting local branch...${NC}"
git branch -D "$BRANCH_NAME" 2>/dev/null || true

# Delete remote branch — hard-gated on merge state. Only delete when the PR is
# MERGED or an explicit override flag (--delete-remote/--force) was passed.
# Otherwise leave the remote branch (and any open PR) intact: deleting an open
# PR's head branch makes GitHub close the PR unmerged, stranding the work.
if [ "$PR_STATUS" = "MERGED" ] || [ "$DELETE_REMOTE" = true ]; then
    echo -e "${BLUE}☁️  Deleting remote branch...${NC}"
    git push origin --delete "$BRANCH_NAME" 2>/dev/null || true
else
    echo -e "${YELLOW}⏭️  Skipped remote-branch delete (PR not merged; pass --delete-remote or --force to override).${NC}"
fi

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
