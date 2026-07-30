#!/bin/bash

# Clean up a worktree after PR is merged
# Usage: ./scripts/cleanup-worktree.sh [flags] <branch>
# <branch> accepts a bare issue number (`123`), a QUOTED glob
# (`'feature/123-*'`), or the full branch name — all resolve to the same
# worktree and, since #838, to the same underlying branch ref.
# A bare number is ANCHORED to the issue-number position (#844): `838` resolves
# `feature/838-*` and never `feature/1838-other-work`. When the argument matches
# more than one worktree branch the script lists every candidate and exits
# non-zero instead of silently deleting the first.
# Quote the glob: this script resolves the pattern itself, so it must arrive
# unexpanded. zsh (the default macOS shell) aborts on an unmatched unquoted
# glob before the script ever runs; bash would pass it through literally.
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

# Print CLI usage/help (kept in sync with the header comment above).
print_usage() {
    cat <<'USAGE'
Usage: ./scripts/cleanup-worktree.sh [flags] <branch>

<branch> may be any of (all resolve to the same worktree):
  838                    a bare issue number — anchored to the issue-number
                         position, so it never matches feature/1838-other-work
  'feature/838-*'        a glob — MUST be quoted (see below)
  feature/838-fix-thing  the full branch name

An argument that matches more than one worktree branch is rejected: the script
lists every candidate and exits non-zero rather than deleting the first.

Quote the glob form. This script resolves the pattern itself, so it must
arrive unexpanded; zsh aborts on an unmatched unquoted glob before the
script ever runs.

Clean up a feature worktree. The remote branch is deleted ONLY when the
branch's PR is MERGED (the documented post-merge contract) or when an
explicit override flag is passed. Local teardown (worktree + local branch)
always runs so the branch lock is freed for a subsequent
`gh pr merge --delete-branch`.

Flags:
  -y, --yes         Skip the confirmation prompt (non-interactive confirm).
                    Does NOT override the merge gate on remote deletion.
  --delete-remote   Override the merge gate and delete the remote branch even
                    when the PR is not merged (still honors the confirm gate).
  --force           Implies both --yes and --delete-remote.
  -h, --help        Show this help and exit.

Example:
  ./scripts/cleanup-worktree.sh feature/123-add-user-dashboard
USAGE
}

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
        -h|--help)
            print_usage
            exit 0
            ;;
        -*)
            echo -e "${RED}❌ Error: Unknown flag: $1${NC}" >&2
            print_usage >&2
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
    echo -e "${RED}❌ Error: Branch name required${NC}" >&2
    print_usage >&2
    echo "" >&2
    echo "Active worktrees:" >&2
    git worktree list >&2
    exit 1
fi

# Resolve $BRANCH_NAME to exactly one worktree AND its full branch ref. Both are
# captured because every downstream consumer (`gh pr list --head`, `git branch
# -D`, `git push origin --delete`) needs the EXACT ref, or it silently no-ops on
# a shorthand and the script prints "Cleanup complete!" while leaving the branch
# behind (the #838 defect $RESOLVED_BRANCH closes).
#
# Matching is TIERED and anchored (#844). The old matcher was a single
# unanchored substring test with first-match-wins and no ambiguity check:
#
#     case "$_wt_branch" in *"$BRANCH_NAME"* | $BRANCH_NAME)
#
# so `838` matched `feature/1838-other-work`, and whichever worktree porcelain
# emitted first was torn down — local AND remote, since #838. Porcelain sorts
# linked worktrees lexicographically by basename (`1838- < 838-`), so the
# mis-resolution was deterministic, not a race. The tiers below anchor bare
# numbers to the issue-number position and make any 2+-way match fatal.
#
# Tiers (first tier with any match decides; 2+ matches in a tier is fatal):
#   1. exact    — branch == argument. Guards coexisting feature/838-fix and
#                 feature/838-fix-more (both legal via new-feature.sh's title
#                 truncation): the full name must resolve, not trip ambiguity.
#   2. anchored — branch's last path segment == argument; plus, when the
#                 argument is all digits, the sequant issue-number branch shapes
#                 parseIssueNumberFromBranch (worktree-discovery.ts) recognizes:
#                 feature/<N>-*, feature/<N>, issue-<N>, <N>-*.
#   3. glob     — only when the argument itself contains * ? or [ : a plain
#                 `case` glob over the branch ref. Keeps the documented, quoted
#                 `feature/<issue>-*` form working, now behind the ambiguity gate.
#
# bash 3.2 (macOS floor): no arrays/mapfile. Candidates live in a
# newline-delimited string of "<path>\t<branch>"; each tier re-scans it via
# process substitution (which keeps loop-set counters in the current shell — a
# pipe would lose them to a subshell). `while IFS= read -r` preserves whitespace
# in paths (the #575 hardening).
_TAB=$(printf '\t')

# Collect candidate worktrees: porcelain stanzas carrying a branch ref, minus
# the main worktree (first entry — without this, `'*'`/`'feature/*'` could
# resolve to and `git worktree remove` it) and minus the `exec-agent-*`
# sub-worktree branches parallel isolation leaves behind (real porcelain
# candidates, per this script's own reaping below).
CANDIDATES=""
_wt_path=""
while IFS= read -r _line; do
    case "$_line" in
        "worktree "*)
            _wt_path="${_line#worktree }"
            ;;
        "branch refs/heads/"*)
            _wt_branch="${_line#branch refs/heads/}"
            if [ "$_wt_path" = "$MAIN_WORKTREE" ]; then
                continue
            fi
            case "$_wt_branch" in
                exec-agent-*) continue ;;
            esac
            CANDIDATES="${CANDIDATES}${_wt_path}${_TAB}${_wt_branch}
