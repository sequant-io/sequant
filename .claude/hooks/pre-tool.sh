#!/bin/bash
# Pre-tool hook for Claude Code
# - Security guardrails (blocks catastrophic commands)
# - Timing instrumentation for performance analysis
# Exit 0 = allow, Exit 2 = block (Exit 1 = non-blocking error, logged but not blocked)

# === ROLLBACK MECHANISM ===
# Set CLAUDE_HOOKS_DISABLED=true to bypass all hook logic
if [[ "${CLAUDE_HOOKS_DISABLED:-}" == "true" ]]; then
    exit 0
fi

# === READ INPUT FROM STDIN ===
# Claude Code passes tool data as JSON via stdin, not environment variables
INPUT_JSON=$(cat)

# Parse JSON using jq (preferred) or fallback to grep
if command -v jq &>/dev/null; then
    TOOL_NAME=$(echo "$INPUT_JSON" | jq -r '.tool_name // empty')
    # For Bash tool, extract .command from tool_input; for others, stringify the whole object
    if [[ "$(echo "$INPUT_JSON" | jq -r '.tool_name // empty')" == "Bash" ]]; then
        TOOL_INPUT=$(echo "$INPUT_JSON" | jq -r '.tool_input.command // empty')
    else
        TOOL_INPUT=$(echo "$INPUT_JSON" | jq -r '.tool_input | tostring // empty')
    fi
else
    TOOL_NAME=$(echo "$INPUT_JSON" | grep -oE '"tool_name"\s*:\s*"[^"]+"' | head -1 | cut -d'"' -f4)
    # For Bash tool, extract command from tool_input; for others, extract the whole object
    if [[ "$TOOL_NAME" == "Bash" ]]; then
        TOOL_INPUT=$(echo "$INPUT_JSON" | grep -oE '"command"\s*:\s*"[^"]+"' | head -1 | cut -d'"' -f4)
    else
        TOOL_INPUT=$(echo "$INPUT_JSON" | grep -oE '"tool_input"\s*:\s*\{[^}]+\}' | head -1)
    fi
fi

TIMING_LOG="/tmp/claude-timing.log"
PARALLEL_MARKER_PREFIX="/tmp/claude-parallel-"

# === AGENT ID DETECTION ===
# For parallel agents, detect group ID from marker files
# Format: /tmp/claude-parallel-<group-id>.marker
AGENT_ID=""
for marker in "${PARALLEL_MARKER_PREFIX}"*.marker; do
    if [[ -f "$marker" ]]; then
        # Extract group ID from marker filename
        AGENT_ID=$(basename "$marker" | sed 's/claude-parallel-//' | sed 's/\.marker//')
        break
    fi
done

# === TIMING START ===
# Include agent ID in log format if available (AC-4)
if [[ -n "$AGENT_ID" ]]; then
    echo "$(date +%s.%N) [$AGENT_ID] START $TOOL_NAME" >> "$TIMING_LOG"
else
    echo "$(date +%s.%N) START $TOOL_NAME" >> "$TIMING_LOG"
fi

# === LOG ROTATION ===
# Rotate if over 1000 lines to prevent unbounded growth
if [[ -f "$TIMING_LOG" ]]; then
    LINE_COUNT=$(wc -l < "$TIMING_LOG" 2>/dev/null || echo 0)
    if [[ "$LINE_COUNT" -gt 1000 ]]; then
        tail -500 "$TIMING_LOG" > "${TIMING_LOG}.tmp" && mv "${TIMING_LOG}.tmp" "$TIMING_LOG"
    fi
fi

# === CATASTROPHIC BLOCKS ===
# These should NEVER run in any automated context

