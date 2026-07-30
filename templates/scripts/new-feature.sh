#!/bin/bash

# Create a new feature worktree from a GitHub issue
# Usage: ./scripts/new-feature.sh <issue-number> [--base <branch>] [--stash]
# Example: ./scripts/new-feature.sh 4
# Example: ./scripts/new-feature.sh 4 --stash  # Auto-stash uncommitted changes
# Example: ./scripts/new-feature.sh 4 --base feature/dashboard  # Branch from feature branch

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments (flexible position for flags)
STASH_FLAG=false
ISSUE_NUMBER=""
BASE_BRANCH="main"

while [[ $# -gt 0 ]]; do
    case $1 in
        --stash)
            STASH_FLAG=true
            shift
            ;;
        --base)
            BASE_BRANCH="$2"
            shift 2
            ;;
        *)
            # First non-flag argument is the issue number
            if [ -z "$ISSUE_NUMBER" ]; then
                ISSUE_NUMBER=$1
            fi
            shift
            ;;
    esac
done

# Check if issue number is provided
if [ -z "$ISSUE_NUMBER" ]; then
    echo -e "${RED}❌ Error: Issue number required${NC}"
    echo "Usage: ./scripts/new-feature.sh <issue-number> [--base <branch>] [--stash]"
    echo "Example: ./scripts/new-feature.sh 4"
    echo "Example: ./scripts/new-feature.sh 4 --stash"
    echo "Example: ./scripts/new-feature.sh 4 --base feature/dashboard"
    exit 1
fi

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
echo -e "${BLUE}Base: ${BASE_BRANCH}${NC}"
echo -e "${BLUE}Worktree: ${WORKTREE_DIR}${NC}"
echo ""

# Check for uncommitted changes before switching branches
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
    if [ "$STASH_FLAG" = true ]; then
        echo -e "${YELLOW}📦 Stashing uncommitted changes...${NC}"
        git stash push --include-untracked -m "WIP before issue #${ISSUE_NUMBER}"
        echo -e "${GREEN}   Changes stashed successfully${NC}"
    else
        echo -e "${RED}❌ Working tree has uncommitted changes${NC}"
        echo -e "${YELLOW}   Use --stash to auto-stash, or manually:${NC}"
        echo -e "   git stash push -m 'WIP before issue #${ISSUE_NUMBER}'"
        exit 1
    fi
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

# Update base branch
echo -e "${BLUE}📥 Updating ${BASE_BRANCH} branch...${NC}"
git fetch origin "$BASE_BRANCH"
git checkout "$BASE_BRANCH"
git pull origin "$BASE_BRANCH"

# Create worktree from base branch
echo -e "${BLUE}🌿 Creating new worktree from ${BASE_BRANCH}...${NC}"
git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME"

# Record the base branch on the new branch so downstream tooling
# (e.g. phase-executor zero-diff guard, see #537) can resolve the
# correct comparison ref when the worktree was branched off something
# other than origin/main.
git -C "$WORKTREE_DIR" config "branch.${BRANCH_NAME}.sequantBase" "$BASE_BRANCH"

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

# Package-manager resolution for the frozen install below (#847).
#
# SOURCE OF TRUTH: src/lib/stacks.ts. The lockfile priority here MUST match
# LOCKFILE_PRIORITY (bun.lockb → bun.lock → yarn.lock → pnpm-lock.yaml →
# package-lock.json, npm fallback), and each frozen command MUST match the
# corresponding PM_CONFIG[pm].ciInstall verbatim. A vitest drift-guard
# (__tests__/new-feature-frozen-install.integration.test.ts) asserts every
# ciInstall string appears in pm_ci_install() and every PM_CONFIG[pm].run
# string in pm_run(), converting drift from silent to failing.
#
# Detection is lockfile-existence only — it never reads package.json's
# `packageManager` field — exactly like detectPackageManagerSync, so
# multi-lockfile conflict behavior matches the TS path by construction.
# Runs in the directory being provisioned (the worktree cwd).
detect_package_manager() {
    if [ -f "bun.lockb" ] || [ -f "bun.lock" ]; then
        echo "bun"
    elif [ -f "yarn.lock" ]; then
        echo "yarn"
    elif [ -f "pnpm-lock.yaml" ]; then
        echo "pnpm"
    else
        # package-lock.json OR no lockfile → npm (matches the TS fallback).
        echo "npm"
    fi
}

# Frozen (lockfile-faithful) install command per PM — mirrors PM_CONFIG.ciInstall.
pm_ci_install() {
    case "$1" in
        bun)  echo "bun install --frozen-lockfile" ;;
        yarn) echo "yarn install --immutable" ;;
        pnpm) echo "pnpm install --frozen-lockfile" ;;
        *)    echo "npm ci" ;;
    esac
}

# Expected lockfile name for the detected PM (drives the AC-3 failure message).
pm_lockfile() {
    case "$1" in
        # A bun project may commit either lockfile; name the one present.
        bun)  if [ -f "bun.lock" ] && [ ! -f "bun.lockb" ]; then echo "bun.lock"; else echo "bun.lockb"; fi ;;
        yarn) echo "yarn.lock" ;;
        pnpm) echo "pnpm-lock.yaml" ;;
        *)    echo "package-lock.json" ;;
    esac
}

