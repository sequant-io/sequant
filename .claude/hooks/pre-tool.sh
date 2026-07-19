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

_TMPDIR="${TMPDIR:-/tmp}"

# Log sink (#763 AC-5c: blocked-command history must survive to be a useful
# regression corpus, so $TMPDIR — which macOS purges — is a last resort only).
#
# This block MUST stay identical to the one in post-tool.sh. The two hooks
# write the *same* claude-timing.log (START here, END there) and the same
# claude-quality.log, so any divergence silently splits every START/END pair
# across two files.
#
# Every candidate is absolute and lives outside the repo. A repo-local or
# relative path is wrong three times over: it resolves against the hook's cwd
# (which Claude Code does not pin), it yields one sink per directory instead
# of the single corpus AC-5 asks for, and — worst — creating it inside a repo
# makes `git status --porcelain` non-empty, which silently defeats the
# no-changes guard further down that reads exactly that output.
if [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]]; then
  _LOG_DIR="${CLAUDE_PLUGIN_DATA}/logs"
elif [[ -n "${HOME:-}" ]]; then
  _LOG_DIR="${HOME}/.sequant/logs"
else
  _LOG_DIR="${_TMPDIR}"
fi
mkdir -p "$_LOG_DIR" 2>/dev/null || _LOG_DIR="${_TMPDIR}"

TIMING_LOG="${_LOG_DIR}/claude-timing.log"
HOOK_LOG="${_LOG_DIR}/claude-hook.log"
PARALLEL_MARKER_PREFIX="${_TMPDIR}/claude-parallel-"

# === HELPERS ===

# rotate_log <file> — keep the last 500 lines once a log passes 1000, to
# prevent unbounded growth. Shared by TIMING_LOG and HOOK_LOG (#763 AC-5b).
rotate_log() {
    local f="$1"
    if [[ -f "$f" ]]; then
        local lc
        lc=$(wc -l < "$f" 2>/dev/null || echo 0)
        if [[ "$lc" -gt 1000 ]]; then
            tail -500 "$f" > "${f}.tmp" && mv "${f}.tmp" "$f"
        fi
    fi
}

# redact_secrets <content> — mask known token shapes before they reach a log.
# Mirrors the detection patterns in check_secrets(). $TOOL_INPUT can carry
# tokens (a `gh` body, an inline export), and HOOK_LOG now records full
# command text, so redaction is required (#763 AC-5a). This covers the same
# six shapes check_secrets detects; other secret formats are not masked.
redact_secrets() {
    printf '%s' "$1" | sed -E \
        -e 's/sk-[a-zA-Z0-9]{32,}/[REDACTED]/g' \
        -e 's/sk_live_[a-zA-Z0-9]{24,}/[REDACTED]/g' \
        -e 's/AKIA[A-Z0-9]{16}/[REDACTED]/g' \
        -e 's/ghp_[a-zA-Z0-9]{36}/[REDACTED]/g' \
        -e 's/xoxb-[0-9]{10,}(-[a-zA-Z0-9]+)+/[REDACTED]/g' \
        -e 's/AIza[a-zA-Z0-9_-]{35}/[REDACTED]/g'
}

# log_block <rule-id> — record which guard fired and the offending command
# (redacted) to a single rotated sink, so blocks can be audited and turned
# into a real regression corpus (#763 AC-5). Writes to HOOK_LOG only; the
# human-facing HOOK_BLOCKED message still goes to stderr at each call site.
log_block() {
    local rule="$1" redacted
    redacted=$(redact_secrets "$TOOL_INPUT")
    printf '%s BLOCKED [%s] %s\n' "$(date +%s.%N)" "$rule" "$redacted" >> "$HOOK_LOG"
    rotate_log "$HOOK_LOG"
}