# Secrets/credentials
# Skip check for gh commands (comment/pr bodies may contain example text)
if ! echo "$TOOL_INPUT" | grep -qE '^gh (issue|pr) '; then
    # Pattern requires command to START with file reader (not match in quoted strings)
    if echo "$TOOL_INPUT" | grep -qE '^(cat|less|head|tail|more) .*\.(env|pem|key)'; then
        echo "HOOK_BLOCKED: Reading secret file" | tee -a /tmp/claude-hook.log >&2
        exit 2
    fi

    if echo "$TOOL_INPUT" | grep -qE '^(cat|less) .*~/\.(ssh|aws|gnupg|config/gh)'; then
        echo "HOOK_BLOCKED: Reading credential directory" | tee -a /tmp/claude-hook.log >&2
        exit 2
    fi
fi

# Bare environment dump
if echo "$TOOL_INPUT" | grep -qE '^(env|printenv|export)$'; then
    echo "HOOK_BLOCKED: Environment dump" | tee -a /tmp/claude-hook.log >&2
    exit 2
fi

# Destructive system commands
if echo "$TOOL_INPUT" | grep -qE 'sudo|rm -rf /|rm -rf ~|rm -rf \$HOME'; then
    echo "HOOK_BLOCKED: Destructive system command" | tee -a /tmp/claude-hook.log >&2
    exit 2
fi

# Deployment (should never happen in issue automation)
if echo "$TOOL_INPUT" | grep -qE 'vercel (deploy|--prod)|terraform (apply|destroy)|kubectl (apply|delete)'; then
    echo "HOOK_BLOCKED: Deployment command" | tee -a /tmp/claude-hook.log >&2
    exit 2
fi

# Force push
# Pattern requires -f to be a standalone flag (not part of branch name like -fix)
if echo "$TOOL_INPUT" | grep -qE 'git push.*(--force| -f($| ))'; then
    echo "HOOK_BLOCKED: Force push" | tee -a /tmp/claude-hook.log >&2
    exit 2
fi

# CI/CD triggers (automation shouldn't trigger more automation)
if echo "$TOOL_INPUT" | grep -qE 'gh workflow run'; then
    echo "HOOK_BLOCKED: Workflow trigger" | tee -a /tmp/claude-hook.log >&2
    exit 2
fi

# === SECURITY GUARDRAILS ===
# Granular disable: Set CLAUDE_HOOKS_SECURITY=false to bypass security checks only
# (separate from CLAUDE_HOOKS_DISABLED which bypasses ALL hooks)

# --- Secret Detection (AC-1 for Issue #492) ---
# Block commits containing hardcoded API keys, tokens, and secrets
check_secrets() {
    local content="$1"
    local patterns=(
        'sk-[a-zA-Z0-9]{32,}'                    # OpenAI API key
        'sk_live_[a-zA-Z0-9]{24,}'               # Stripe live key
        'AKIA[A-Z0-9]{16}'                       # AWS Access Key
        'ghp_[a-zA-Z0-9]{36}'                    # GitHub Personal Token
        'xoxb-[0-9]{10,}(-[a-zA-Z0-9]+)+'        # Slack Bot Token
        'AIza[a-zA-Z0-9_-]{35}'                  # Google API Key
    )

    for pattern in "${patterns[@]}"; do
        if echo "$content" | grep -qE "$pattern"; then
            return 0  # Found a secret
        fi
    done
    return 1  # No secrets found
}

# --- Sensitive File Detection (AC-2 for Issue #492) ---
# Block commits containing sensitive files
check_sensitive_files() {
    local files="$1"
    local patterns=(
        '\.env$'
        '\.env\.local$'
        '\.env\.production$'
        '\.env\.[^.]+$'           # Any .env.* file
        'credentials\.json$'
        '\.pem$'
        '\.key$'
        'id_rsa$'
        'id_ed25519$'
    )

    for pattern in "${patterns[@]}"; do
        if echo "$files" | grep -qE "$pattern"; then
            return 0  # Found sensitive file
        fi
    done
    return 1  # No sensitive files found
}