# Quiet flag for the frozen install, appended at the CALL SITE rather than
# folded into pm_ci_install so the drift guard keeps matching PM_CONFIG's
# ciInstall verbatim. Only npm gets one: `npm ci --silent` is what this script
# ran before #847, and dropping it made every npm provisioning noisier than it
# used to be. The others are left alone deliberately — `yarn install` has no
# equivalent, and pnpm/bun's silencing flags are untested here, so inventing
# them would trade a cosmetic regression for a real one.
pm_quiet_flag() {
    case "$1" in
        npm) echo "--silent" ;;
        *)   echo "" ;;
    esac
}

# Run-script prefix per PM — mirrors PM_CONFIG.run (npm/pnpm/bun take `run`,
# yarn does not). Drives the next-steps hint, which hardcoded `npm run dev`
# even on a pnpm project until #847's follow-up pass.
pm_run() {
    case "$1" in
        bun)  echo "bun run" ;;
        yarn) echo "yarn" ;;
        pnpm) echo "pnpm run" ;;
        *)    echo "npm run" ;;
    esac
}

# PM-appropriate recovery command when the lockfile is out of sync (AC-3).
pm_recovery() {
    case "$1" in
        # Defer to pm_lockfile rather than repeating a name: a bun.lock project
        # was told to `git commit bun.lockb`, a file it does not have — the
        # same wrong-file misdirection AC-3 exists to eliminate.
        bun)  echo "bun install && git commit $(pm_lockfile bun)" ;;
        yarn) echo "yarn install && git commit yarn.lock" ;;
        pnpm) echo "pnpm install --lockfile-only && git commit pnpm-lock.yaml" ;;
        *)    echo "npm install --package-lock-only && git commit package-lock.json" ;;
    esac
}

# Frozen install (#826). `npm install` (and every PM's default install)
# normalizes and REWRITES the lockfile whenever the local tool disagrees with
# the one that committed it — observed: npm 10 stripping the `libc` fields a
# newer npm wrote via dependabot. Every freshly provisioned worktree then
# started with an unstaged lockfile, and that one dirty file cascades:
# `rebaseBeforePR` refuses to run so the #295 stale-base guard silently never
# fires, `checkWorktreeFreshness` counts it as uncommitted work so stale
# worktrees are never recreated, and chain checkpoints skip on an "unrelated
# dirty file" — breaking chain resume (#760) on every link.
#
# The frozen mode (`npm ci`, `pnpm install --frozen-lockfile`, …) never
# rewrites the lockfile. #816 made this substitution for the TypeScript
# provisioning path but hardcoded npm here; #847 resolves the command from the
# project's detected package manager so pnpm/yarn/bun projects no longer run
# `npm ci` against a non-npm lockfile and fail naming a file they don't use.
#
# The enclosing `[ ! -d node_modules ]` guard means this only ever runs against
# an absent node_modules, which is exactly the frozen install's precondition.
frozen_install() {
    local pm ci_cmd lockfile recovery quiet
    pm="$(detect_package_manager)"
    ci_cmd="$(pm_ci_install "$pm")"
    lockfile="$(pm_lockfile "$pm")"
    recovery="$(pm_recovery "$pm")"
    quiet="$(pm_quiet_flag "$pm")"

    echo -e "${BLUE}   Package manager: ${pm} (${ci_cmd})${NC}"
    # Unquoted on purpose: split the resolved command into words. The values
    # are fixed literals from the tables above, not user input. `quiet` is
    # empty for every PM but npm, where it expands to nothing.
    if ! $ci_cmd $quiet; then
        echo -e "${RED}❌ Dependency install failed (${ci_cmd}).${NC}" >&2
        # Distinguish "no lockfile at all" from "lockfile out of sync" (#847):
        # a manifest-only project falls back to npm and `npm ci` fails because
        # it REQUIRES a lockfile — telling that user their "committed
        # package-lock.json is out of sync" describes a file they don't have.
        # The recovery command is the same either way: it generates the
        # lockfile if absent and re-syncs it if present.
        if [ ! -f "$lockfile" ]; then
            echo -e "${YELLOW}   No ${lockfile} found — ${ci_cmd} requires a committed lockfile.${NC}" >&2
        else
            echo -e "${YELLOW}   The committed ${lockfile} is out of sync with package.json.${NC}" >&2
        fi
        echo -e "${YELLOW}   Fix in the main repo, then re-run:${NC}" >&2
        echo -e "${YELLOW}     ${recovery}${NC}" >&2
        echo -e "${YELLOW}   Worktree left in place at: $(pwd)${NC}" >&2
        # Explicit exit rather than relying on `set -e` so the cause is named:
        # a bare abort here leaves a half-provisioned worktree with no
        # explanation of why (AC-4).
        exit 1
    fi
}