# emit_segments <command> — split a shell command into the pieces the shell
# would actually execute, and print each (one per line) with inert text removed
# and leading env-assignments stripped, so guards can match a segment's
# *command words* without tripping on payload text carried as an argument (#763).
#
# Command-word positions (a guard MAY match here):
#   - each segment between the operators ; && || | and newline
#   - the body of a subshell `( ... )` and of a command substitution `$( ... )`,
#     including `$( ... )` inside double quotes — the shell runs those.
#
# Inert (a guard must NEVER match here):
#   - single-quoted text: the shell expands nothing inside it
#   - double-quoted text, except for `$( ... )`
#   - heredoc bodies: they are stdin *data*, not code. This one is load-bearing.
#     The standard commit idiom is `git commit -m "$(cat <<'EOF' ... EOF)"`;
#     without skipping the body, a commit message that merely *mentions*
#     `git push --force` would be blocked — which would reintroduce the
#     #564/#570 false-positive class through the command-substitution door.
#
# Argument positions are deliberately NOT command words, so `xargs sudo ...`
# and `bash -c "sudo ..."` are allowed: the guarded word is data being handed
# to another program, and treating it as code is what produced #564/#570.
#
# This is deliberately NOT a full shell parser: it does not emulate backslash
# escapes or globbing — acceptable for an accident-prevention layer (the real
# security boundary is Claude Code's permission system, not this hook). A
# crafted quoted string could in principle hide an operator; that is out of
# scope for a non-adversarial guard.
emit_segments() {
    printf '%s' "$1" | awk '
    function emit(s,   t) {
        t = s
        sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t)
        # Drop leading VAR=val assignments so `FOO=bar sudo ...` still keys off `sudo`.
        while (match(t, /^[A-Za-z_][A-Za-z0-9_]*=[^ \t]*[ \t]+/)) t = substr(t, RLENGTH + 1)
        if (length(t) > 0) print t
    }
    BEGIN { sq = sprintf("%c", 39); dq = sprintf("%c", 34) }
    { full = (NR == 1) ? $0 : full "\n" $0 }
    END {
        n = length(full); seg = ""; cur = ""; depth = 0; nhd = 0
        for (i = 1; i <= n; i++) {
            c = substr(full, i, 1)
            nc = (i < n) ? substr(full, i + 1, 1) : ""

            # Single-quoted: wholly inert until the closing quote.
            if (cur == sq) { if (c == sq) cur = ""; continue }

            # Double-quoted: inert, except that $( ... ) is live code.
            if (cur == dq) {
                if (c == "$" && nc == "(") {
                    emit(seg); seg = ""
                    stack[++depth] = dq; cur = ""; i++
                    continue
                }
                if (c == dq) cur = ""
                continue
            }

            # --- live context ---
            if (c == sq) { cur = sq; seg = seg " "; continue }
            if (c == dq) { cur = dq; seg = seg " "; continue }

            # Heredoc introducer: << or <<-, but not the <<< herestring. Record
            # the delimiter; the body itself is skipped at the newline below.
            if (c == "<" && nc == "<" && substr(full, i + 2, 1) != "<") {
                j = i + 2
                if (substr(full, j, 1) == "-") j++
                while (j <= n && substr(full, j, 1) ~ /[ \t]/) j++
                q = substr(full, j, 1); delim = ""
                if (q == sq || q == dq) {
                    j++
                    while (j <= n && substr(full, j, 1) != q) { delim = delim substr(full, j, 1); j++ }
                    j++
                } else {
                    while (j <= n && substr(full, j, 1) ~ /[A-Za-z0-9_.-]/) { delim = delim substr(full, j, 1); j++ }
                }
                if (length(delim) > 0) hd[++nhd] = delim
                seg = seg " "; i = j - 1
                continue
            }

            # Subshell / command substitution: the body is live code.
            if (c == "$" && nc == "(") { emit(seg); seg = ""; stack[++depth] = cur; cur = ""; i++; continue }
            if (c == "(")              { emit(seg); seg = ""; stack[++depth] = cur; continue }
            if (c == ")")              { emit(seg); seg = ""; if (depth > 0) cur = stack[depth--]; continue }

            if (c == ";" || c == "&" || c == "|") {
                emit(seg); seg = ""
                if ((c == "&" && nc == "&") || (c == "|" && nc == "|")) i++
                continue
            }

            if (c == "\n") {
                emit(seg); seg = ""
                # Any heredocs opened on the line just ended: their bodies are
                # data, so skip forward to each delimiter line.
                while (nhd > 0) {
                    d = hd[1]
                    for (k = 1; k < nhd; k++) hd[k] = hd[k + 1]
                    nhd--
                    while (i < n) {
                        ls = i + 1
                        le = index(substr(full, ls), "\n")
                        if (le == 0) { line = substr(full, ls); i = n }
                        else         { line = substr(full, ls, le - 1); i = ls + le - 1 }
                        t = line
                        sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t)
                        if (t == d) break
                    }
                }
                continue
            }
            seg = seg c
        }
        emit(seg)
    }
    '
}

# seg_match <ere> — 0 if any command segment of the current Bash command
# matches the extended regex. Precompute $SEGMENTS once per invocation so a
# dozen guards do not each re-run the splitter (#763 AC-9).
seg_match() {
    [[ -n "$SEGMENTS" ]] && grep -qE "$1" <<< "$SEGMENTS"
}