if [[ "${CLAUDE_HOOKS_SECURITY:-true}" != "false" ]]; then
    # Security checks for git commit
    if [[ "$TOOL_NAME" == "Bash" ]] && echo "$TOOL_INPUT" | grep -qE 'git commit'; then
        # Skip security checks if --no-verify is used
        if ! echo "$TOOL_INPUT" | grep -qE -- '--no-verify'; then
            # Check staged files for secrets
            STAGED_CONTENT=$(git diff --cached 2>/dev/null || true)
            if [[ -n "$STAGED_CONTENT" ]] && check_secrets "$STAGED_CONTENT"; then
                {
                    echo "HOOK_BLOCKED: Hardcoded secret detected in staged changes"
                    echo "  Use 'git commit --no-verify' to bypass if this is a false positive"
                } | tee -a /tmp/claude-hook.log >&2
                exit 2
            fi

            # Check for sensitive files in commit
            STAGED_FILES=$(git diff --cached --name-only 2>/dev/null || true)
            if [[ -n "$STAGED_FILES" ]] && check_sensitive_files "$STAGED_FILES"; then
                {
                    echo "HOOK_BLOCKED: Sensitive file in commit (${STAGED_FILES})"
                    echo "  Files like .env, *.pem, *.key should not be committed"
                    echo "  Use 'git commit --no-verify' to bypass if this is intentional"
                } | tee -a /tmp/claude-hook.log >&2
                exit 2
            fi
        fi
    fi
fi

# === QUALITY GUARDS (Phase 2) ===