"
            ;;
    esac
done < <(git worktree list --porcelain)

# Classify the argument once: a bare issue number (all digits) enables the
# anchored issue-number shapes; a glob metacharacter enables the glob tier.
_is_number=false
case "$BRANCH_NAME" in
    ''|*[!0-9]*) ;;
    *) _is_number=true ;;
esac
_is_glob=false
case "$BRANCH_NAME" in
    *[*?[]*) _is_glob=true ;;
esac

# Test one branch ref ($2) against one tier ($1); returns 0 on match. Called
# only as an `if` condition, so a non-zero return never trips `set -e`.
_branch_matches() {
    case "$1" in
        exact)
            [ "$2" = "$BRANCH_NAME" ]
            ;;
        anchored)
            # Last path segment equals the argument (covers `838-spaced`).
            if [ "${2##*/}" = "$BRANCH_NAME" ]; then
                return 0
            fi
            # All-digit argument: the sequant issue-number branch shapes.
            if [ "$_is_number" = true ]; then
                case "$2" in
                    feature/"$BRANCH_NAME"-* | feature/"$BRANCH_NAME" \
                        | issue-"$BRANCH_NAME" | "$BRANCH_NAME"-*)
                        return 0
                        ;;
                esac
            fi
            return 1
            ;;
        glob)
            case "$2" in
                $BRANCH_NAME) return 0 ;;
            esac
            return 1
            ;;
    esac
}

# Walk the tiers in order; the first tier with any match decides. A tier with
# 2+ matches is fatal (AC-2/AC-3): list every candidate and exit non-zero
# rather than silently deleting the first.
WORKTREE_PATH=""
RESOLVED_BRANCH=""
for _tier in exact anchored glob; do
    # The glob tier only participates when the argument is itself a glob.
    if [ "$_tier" = glob ] && [ "$_is_glob" != true ]; then
        continue
    fi

    _match_count=0
    _match_list=""
    while IFS="$_TAB" read -r _cand_path _cand_branch; do
        [ -n "$_cand_branch" ] || continue
        if _branch_matches "$_tier" "$_cand_branch"; then
            _match_count=$((_match_count + 1))
            if [ "$_match_count" -eq 1 ]; then
                WORKTREE_PATH="$_cand_path"
                RESOLVED_BRANCH="$_cand_branch"
            fi
            _match_list="${_match_list}  ${_cand_branch}${_TAB}${_cand_path}
"
        fi
    done < <(printf '%s' "$CANDIDATES")

    if [ "$_match_count" -gt 1 ]; then
        echo -e "${RED}❌ Error: '$BRANCH_NAME' is ambiguous — it matches ${_match_count} worktree branches:${NC}" >&2
        printf '%s' "$_match_list" >&2
        echo -e "${RED}Refusing to guess. Re-run with the full branch name to disambiguate.${NC}" >&2
        exit 1
    fi

    if [ "$_match_count" -eq 1 ]; then
        break
    fi
done

if [ -z "$WORKTREE_PATH" ]; then
    echo -e "${RED}❌ Error: Worktree not found for branch: $BRANCH_NAME${NC}"
    echo ""
    echo "Active worktrees:"
    git worktree list
    exit 1
fi

echo -e "${BLUE}🧹 Cleaning up worktree for: $RESOLVED_BRANCH${NC}"
echo -e "${BLUE}Path: $WORKTREE_PATH${NC}"
echo ""

# Check if PR is merged. Queries the RESOLVED ref (#838): `--head` is an exact
# match, so passing the caller's shorthand here reported "not merged" for every
# invocation form except a full literal branch name — including the
# `feature/<issue>-*` form the skills and docs prescribe. A warning that always
# fires carries no signal and makes --yes/--force the mandatory incantation,
# which re-arms the very bypass reflex #750 removed.
PR_STATUS=$(gh pr list --head "$RESOLVED_BRANCH" --state merged --json number,state --jq '.[0].state' 2>/dev/null || echo "")

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

# Delete local branch. Uses the RESOLVED ref (#838) — `git branch -D 817` finds
# no such branch and, being `|| true`-suppressed, failed silently: the script
# reported "Cleanup complete!" while leaving the branch behind.
echo -e "${BLUE}🌿 Deleting local branch...${NC}"
git branch -D "$RESOLVED_BRANCH" 2>/dev/null || true

# Delete remote branch — hard-gated on merge state. Only delete when the PR is
# MERGED or an explicit override flag (--delete-remote/--force) was passed.
# Otherwise leave the remote branch (and any open PR) intact: deleting an open
# PR's head branch makes GitHub close the PR unmerged, stranding the work.
if [ "$PR_STATUS" = "MERGED" ] || [ "$DELETE_REMOTE" = true ]; then
    echo -e "${BLUE}☁️  Deleting remote branch...${NC}"
    # Resolved ref (#838): same silent-no-op class as the local delete above.
    git push origin --delete "$RESOLVED_BRANCH" 2>/dev/null || true
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