# Precompute the segment list once, for Bash commands only.
SEGMENTS=""
if [[ "$TOOL_NAME" == "Bash" ]]; then
    SEGMENTS=$(emit_segments "$TOOL_INPUT")
fi

# === AGENT ID DETECTION ===
# For parallel agents, detect group ID from marker files
# Format: ${_TMPDIR}/claude-parallel-<group-id>.marker
AGENT_ID=""
# Find marker files using find (works in both bash and zsh)
while IFS= read -r marker; do
    if [[ -n "$marker" && -f "$marker" ]]; then
        # Extract group ID from marker filename
        AGENT_ID=$(basename "$marker" | sed 's/claude-parallel-//' | sed 's/\.marker//')
        break
    fi
done < <(find "${_TMPDIR}" -maxdepth 1 -name "claude-parallel-*.marker" 2>/dev/null)

# === TIMING START ===
# Include agent ID in log format if available (AC-4)
if [[ -n "$AGENT_ID" ]]; then
    echo "$(date +%s.%N) [$AGENT_ID] START $TOOL_NAME" >> "$TIMING_LOG"
else
    echo "$(date +%s.%N) START $TOOL_NAME" >> "$TIMING_LOG"
fi

# === LOG ROTATION ===
# Rotate if over 1000 lines to prevent unbounded growth
rotate_log "$TIMING_LOG"