# Install dependencies if needed.
# Gate on package.json too (#847): a non-JS project has no lockfile and no
# manifest, so it would otherwise fall through to `npm ci` and fail. Skip it.
if [ ! -d "node_modules" ] && [ -f "package.json" ]; then
    # Check for install cache optimization (opt-in via SEQUANT_NPM_CACHE=true)
    if [ "${SEQUANT_NPM_CACHE:-false}" = "true" ]; then
        # Anchored to the main repo, not the cwd: execution is inside the new
        # worktree by this point, so the old relative path resolved to
        # `worktrees/feature/worktrees/.npm-cache` — a level deeper than the
        # `../worktrees/` the worktrees themselves live in.
        CACHE_DIR="${MAIN_REPO_DIR}/../worktrees/.npm-cache"
        # Named for the resolved lockfile, not package-lock.json specifically,
        # and keyed by project (#847): `../worktrees/` is shared by every repo
        # in the same parent directory, so a single hash file made two projects
        # alternate cache misses as each overwrote the other's hash. A stale
        # hash can only cost a redundant install, never a wrong copy — the hit
        # path copies this project's own node_modules — but the thrash defeats
        # the cache. Renaming invalidates any existing cache once, which costs
        # one extra install and then self-heals.
        HASH_FILE="${CACHE_DIR}/.lockfile-hash-$(basename "$MAIN_REPO_DIR")"

        # Hash the RESOLVED lockfile, not a hardcoded package-lock.json (#847).
        # On a pnpm/yarn/bun project the old code hashed a missing file: macOS
        # `md5 -q` aborts under `set -e`, and Linux `md5sum | cut` masks the
        # failure and caches an empty hash. Guarding on the resolved lockfile's
        # existence avoids invoking the hasher on an absent path entirely.
        CACHE_PM="$(detect_package_manager)"
        CACHE_LOCKFILE="$(pm_lockfile "$CACHE_PM")"
        LOCK_PATH="${MAIN_REPO_DIR}/${CACHE_LOCKFILE}"

        # Calculate current lockfile hash (cross-platform)
        if [ ! -f "$LOCK_PATH" ]; then
            CURRENT_HASH=""
        elif command -v md5sum &> /dev/null; then
            CURRENT_HASH=$(md5sum "$LOCK_PATH" | cut -d' ' -f1)
        elif command -v md5 &> /dev/null; then
            CURRENT_HASH=$(md5 -q "$LOCK_PATH")
        else
            CURRENT_HASH=""
        fi

        # Check if cache is valid
        if [ -n "$CURRENT_HASH" ] && [ -f "$HASH_FILE" ] && [ -d "${MAIN_REPO_DIR}/node_modules" ]; then
            CACHED_HASH=$(cat "$HASH_FILE" 2>/dev/null || echo "")
            if [ "$CURRENT_HASH" = "$CACHED_HASH" ]; then
                echo -e "${GREEN}⚡ Using cached node_modules (lockfile unchanged)${NC}"
                # `-R`, not `-r` (#847). Making this branch reachable for
                # pnpm/yarn/bun exposed a difference the npm-only past hid:
                # BSD `cp -r` DEREFERENCES symlinks, so a pnpm node_modules —
                # a farm of relative links into `.pnpm/` — is expanded into
                # full real copies, and any dangling link (an optional dep, a
                # `.bin` entry for another platform) makes cp exit non-zero,
                # which `set -e` turns into a half-provisioned worktree.
                # `cp -R` preserves symlinks on both BSD and GNU; the links
                # are relative, so they still resolve inside the copy. It is
                # also more faithful for npm, whose `.bin/` entries are links.
                cp -R "${MAIN_REPO_DIR}/node_modules" ./node_modules
            else
                echo -e "${BLUE}📦 Installing dependencies (lockfile changed)...${NC}"
                frozen_install
                # Update cache hash
                mkdir -p "$CACHE_DIR"
                echo "$CURRENT_HASH" > "$HASH_FILE"
            fi
        else
            echo -e "${BLUE}📦 Installing dependencies (initializing cache)...${NC}"
            frozen_install
            # Initialize cache hash
            if [ -n "$CURRENT_HASH" ]; then
                mkdir -p "$CACHE_DIR"
                echo "$CURRENT_HASH" > "$HASH_FILE"
            fi
        fi
    else
        echo -e "${BLUE}📦 Installing dependencies...${NC}"
        frozen_install
    fi
fi

echo ""
echo -e "${GREEN}✅ Worktree created successfully!${NC}"
echo ""
echo -e "${YELLOW}📍 Next steps:${NC}"
echo -e "  1. cd ${WORKTREE_DIR}"
echo -e "  2. $(pm_run "$(detect_package_manager)") dev"
echo -e "  3. Work on issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}"
echo -e "  4. git add . && git commit -m \"Your message\""
echo -e "  5. git push -u origin ${BRANCH_NAME}"
echo -e "  6. ./scripts/create-pr.sh ${ISSUE_NUMBER}"
echo ""
echo -e "${BLUE}🗂️  Active worktrees:${NC}"
git worktree list
echo ""