# --- No-Changes Guard (AC-7) ---
# Block commits when there are no staged or unstaged changes (prevents empty commits)
# Skips for --amend since amending doesn't require new changes
if [[ "$TOOL_NAME" == "Bash" ]] && echo "$TOOL_INPUT" | grep -qE 'git commit'; then
    if ! echo "$TOOL_INPUT" | grep -qE -- '--amend|--allow-empty'; then
        # Extract target directory from cd command if present (for worktree commits)
        # Handles: "cd /path && git commit" or "cd /path; git commit"
        TARGET_DIR=""
        if echo "$TOOL_INPUT" | grep -qE '^cd [^;&|]+'; then
            TARGET_DIR=$(echo "$TOOL_INPUT" | grep -oE '^cd [^;&|]+' | head -1 | sed 's/^cd //' | tr -d ' ')
        fi

        # Check for changes in the target directory (or current if no cd)
        if [[ -n "$TARGET_DIR" && -d "$TARGET_DIR" ]]; then
            CHANGES=$(cd "$TARGET_DIR" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
        else
            CHANGES=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
        fi

        if [[ "$CHANGES" -eq 0 ]]; then
            echo "HOOK_BLOCKED: No changes to commit. Stage files with 'git add' first." | tee -a /tmp/claude-hook.log >&2
            exit 2
        fi
    fi
fi

# --- Worktree Validation (AC-8) ---
# Warn (but don't block) when committing outside a feature worktree
# This catches accidental commits to main repo during feature work
QUALITY_LOG="/tmp/claude-quality.log"
if [[ "$TOOL_NAME" == "Bash" ]] && echo "$TOOL_INPUT" | grep -qE 'git commit'; then
    CWD=$(pwd)
    if ! echo "$CWD" | grep -qE 'worktrees/feature/'; then
        echo "$(date +%H:%M:%S) WORKTREE_WARNING: Committing outside feature worktree ($CWD)" >> "$QUALITY_LOG"
        # Warning only - does not block
    fi
fi

# --- Commit Message Validation (AC-3) ---
# Enforce conventional commits format: type(scope): description
# Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf
if [[ "$TOOL_NAME" == "Bash" ]] && echo "$TOOL_INPUT" | grep -qE 'git commit'; then
    # Extract message from -m flag
    MSG=""

    # Try heredoc format first: -m "$(cat <<'EOF' ... EOF)"
    # This is the most common format in Claude Code git commits
    if echo "$TOOL_INPUT" | grep -qE "<<.*EOF"; then
        # Extract first line after heredoc marker
        MSG=$(echo "$TOOL_INPUT" | sed -n '/<<.*EOF/,/EOF/p' | sed '1d;$d' | head -1 | sed 's/^[[:space:]]*//')
    fi

    # Try -m "message" format (double quotes)
    if [[ -z "$MSG" ]] && echo "$TOOL_INPUT" | grep -qE '\-m\s+"'; then
        MSG=$(echo "$TOOL_INPUT" | awk -F'"' '{print $2}')
    fi

    # Try -m 'message' format (single quotes)
    if [[ -z "$MSG" ]] && echo "$TOOL_INPUT" | grep -qE "\-m\s+'"; then
        MSG=$(echo "$TOOL_INPUT" | awk -F"'" '{print $2}')
    fi

    # Validate if we found a message
    if [[ -n "$MSG" ]]; then
        # Conventional commits pattern: type(optional-scope): description
        # Also accepts ! for breaking changes: feat!: or feat(scope)!:
        PATTERN='^(feat|fix|docs|style|refactor|test|chore|ci|build|perf)(\([^)]+\))?(!)?\s*:'
        if ! echo "$MSG" | grep -qE "$PATTERN"; then
            {
                echo "HOOK_BLOCKED: Commit must follow conventional commits format"
                echo "  Expected: type(scope): description"
                echo "  Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf"
                echo "  Got: $MSG"
            } | tee -a /tmp/claude-hook.log >&2
            exit 2
        fi
    fi
fi

# === WORKTREE PATH ENFORCEMENT ===
# Enforces that file operations stay within the designated worktree
# Sources for worktree path (in priority order):
#   1. SEQUANT_WORKTREE env var - set by `sequant run` for isolated issue execution
#   2. Parallel marker file - for parallel agent execution
# This prevents agents from accidentally editing the main repo instead of the worktree
if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
    EXPECTED_WORKTREE=""

    # Priority 1: Check SEQUANT_WORKTREE environment variable (set by sequant run)
    if [[ -n "${SEQUANT_WORKTREE:-}" ]]; then
        EXPECTED_WORKTREE="$SEQUANT_WORKTREE"
    fi

    # Priority 2: Fall back to parallel marker file
    if [[ -z "$EXPECTED_WORKTREE" ]]; then
        for marker in "${PARALLEL_MARKER_PREFIX}"*.marker; do
            if [[ -f "$marker" ]]; then
                # Read expected worktree path from marker file (first line)
                EXPECTED_WORKTREE=$(head -1 "$marker" 2>/dev/null || true)
                break
            fi
        done
    fi

    if [[ -n "$EXPECTED_WORKTREE" ]]; then
        # AC-4 (Issue #31): Check worktree directory exists before path validation
        # Prevents Write tool from creating non-existent worktree directories
        if [[ ! -d "$EXPECTED_WORKTREE" ]]; then
            echo "HOOK_BLOCKED: Worktree does not exist: $EXPECTED_WORKTREE" | tee -a /tmp/claude-hook.log >&2
            exit 2
        fi

        FILE_PATH=""
        if command -v jq &>/dev/null; then
            FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty' 2>/dev/null)
        fi
        if [[ -z "$FILE_PATH" ]]; then
            FILE_PATH=$(echo "$TOOL_INPUT" | grep -oE '"file_path"\s*:\s*"[^"]+"' | head -1 | cut -d'"' -f4)
        fi

        if [[ -n "$FILE_PATH" ]]; then
            # Resolve to absolute path for consistent comparison
            REAL_FILE_PATH=$(realpath "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")
            REAL_WORKTREE=$(realpath "$EXPECTED_WORKTREE" 2>/dev/null || echo "$EXPECTED_WORKTREE")

            # Check if file path is within the expected worktree
            if [[ "$REAL_FILE_PATH" != "$REAL_WORKTREE"* ]]; then
                echo "$(date +%H:%M:%S) WORKTREE_BLOCKED: Edit outside expected worktree" >> "$QUALITY_LOG"
                echo "  Expected: $EXPECTED_WORKTREE" >> "$QUALITY_LOG"
                echo "  Got: $FILE_PATH" >> "$QUALITY_LOG"
                {
                    echo "HOOK_BLOCKED: File operation must be within worktree"
                    echo "  Worktree: $EXPECTED_WORKTREE"
                    echo "  File: $FILE_PATH"
                    if [[ -n "${SEQUANT_ISSUE:-}" ]]; then
                        echo "  Issue: #$SEQUANT_ISSUE"
                    fi
                } | tee -a /tmp/claude-hook.log >&2
                exit 2
            fi
        fi
    fi
fi

# === FILE LOCKING FOR PARALLEL AGENTS (AC-6) ===
# Prevents concurrent edits to the same file when parallel agents are running
# Uses lockf (macOS native) with a per-file lock in /tmp
# Disabled with CLAUDE_HOOKS_FILE_LOCKING=false
if [[ "${CLAUDE_HOOKS_FILE_LOCKING:-true}" == "true" ]]; then
    if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
        FILE_PATH=""
        if command -v jq &>/dev/null; then
            FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // empty' 2>/dev/null)
        fi
        if [[ -z "$FILE_PATH" ]]; then
            FILE_PATH=$(echo "$TOOL_INPUT" | grep -oE '"file_path"\s*:\s*"[^"]+"' | head -1 | cut -d'"' -f4)
        fi

        if [[ -n "$FILE_PATH" ]]; then
            # Create a lock file based on file path hash (handles special chars)
            LOCK_FILE="/tmp/claude-lock-$(echo "$FILE_PATH" | md5 -q 2>/dev/null || echo "$FILE_PATH" | md5sum | cut -d' ' -f1).lock"

            # Try to acquire lock with 30 second timeout
            # Use a subshell to hold the lock during the tool execution
            if command -v lockf &>/dev/null; then
                # macOS: use lockf
                exec 200>"$LOCK_FILE"
                if ! lockf -t 30 200 2>/dev/null; then
                    echo "HOOK_BLOCKED: File locked by another agent: $FILE_PATH" | tee -a /tmp/claude-hook.log >&2
                    exit 2
                fi
                # Lock will be released when the file descriptor closes (process exits)
            elif command -v flock &>/dev/null; then
                # Linux: use flock
                exec 200>"$LOCK_FILE"
                if ! flock -w 30 200 2>/dev/null; then
                    echo "HOOK_BLOCKED: File locked by another agent: $FILE_PATH" | tee -a /tmp/claude-hook.log >&2
                    exit 2
                fi
            fi
            # If neither lockf nor flock available, proceed without locking
        fi
    fi
fi

# === PRE-MERGE WORKTREE CLEANUP ===
# Auto-remove worktree before `gh pr merge` to prevent --delete-branch failure
# The worktree locks the branch, causing merge to partially fail
if [[ "$TOOL_NAME" == "Bash" ]] && echo "$TOOL_INPUT" | grep -qE 'gh pr merge'; then
    # Extract PR number from command
    PR_NUM=$(echo "$TOOL_INPUT" | grep -oE 'gh pr merge [0-9]+' | grep -oE '[0-9]+')

    if [[ -n "$PR_NUM" ]]; then
        # Get the branch name for this PR
        BRANCH_NAME=$(gh pr view "$PR_NUM" --json headRefName --jq '.headRefName' 2>/dev/null || true)

        if [[ -n "$BRANCH_NAME" ]]; then
            # Check if a worktree exists for this branch
            # Note: worktree line is 2 lines before branch line in porcelain output
            WORKTREE_PATH=$(git worktree list --porcelain 2>/dev/null | grep -B2 "branch refs/heads/$BRANCH_NAME" | grep "^worktree " | sed 's/^worktree //' || true)

            if [[ -n "$WORKTREE_PATH" && -d "$WORKTREE_PATH" ]]; then
                # Remove the worktree before merge proceeds
                git worktree remove "$WORKTREE_PATH" --force 2>/dev/null || true
                echo "PRE-MERGE: Removed worktree $WORKTREE_PATH for branch $BRANCH_NAME" >> /tmp/claude-hook.log
            fi
        fi
    fi
fi

# === ALLOW EVERYTHING ELSE ===
# Slash commands need: git, npm, file edits, gh pr/issue, MCP tools
exit 0