# === PLUGIN STALENESS CHECK (#784) ===
# Claude Code pins plugin installs to a commit SHA and never auto-updates
# them, so an installed cache can run months-old skills/hooks while the
# marketplace clone on the same disk tracks main and stays current. Compare
# the running plugin's version against the local marketplace clone and nudge.
# Warn-only (never blocks, exit code untouched), rate-limited to once per
# day via a stamp file, zero network, grep/sed only. Gated on the script's
# own path so repo-local dev copies (hooks/, templates/hooks/,
# .claude/hooks/) never warn — only real cache installs resolve under
# */plugins/cache/*.
_STALE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
if [[ "$_STALE_SCRIPT_DIR" == */plugins/cache/* ]]; then
    _STALE_STAMP="${_LOG_DIR}/plugin-stale-warned.stamp"
    _STALE_TODAY="$(date +%Y-%m-%d)"
    if [[ "$(cat "$_STALE_STAMP" 2>/dev/null)" != "$_STALE_TODAY" ]]; then
        # The plugin root is one level above hooks/; the plugins root is the
        # prefix before /plugins/cache/, so a relocated CLAUDE_CONFIG_DIR
        # works without hardcoding ~/.claude. marketplace.json's only
        # "version" key is the plugin entry's, so first match is correct.
        _STALE_RUNNING_JSON="${_STALE_SCRIPT_DIR%/hooks}/.claude-plugin/plugin.json"
        _STALE_MARKET_JSON="${_STALE_SCRIPT_DIR%%/plugins/cache/*}/plugins/marketplaces/sequant/.claude-plugin/marketplace.json"
        if [[ -f "$_STALE_RUNNING_JSON" && -f "$_STALE_MARKET_JSON" ]]; then
            _STALE_RUNNING_VER=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_STALE_RUNNING_JSON" 2>/dev/null | head -1)
            _STALE_MARKET_VER=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_STALE_MARKET_JSON" 2>/dev/null | head -1)
            if [[ -n "$_STALE_RUNNING_VER" && -n "$_STALE_MARKET_VER" && "$_STALE_RUNNING_VER" != "$_STALE_MARKET_VER" ]]; then
                echo "sequant plugin v${_STALE_RUNNING_VER} is stale (marketplace has v${_STALE_MARKET_VER}) — run: claude plugin update sequant@sequant, then restart Claude Code" >&2
                printf '%s' "$_STALE_TODAY" > "$_STALE_STAMP" 2>/dev/null || true
            fi
        fi
    fi
fi

# === CATASTROPHIC BLOCKS ===
# These should NEVER run in any automated context
# Only check Bash commands — Write/Edit content may contain these as config strings
#
# Every guard below matches against $SEGMENTS (quote-stripped command words),
# not the raw command string. This is what fixes #763: body text such as
# `gh issue create --body "...git push --force..."` carries the token inside a
# quoted argument, so it never appears as a command word and cannot trip a
# guard — which is why the old `^gh (issue|pr) ` carve-outs are gone entirely.
# Conversely a real command chained after an allowed one
# (`gh issue list && git push --force`) is its own segment and still blocks.
if [[ "$TOOL_NAME" == "Bash" ]]; then

# Secrets/credentials — a file reader at command-word position
if seg_match '^(cat|less|head|tail|more) .*\.(env|pem|key)'; then
    log_block "secret-file"
    echo "HOOK_BLOCKED: Reading secret file" >&2
    exit 2
fi

if seg_match '^(cat|less) .*~/\.(ssh|aws|gnupg|config/gh)'; then
    log_block "credential-dir"
    echo "HOOK_BLOCKED: Reading credential directory" >&2
    exit 2
fi

# Bare environment dump
if seg_match '^(env|printenv|export)$'; then
    log_block "env-dump"
    echo "HOOK_BLOCKED: Environment dump" >&2
    exit 2
fi

# Privilege escalation — `sudo` at a command-word position only (#763 AC-2).
# The `rm -rf /|~|$HOME` alternation that used to live here was deleted (AC-1):
# it was pure redundancy with Claude Code's native dangerous-rm analyzer (which
# still fires under bypassPermissions and covers root / top-level / home /
# workspace-ancestor targets), and its `rm -rf /` substring matched every
# absolute path, blocking ordinary worktree/scratch deletes. `sudo` is NOT
# natively covered, so it stays — but keyed off the command word, so
# `echo 'never sudo'` and `grep -r sudoku src/` are allowed.
#
# Because this guard has no native backstop, emit_segments treats every
# position the shell would execute as a command word: plain, chained,
# `( sudo ... )`, `$(sudo ...)`, and `"$(sudo ...)"` all block. Argument
# positions (`xargs sudo ...`, `bash -c "sudo ..."`) are an accepted gap —
# there the word is data handed to another program, and matching it is the
# mistake that produced #564/#570.
if seg_match '^sudo( |$)'; then
    log_block "sudo"
    echo "HOOK_BLOCKED: sudo command" >&2
    exit 2
fi

# Deployment (should never happen in issue automation)
if seg_match 'vercel (deploy|--prod)|terraform (apply|destroy)|kubectl (apply|delete)'; then
    log_block "deployment"
    echo "HOOK_BLOCKED: Deployment command" >&2
    exit 2
fi

# Force push
# Pattern requires -f to be a standalone flag (not part of branch name like -fix)
if seg_match 'git push.*(--force| -f($| ))'; then
    log_block "force-push"
    echo "HOOK_BLOCKED: Force push" >&2
    exit 2
fi

# --- Hard Reset Protection (Issue #85, enhanced) ---
# Block git reset --hard when there is local work that would be lost:
# - Unpushed commits on main/master
# - Uncommitted changes (staged or unstaged)
# - Unfinished merge in progress
if seg_match 'git reset.*(--hard|origin)'; then
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    BLOCK_REASONS=""

    # Check 1: Unpushed commits (only on main/master)
    if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
        UNPUSHED=$(git log origin/$CURRENT_BRANCH..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$UNPUSHED" -gt 0 ]]; then
            BLOCK_REASONS="${BLOCK_REASONS}  - $UNPUSHED unpushed commit(s) on $CURRENT_BRANCH\n"
        fi
    fi

    # Check 2: Uncommitted changes (staged or unstaged)
    UNCOMMITTED=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$UNCOMMITTED" -gt 0 ]]; then
        BLOCK_REASONS="${BLOCK_REASONS}  - $UNCOMMITTED uncommitted file(s)\n"
    fi

    # Check 3: Unfinished merge
    GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || echo ".git")
    if [[ -f "$GIT_DIR/MERGE_HEAD" ]]; then
        BLOCK_REASONS="${BLOCK_REASONS}  - Unfinished merge in progress\n"
    fi

    # Block if any reasons found
    if [[ -n "$BLOCK_REASONS" ]]; then
        log_block "git-reset-hard"
        {
            echo "HOOK_BLOCKED: git reset --hard would lose local work:"
            echo -e "$BLOCK_REASONS"
            echo "  Resolve with:"
            echo "    git push origin $CURRENT_BRANCH  # push commits"
            echo "    git stash                        # save changes"
            echo "    git merge --abort                # cancel merge"
            echo "  Or run directly in terminal (outside Claude Code) to bypass"
        } >&2
        exit 2
    fi
fi

# CI/CD triggers (automation shouldn't trigger more automation)
if seg_match 'gh workflow run'; then
    log_block "workflow-trigger"
    echo "HOOK_BLOCKED: Workflow trigger" >&2
    exit 2
fi

fi # end TOOL_NAME == "Bash" guard for catastrophic blocks

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
    if [[ "$TOOL_NAME" == "Bash" ]] && seg_match 'git commit'; then
        # Skip security checks if --no-verify is used
        if ! echo "$TOOL_INPUT" | grep -qE -- '--no-verify'; then
            # Check staged files for secrets
            STAGED_CONTENT=$(git diff --cached 2>/dev/null || true)
            if [[ -n "$STAGED_CONTENT" ]] && check_secrets "$STAGED_CONTENT"; then
                log_block "staged-secret"
                {
                    echo "HOOK_BLOCKED: Hardcoded secret detected in staged changes"
                    echo "  Use 'git commit --no-verify' to bypass if this is a false positive"
                } >&2
                exit 2
            fi

            # Check for sensitive files in commit
            STAGED_FILES=$(git diff --cached --name-only 2>/dev/null || true)
            if [[ -n "$STAGED_FILES" ]] && check_sensitive_files "$STAGED_FILES"; then
                log_block "sensitive-file"
                {
                    echo "HOOK_BLOCKED: Sensitive file in commit (${STAGED_FILES})"
                    echo "  Files like .env, *.pem, *.key should not be committed"
                    echo "  Use 'git commit --no-verify' to bypass if this is intentional"
                } >&2
                exit 2
            fi
        fi
    fi
fi

# === QUALITY GUARDS (Phase 2) ===

# --- No-Changes Guard (AC-7) ---
# Block commits when there are no staged or unstaged changes (prevents empty commits)
# Skips for --amend since amending doesn't require new changes
if [[ "$TOOL_NAME" == "Bash" ]] && seg_match 'git commit'; then
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
            log_block "no-changes"
            echo "HOOK_BLOCKED: No changes to commit. Stage files with 'git add' first." >&2
            exit 2
        fi
    fi
fi

# --- Worktree Validation (AC-8) ---
# Warn (but don't block) when committing outside a feature worktree
# This catches accidental commits to main repo during feature work
QUALITY_LOG="${_LOG_DIR}/claude-quality.log"
if [[ "$TOOL_NAME" == "Bash" ]] && seg_match 'git commit'; then
    CWD=$(pwd)
    if ! echo "$CWD" | grep -qE 'worktrees/feature/'; then
        echo "$(date +%H:%M:%S) WORKTREE_WARNING: Committing outside feature worktree ($CWD)" >> "$QUALITY_LOG"
        # Warning only - does not block
    fi
fi

# --- Commit Message Validation (AC-3) ---
# Enforce conventional commits format: type(scope): description
# Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf
if [[ "$TOOL_NAME" == "Bash" ]] && seg_match 'git commit'; then
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
            log_block "commit-format"
            {
                echo "HOOK_BLOCKED: Commit must follow conventional commits format"
                echo "  Expected: type(scope): description"
                # AC-1 & AC-2 (Issue #198): Detect merge commits and provide helpful suggestion
                if [[ "$MSG" == Merge\ * ]]; then
                    echo ""
                    echo "  💡 For merge commits, use: chore: merge main into feature branch"
                    echo ""
                fi
                echo "  Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf"
                echo "  Got: $MSG"
            } >&2
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
            log_block "worktree-missing"
            echo "HOOK_BLOCKED: Worktree does not exist: $EXPECTED_WORKTREE" >&2
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
                log_block "worktree-boundary"
                {
                    echo "HOOK_BLOCKED: File operation must be within worktree"
                    echo "  Worktree: $EXPECTED_WORKTREE"
                    echo "  File: $FILE_PATH"
                    if [[ -n "${SEQUANT_ISSUE:-}" ]]; then
                        echo "  Issue: #$SEQUANT_ISSUE"
                    fi
                } >&2
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
            LOCK_FILE="${_TMPDIR}/claude-lock-$(echo "$FILE_PATH" | md5 -q 2>/dev/null || echo "$FILE_PATH" | md5sum | cut -d' ' -f1).lock"

            # Try to acquire lock with 30 second timeout
            # Use a subshell to hold the lock during the tool execution
            if command -v lockf &>/dev/null; then
                # macOS: use lockf
                exec 200>"$LOCK_FILE"
                if ! lockf -t 30 200 2>/dev/null; then
                    log_block "file-lock"
                    echo "HOOK_BLOCKED: File locked by another agent: $FILE_PATH" >&2
                    exit 2
                fi
                # Lock will be released when the file descriptor closes (process exits)
            elif command -v flock &>/dev/null; then
                # Linux: use flock
                exec 200>"$LOCK_FILE"
                if ! flock -w 30 200 2>/dev/null; then
                    log_block "file-lock"
                    echo "HOOK_BLOCKED: File locked by another agent: $FILE_PATH" >&2
                    exit 2
                fi
            fi
            # If neither lockf nor flock available, proceed without locking
        fi
    fi
fi

# === ALLOW EVERYTHING ELSE ===
# Slash commands need: git, npm, file edits, gh pr/issue, MCP tools
exit 0
