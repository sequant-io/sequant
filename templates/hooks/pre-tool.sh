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
    # Claude Code's hook envelope carries the session id (same field
    # capture-tokens.sh reads). Preferred holder identity for the checkout
    # lock (#901): a skill shell's PID dies right after acquire, the session
    # id does not. `// empty` keeps this safe if the field is ever absent —
    # the guard then falls back to SEQUANT_ISSUE.
    SESSION_ID=$(echo "$INPUT_JSON" | jq -r '.session_id // empty')
    # The shell cwd the tool will run in. Distinct from CLAUDE_PROJECT_DIR,
    # which stays pinned to the main checkout even while the agent works in a
    # worktree — see the checkout-lock guard (#901).
    HOOK_CWD=$(echo "$INPUT_JSON" | jq -r '.cwd // empty')
    # For Bash tool, extract .command from tool_input; for others, stringify the whole object
    if [[ "$(echo "$INPUT_JSON" | jq -r '.tool_name // empty')" == "Bash" ]]; then
        TOOL_INPUT=$(echo "$INPUT_JSON" | jq -r '.tool_input.command // empty')
    else
        TOOL_INPUT=$(echo "$INPUT_JSON" | jq -r '.tool_input | tostring // empty')
    fi
else
    TOOL_NAME=$(echo "$INPUT_JSON" | grep -oE '"tool_name"\s*:\s*"[^"]+"' | head -1 | cut -d'"' -f4)
    SESSION_ID=$(echo "$INPUT_JSON" | grep -oE '"session_id"\s*:\s*"[^"]+"' | head -1 | cut -d'"' -f4)
    HOOK_CWD=$(echo "$INPUT_JSON" | grep -oE '"cwd"\s*:\s*"[^"]+"' | head -1 | cut -d'"' -f4)
    # For Bash tool, extract command from tool_input; for others, extract the whole object
    if [[ "$TOOL_NAME" == "Bash" ]]; then
        # Escape-aware extraction (#963 gap B): the naive `grep -oE '"[^"]+"'`
        # form (still used for the simpler fields above, where an embedded
        # `\"` is implausible) stops at the FIRST escaped quote inside the
        # JSON string, truncating any command containing one — e.g.
        # `git commit -m "msg with \"quotes\""` would be cut down to just
        # `git commit -m ` before it ever reaches the guards below.
        #
        # sed's `(([^"\\]|\\.)*)` captures the full escaped run — any run of
        # non-quote/non-backslash chars, or a backslash paired with whatever
        # follows it — up to the closing unescaped `"`. `JSON.stringify`
        # guarantees the whole payload is one physical line, so a single
        # sed pass is enough (no multi-line `-z` needed, which BSD sed lacks
        # anyway).
        #
        # The captured text still carries JSON string escapes literally
        # (`\"`, `\\`, `\n`, `\t`, ...); the awk pass resolves them in ONE
        # left-to-right scan, consuming two characters per recognized
        # escape. That ordering is what a chain of separate sed/tr
        # substitutions cannot get right without a placeholder: a literal
        # `\\n` in the original command is an escaped backslash (`\\`)
        # immediately followed by a literal `n`, and must stay a backslash
        # plus 'n' — not become an escaped-newline (`\n`) if the two escapes
        # were resolved out of order. Scanning once and advancing past both
        # characters of whichever escape is recognized sidesteps that
        # ambiguity entirely.
        TOOL_INPUT=$(printf '%s' "$INPUT_JSON" \
            | sed -E -n 's/.*"command"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' \
            | head -1 \
            | awk '
                {
                    s = $0; out = ""; n = length(s)
                    for (i = 1; i <= n; i++) {
                        c = substr(s, i, 1)
                        if (c == "\\" && i < n) {
                            nc = substr(s, i + 1, 1)
                            if (nc == "\"") { out = out "\""; i++ }
                            else if (nc == "\\") { out = out "\\"; i++ }
                            else if (nc == "n") { out = out "\n"; i++ }
                            else if (nc == "t") { out = out "\t"; i++ }
                            else if (nc == "r") { out = out "\r"; i++ }
                            else if (nc == "/") { out = out "/"; i++ }
                            else { out = out c }
                        } else {
                            out = out c
                        }
                    }
                    print out
                }
            ')
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

# Parallel-group marker naming (#881). The scheme lives in one sourced helper
# next to this hook so the writer (/exec skill) and the readers (this hook and
# post-tool.sh) cannot drift. PARALLEL_MARKER_PREFIX is project-scoped, so a
# parallel group in another project no longer collides in the shared temp dir.
_MARKER_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/parallel-marker.sh"
if [[ -f "$_MARKER_HELPER" ]]; then
    # shellcheck source=parallel-marker.sh disable=SC1091
    source "$_MARKER_HELPER"
    PARALLEL_MARKER_PREFIX="$(parallel_marker_prefix)"
    PARALLEL_MARKER_PROJECT_ROOT="$(parallel_marker_project_root)"
else
    # Helper missing (unexpected): fall back to the pre-#881 global prefix so the
    # hook still functions, accepting the old cross-project collision risk.
    PARALLEL_MARKER_PREFIX="${_TMPDIR}/claude-parallel-"
    PARALLEL_MARKER_PROJECT_ROOT=""
fi

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

# raw_commit_segment <command> — print the raw (unsanitized) text of every
# top-level segment of <command> whose code form contains the literal
# substring "git commit", in order, \001-separated; nothing if none is found.
#
# Unlike emit_segments/$SEGMENTS above — which intentionally blank quoted and
# heredoc content so guards match only code, never data (#763) — this keeps
# quotes and heredoc bodies verbatim, because the commit-message validator
# needs the LITERAL message text, not a sanitized stand-in. It still respects
# the same top-level boundaries (; && || | and newline, outside quotes and
# subshells) so an earlier quoted string or a later unrelated heredoc can
# never be mistaken for this segment's own text — that was #981: the old
# extraction scanned the whole command, so `echo "decoy"; git commit -m
# "fix: y"` picked up "decoy", and a heredoc anywhere (even in a later,
# unrelated command) short-circuited extraction before the real -m arg was
# ever read.
#
# A heredoc that IS part of this segment (the standard
# `-m "$(cat <<'EOF' ... EOF)"` idiom) stays inside it: `$( ... )` content is
# tracked as nested depth, not split on, so its body — including embedded
# newlines — is carried through untouched for the caller's own heredoc
# parsing.
#
# Deliberately not a full shell parser (see emit_segments' header for the
# same caveat). Prints EVERY qualifying segment, in order, separated by \001
# (segments carry embedded newlines, so a newline cannot be the delimiter):
# the caller validates EVERY one that yields a message (spec Open Question 2),
# so a `-m`-less shadow segment that merely mentions `git commit` (a comment
# line, `git commit-tree`, `git commit --amend --no-edit`, an unquoted echo)
# cannot hide the real commit behind it, and a decoy conventional commit
# earlier in a compound command cannot shield a later non-conventional one —
# both fail-opens `main` did not have, so they are closed rather than accepted.
raw_commit_segment() {
    printf '%s' "$1" | awk '
    # heredoc_delim(full, i, n) — parse the delimiter word after the `<<` /
    # `<<-` introducer at position i (quoted or bare); returns it and leaves
    # hd_end at the first position after the word. Shared by the depth-0 and
    # subshell branches below so the two scans cannot drift apart.
    function heredoc_delim(full, i, n,   j, q, delim) {
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
        hd_end = j
        return delim
    }
    # emit(raw, code) — accept the segment only when its CODE form (quoted and
    # subshell content blanked) contains "git commit". Testing the raw form
    # instead would let a quoted mention pick the wrong segment: in
    # `echo "run git commit later"; git commit -m "updated stuff"` the echo
    # wins, and because it holds no -m the caller extracts no message and
    # skips validation entirely. Blanking mirrors what emit_segments/seg_match
    # already do, so this scan agrees with the guard that invoked it.
    function emit(s, sc,   t, tc) {
        t = s; tc = sc
        sub(/^[ \t\n]+/, "", t); sub(/[ \t\n]+$/, "", t)
        if (length(t) > 0 && index(tc, "git commit") > 0) {
            printf "%s%c", t, 1
        }
    }
    BEGIN { sq = sprintf("%c", 39); dq = sprintf("%c", 34) }
    { full = (NR == 1) ? $0 : full "\n" $0 }
    END {
        n = length(full); seg = ""; code = ""; cur = ""; depth = 0; nhd = 0; hdseen = 0; nshd = 0
        for (i = 1; i <= n; i++) {
            c = substr(full, i, 1)
            nc = (i < n) ? substr(full, i + 1, 1) : ""

            # --- inside single quotes: everything is data ---
            if (cur == sq) { seg = seg c; code = code " "; if (c == sq) cur = ""; continue }

            # --- inside double quotes ---
            if (cur == dq) {
                if (c == "$" && nc == "(") {
                    seg = seg "$("; code = code "  "
                    stack[++depth] = dq; cur = ""; i++
                    continue
                }
                # A backslash inside double quotes escapes the next character:
                # \<newline> is a line continuation (drop both), and \" is a
                # literal quote that must not be read as the closing one.
                if (c == "\\" && i < n) {
                    if (nc == "\n") { i++; continue }
                    seg = seg c nc; code = code "  "; i++
                    continue
                }
                seg = seg c; code = code " "
                if (c == dq) cur = ""
                continue
            }

            # --- live (unquoted) ---
            # A backslash escapes the next character. `\<newline>` is a shell
            # line continuation: the command keeps going, so drop both and do
            # NOT let the newline branch below end the segment here. Without
            # this, `git commit \` + newline + `-m "..."` was cut at the
            # backslash, leaving a segment that holds no -m — MSG came back
            # empty and the conventional-commit guard skipped validation
            # entirely, waving through a non-conventional message that the
            # pre-#981 code had blocked. Any other escaped character is kept
            # verbatim in the raw text but blanked in the code form so it can
            # never toggle quote state or forge a "git commit" match.
            if (c == "\\" && i < n) {
                if (nc == "\n") { i++; continue }
                seg = seg c nc; code = code "  "; i++
                continue
            }
            # `#` comment (unquoted, at a word boundary): keep the raw text but
            # blank it in CODE to end-of-line, so a commit mentioned inside a
            # comment — `# git commit -m "wip"` — never qualifies a segment and
            # is never validated (a false positive the per-segment walk would
            # otherwise introduce). Applies at any depth.
            if (c == "#" && (i == 1 || substr(full, i - 1, 1) ~ /[ \t\n;&|(]/)) {
                while (i <= n && substr(full, i, 1) != "\n") { seg = seg substr(full, i, 1); code = code " "; i++ }
                i--
                continue
            }
            if (c == sq) { cur = sq; seg = seg c; code = code " "; continue }
            if (c == dq) { cur = dq; seg = seg c; code = code " "; continue }

            if (c == "$" && nc == "(") {
                seg = seg "$("; code = code "  "
                stack[++depth] = cur; i++
                continue
            }
            if (c == "(") { seg = seg c; code = code " "; stack[++depth] = cur; continue }
            if (c == ")") {
                seg = seg c; code = code " "
                if (depth > 0) { cur = stack[depth]; depth-- }
                continue
            }

            # Inside a subshell/command-substitution: keep everything raw in
            # the segment text (a heredoc body that belongs to THIS segment
            # must survive verbatim for the caller to parse), and never split
            # on operators or heredocs in here.
            #
            # For the CODE form, subshell code COUNTS: `( git commit -m "x" )`
            # and `(cd sub && git commit -m "x")` really do run git commit, so
            # blanking the whole subshell left no segment qualifying, emit()
            # returned nothing, and the caller fell back to the whole command
            # — which is exactly the #981 false positive this function exists
            # to remove.
            #
            # A heredoc BODY inside the subshell is data, not code, so once an
            # introducer is seen the rest of the subshell is blanked. Without
            # that guard a body line like `fix: this is heredoc data` wins
            # segment selection, gets validated as if it were the message, and
            # the real `git commit -m "updated stuff"` two segments later is
            # never examined — a fail-open, verified before this guard was
            # added.
            if (depth > 0) {
                # Heredoc introducer (<< or <<-, never the <<< herestring, which
                # is an inline word, not a body). Record the delimiter so the
                # body can be skipped at the newline below; blank CODE from here
                # until the terminator line so body text never wins selection,
                # but let a commit AFTER the body in the same subshell count
                # again — otherwise `( cat <<EOF ... EOF; git commit -m "updated
                # stuff" )` had no qualifying segment, fell back to the whole
                # command, and sailed through (a fail-open, verified).
                if (c == "<" && nc == "<" && substr(full, i + 2, 1) != "<") {
                    delim = heredoc_delim(full, i, n); j = hd_end
                    if (length(delim) > 0) shd[++nshd] = delim
                    hdseen = 1
                    seg = seg substr(full, i, j - i); code = code " "
                    i = j - 1
                    continue
                }
                if (c == "\n" && nshd > 0) {
                    # Consume the pending heredoc bodies verbatim into the
                    # segment (blank in CODE); the guard lifts after the last
                    # terminator line.
                    seg = seg c; code = code " "
                    while (nshd > 0) {
                        d = shd[1]
                        for (k = 1; k < nshd; k++) shd[k] = shd[k + 1]
                        nshd--
                        while (i < n) {
                            ls = i + 1
                            le = index(substr(full, ls), "\n")
                            if (le == 0) { line = substr(full, ls); i = n }
                            else         { line = substr(full, ls, le - 1); i = ls + le - 1 }
                            seg = seg line "\n"; code = code " "
                            t = line
                            sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t)
                            if (t == d) break
                        }
                    }
                    hdseen = 0
                    continue
                }
                seg = seg c
                code = code (hdseen ? " " : c)
                continue
            }

            # depth == 0, unquoted: a heredoc introducer here belongs to a
            # separate, later command — its body is data, not this segments
            # text, so skip it entirely (#981 Finding paragraph 2).
            if (c == "<" && nc == "<" && substr(full, i + 2, 1) != "<") {
                delim = heredoc_delim(full, i, n); j = hd_end
                seg = seg substr(full, i, j - i); code = code " "
                if (length(delim) > 0) hd[++nhd] = delim
                i = j - 1
                continue
            }

            if (c == ";" || c == "&" || c == "|") {
                emit(seg, code); seg = ""; code = ""; hdseen = 0; nshd = 0
                if ((c == "&" && nc == "&") || (c == "|" && nc == "|")) i++
                continue
            }

            if (c == "\n") {
                # A heredoc body that feeds THIS segment (`git commit -F- <<EOF`)
                # is data the caller must see: keep it raw in the segment text
                # (blank in CODE so it never wins selection), then emit.
                if (nhd > 0) { seg = seg c; code = code " " }
                while (nhd > 0) {
                    d = hd[1]
                    for (k = 1; k < nhd; k++) hd[k] = hd[k + 1]
                    nhd--
                    while (i < n) {
                        ls = i + 1
                        le = index(substr(full, ls), "\n")
                        if (le == 0) { line = substr(full, ls); i = n }
                        else         { line = substr(full, ls, le - 1); i = ls + le - 1 }
                        seg = seg line "\n"; code = code " "
                        t = line
                        sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t)
                        if (t == d) break
                    }
                }
                emit(seg, code); seg = ""; code = ""; hdseen = 0; nshd = 0
                continue
            }
            seg = seg c; code = code c
        }
        emit(seg, code)
    }
    '
}

# resolve_cd_target <tool_input> — print the target directory of the LAST
# `cd <path>` line in a (possibly multi-line) Bash command, if and only if
# the path is a static literal (quoted or unquoted) that resolves to an
# existing directory. Scans the raw command, not $SEGMENTS — emit_segments
# drops double-quoted regions, so `cd "$WT"` would vanish there before this
# ever saw it. Prints nothing when there is no `cd` line, the target is
# dynamic (contains `$` or a backtick), or the path doesn't exist — callers
# must treat empty output as "fail open", never as license to guess a
# directory (#963).
resolve_cd_target() {
    local input="$1" line target
    line=$(printf '%s\n' "$input" | grep -E '^[[:space:]]*cd[[:space:]]+' | tail -1)
    [[ -z "$line" ]] && return 0

    target=$(printf '%s' "$line" | sed -E 's/^[[:space:]]*cd[[:space:]]+//; s/[[:space:]]*[;&|].*$//; s/[[:space:]]+$//')

    # Strip one layer of surrounding matching quotes.
    case "$target" in
        \"*\") target="${target#\"}"; target="${target%\"}" ;;
        \'*\') target="${target#\'}"; target="${target%\'}" ;;
    esac

    # Fail open on anything dynamic — resolving shell expansions means
    # reimplementing the shell, which is disproportionate; `git commit`
    # itself already rejects a genuinely empty commit. A backslash is
    # rejected too: it can escape a following `$`/`` ` `` into a form this
    # literal-string check would otherwise miss, and a backslash also carries
    # its own shell meaning (line continuation, escaped chars) that this
    # function does not attempt to resolve — failing open is the safe
    # direction either way (#963).
    case "$target" in
        *'$'*|*'`'*|*'\'*) return 0 ;;
    esac

    [[ -n "$target" && -d "$target" ]] && printf '%s' "$target"
}

# Path of the session->issue binding the checkout guard maintains (#906).
# $1 = repo toplevel, $2 = session id. The id is opaque, so squash everything
# outside a filename-safe set — it must not be able to escape the directory.
_co_binding_path() {
    printf '%s/.sequant/locks/session-%s.issue' \
        "$1" "$(printf '%s' "$2" | tr -c 'A-Za-z0-9_-' '_')"
}

# Precompute the segment list once, for Bash commands only.
SEGMENTS=""
if [[ "$TOOL_NAME" == "Bash" ]]; then
    SEGMENTS=$(emit_segments "$TOOL_INPUT")
fi

# === AGENT ID DETECTION ===
# For parallel agents, detect group ID from marker files. The glob is scoped to
# the current project's marker prefix (#881) so a foreign project's marker never
# labels this session's timing rows.
AGENT_ID=""
_MARKER_BASE=$(basename "$PARALLEL_MARKER_PREFIX")
# Find marker files using find (works in both bash and zsh)
while IFS= read -r marker; do
    if [[ -n "$marker" && -f "$marker" ]]; then
        # Extract group ID: strip the project-scoped prefix and the suffix.
        AGENT_ID=$(basename "$marker" .marker)
        AGENT_ID=${AGENT_ID#"$_MARKER_BASE"}
        break
    fi
done < <(find "${_TMPDIR}" -maxdepth 1 -name "${_MARKER_BASE}*.marker" 2>/dev/null)

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

# === PLUGIN STALENESS CHECK (#784, hardened #788) ===
# Claude Code pins plugin installs to a commit SHA and never auto-updates
# them, so an installed cache can run months-old skills/hooks while the
# marketplace clone on the same disk tracks main and stays current. Compare
# the running plugin's version against the local marketplace clone and nudge.
# Warn-only (never blocks, exit code untouched), rate-limited to once per
# day via a stamp file, zero network, grep/sed/awk only. Gated on the
# script's own path so repo-local dev copies (hooks/, templates/hooks/,
# .claude/hooks/) never warn — only real cache installs resolve under
# */plugins/cache/*.
_STALE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
if [[ "$_STALE_SCRIPT_DIR" == */plugins/cache/* ]]; then
    _STALE_STAMP="${_LOG_DIR}/plugin-stale-warned.stamp"
    _STALE_TODAY="$(date +%Y-%m-%d)"
    if [[ "$(cat "$_STALE_STAMP" 2>/dev/null)" != "$_STALE_TODAY" ]]; then
        # The plugin root is one level above hooks/; the plugins root is the
        # prefix before /plugins/cache/, so a relocated CLAUDE_CONFIG_DIR
        # works without hardcoding ~/.claude.
        _STALE_RUNNING_JSON="${_STALE_SCRIPT_DIR%/hooks}/.claude-plugin/plugin.json"
        _STALE_PLUGINS_ROOT="${_STALE_SCRIPT_DIR%%/plugins/cache/*}/plugins"
        # Locate the marketplace clone by scanning, not by a hardcoded dir
        # name: Claude Code names the dir after the marketplace, which may
        # differ across versions. Pick the first clone whose JSON declares
        # the sequant plugin. The [[ -f ]] guard also absorbs a literal
        # unmatched glob, so "no clone present" is a silent no-op.
        _STALE_MARKET_JSON=""
        for _stale_mkt in "$_STALE_PLUGINS_ROOT"/marketplaces/*/.claude-plugin/marketplace.json; do
            [[ -f "$_stale_mkt" ]] || continue
            grep -q '"name"[[:space:]]*:[[:space:]]*"sequant"' "$_stale_mkt" 2>/dev/null || continue
            _STALE_MARKET_JSON="$_stale_mkt"
            break
        done
        if [[ -n "$_STALE_MARKET_JSON" && -f "$_STALE_RUNNING_JSON" ]]; then
            # marketplace.json's only "version" key is the plugin entry's, so
            # first match is correct (sequant is the sole plugin listed).
            _STALE_RUNNING_VER=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_STALE_RUNNING_JSON" 2>/dev/null | head -1)
            _STALE_MARKET_VER=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_STALE_MARKET_JSON" 2>/dev/null | head -1)
            # Warn only when the install is strictly BEHIND the marketplace —
            # a dev cache ahead of the marketplace is not stale. Dotted
            # numeric compare in awk (no `sort -V` dependency, which is a
            # GNU-ism unreliable on BSD/macOS); a non-numeric prerelease
            # component is compared by its leading integer, e.g.
            # "2.8.0-beta" sorts as 2.8.0 — precise enough for a nudge.
            if [[ -n "$_STALE_RUNNING_VER" && -n "$_STALE_MARKET_VER" ]] && \
               awk -v a="$_STALE_RUNNING_VER" -v b="$_STALE_MARKET_VER" '
                   function cmp(x, y,   ax, ay, i, av, bv, n) {
                       n = split(x, ax, "."); split(y, ay, ".")
                       for (i = 1; i <= n || (i in ay); i++) {
                           av = (i in ax) ? ax[i] + 0 : 0
                           bv = (i in ay) ? ay[i] + 0 : 0
                           if (av < bv) return -1
                           if (av > bv) return 1
                       }
                       return 0
                   }
                   BEGIN { exit !(cmp(a, b) < 0) }
               '; then
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

# --- Session -> issue binding for the checkout guard (Issue #906) ---
# `SEQUANT_ISSUE` cannot identify the holder interactively, and never could:
# PreToolUse runs OUTSIDE and BEFORE the command's shell, so nothing a skill
# bash block exports is visible here — not even an export prepended to the same
# block as the guarded command. The one path that does export it (`sequant run`)
# also sets SEQUANT_ORCHESTRATOR, where this guard stands down. So the env
# fallback below was unreachable in every real flow, and the holder was
# routinely blocked by its own lock.
#
# The hook does see both the acquire and every later command of the same
# session, and `session_id` survives the shell boundary that kills the
# acquiring PID. Record the binding when we observe the acquire; read it back
# when deciding whether the caller is the holder.
if [[ -n "${SESSION_ID:-}" ]] && seg_match 'locks +checkout +(acquire|release)'; then
    _CO_SB_ROOT=$(git -C "${HOOK_CWD:-$PWD}" rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$_CO_SB_ROOT" && -d "$_CO_SB_ROOT/.git" ]]; then
        _CO_SB_FILE=$(_co_binding_path "$_CO_SB_ROOT" "$SESSION_ID")
        _CO_SB_ISSUE=$(printf '%s' "$TOOL_INPUT" \
            | grep -oE '\-\-issue[= ]+[0-9]+' | head -1 | grep -oE '[0-9]+$' || true)
        if seg_match 'locks +checkout +acquire'; then
            if [[ -n "$_CO_SB_ISSUE" ]]; then
                mkdir -p "$(dirname "$_CO_SB_FILE")" 2>/dev/null \
                    && printf '%s' "$_CO_SB_ISSUE" > "$_CO_SB_FILE" 2>/dev/null || true
            fi
        elif [[ -f "$_CO_SB_FILE" ]]; then
            # Clear only when the session releases its OWN claim. A refused
            # release (wrong --issue) must not strip the real holder's identity
            # and leave it blocked by its own lock.
            if [[ -n "$_CO_SB_ISSUE" \
                  && "$_CO_SB_ISSUE" == "$(cat "$_CO_SB_FILE" 2>/dev/null)" ]]; then
                rm -f "$_CO_SB_FILE" 2>/dev/null || true
            fi
        fi
    fi
fi

# --- Checkout-scoped lock enforcement (Issue #901) ---
# The per-issue lock (#625) keys on issue number, so two sessions working
# *different* issues take different lock files and never contend. But
# `git checkout`, `switch`, `reset`, `rebase`, `merge` and `cherry-pick` are
# global to a working tree — the contended resource is the checkout, not the
# issue. `.sequant/locks/checkout.lock` represents the tree; this guard is what
# makes it binding, because the racing actor is an agent's Bash command, not
# sequant's TypeScript (which mutates git almost exclusively via `git -C
# <worktree>`).
#
# STALENESS IS A DELIBERATELY WEAKER SUBSET, NOT A MIRROR. The authoritative
# rules live in `classifyStaleness` (src/lib/locks/lock-manager.ts) and are
# shared by CheckoutLock. Transcribing them into shell would drift (#871), so
# this guard checks only the absolute age ceiling and FAILS OPEN past it. A
# lock this guard lets through is still caught by the TypeScript path; a lock
# it blocks on is always genuinely fresh. Weaker-but-honest beats a mirror.
#
# AC-5: orchestrator/MCP mode is a no-op here too, matching LockManager and
# CheckoutLock — `sequant run` drives its own worktree isolation and must not
# be blocked by a lock its own skills took.
if [[ -z "${SEQUANT_ORCHESTRATOR:-}" ]] \
   && seg_match 'git (checkout|switch|reset|rebase|merge|cherry-pick)( |$)' \
   && ! seg_match 'git +-C ' \
   && ! seg_match 'git checkout ([^ ]+ )?--( |$)'; then

    # Only the MAIN checkout is protected — a command run inside a worktree
    # touches only that worktree's HEAD and must never be blocked.
    #
    # Resolve where the command will ACTUALLY run. This must NOT use
    # CLAUDE_PROJECT_DIR / PARALLEL_MARKER_PROJECT_ROOT: those name the
    # *project* directory, which stays pinned to the main checkout even while
    # the agent's shell sits in a worktree. Keying off them blocked legitimate
    # in-worktree work — the guard's worst failure mode, since the whole point
    # of the lock is to push sessions *into* worktrees.
    #
    # `.cwd` is part of Claude Code's PreToolUse envelope (verified against a
    # live payload alongside `session_id`), with $PWD as the fallback.
    _CO_CWD="${HOOK_CWD:-$PWD}"
    # Honor a `cd <dir>` the same way the commit guard below does — including
    # multi-line commands and quoted/dynamic targets (#963).
    _CO_CD=$(resolve_cd_target "$TOOL_INPUT")
    [[ -n "$_CO_CD" ]] && _CO_CWD="$_CO_CD"

    # A linked worktree's toplevel has `.git` as a FILE; the main checkout has
    # it as a directory.
    _CO_ROOT=$(git -C "$_CO_CWD" rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$_CO_ROOT" && -d "$_CO_ROOT/.git" ]]; then
        _CO_LOCK="$_CO_ROOT/.sequant/locks/checkout.lock"

        if [[ -f "$_CO_LOCK" ]]; then
            if command -v jq &>/dev/null; then
                _CO_HOLDER_ISSUE=$(jq -r '.issue // empty' "$_CO_LOCK" 2>/dev/null)
                _CO_HOLDER_SESSION=$(jq -r '.sessionId // empty' "$_CO_LOCK" 2>/dev/null)
                _CO_HOLDER_PID=$(jq -r '.pid // empty' "$_CO_LOCK" 2>/dev/null)
                _CO_HOLDER_HOST=$(jq -r '.hostname // empty' "$_CO_LOCK" 2>/dev/null)
                _CO_HOLDER_STARTED=$(jq -r '.startedAt // empty' "$_CO_LOCK" 2>/dev/null)
                _CO_HOLDER_CMD=$(jq -r '.command // empty' "$_CO_LOCK" 2>/dev/null)
            else
                _CO_HOLDER_ISSUE=$(grep -oE '"issue"[[:space:]]*:[[:space:]]*[0-9]+' "$_CO_LOCK" | head -1 | grep -oE '[0-9]+$')
                _CO_HOLDER_SESSION=$(grep -oE '"sessionId"[[:space:]]*:[[:space:]]*"[^"]*"' "$_CO_LOCK" | head -1 | cut -d'"' -f4)
                _CO_HOLDER_PID=$(grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$_CO_LOCK" | head -1 | grep -oE '[0-9]+$')
                _CO_HOLDER_HOST=$(grep -oE '"hostname"[[:space:]]*:[[:space:]]*"[^"]*"' "$_CO_LOCK" | head -1 | cut -d'"' -f4)
                _CO_HOLDER_STARTED=$(grep -oE '"startedAt"[[:space:]]*:[[:space:]]*"[^"]*"' "$_CO_LOCK" | head -1 | cut -d'"' -f4)
                _CO_HOLDER_CMD=$(grep -oE '"command"[[:space:]]*:[[:space:]]*"[^"]*"' "$_CO_LOCK" | head -1 | cut -d'"' -f4)
            fi

            # Staleness. These branches mirror `classifyStaleness`
            # (src/lib/locks/lock-manager.ts) in the same order, because AC-4
            # requires the checkout lock's stale recovery to match the per-issue
            # lock's — same-host dead PID, age ceiling, and the env overrides.
            # Implementing only a subset here would let a *dead* holder block
            # the tree for up to 24h, which is the wedge AC-4 forbids.
            #
            # The three rules are plain comparisons plus one `kill -0`, so this
            # is a small enough surface to keep honest; the "hook/TypeScript
            # staleness parity" cases in checkout-lock.integration.test.ts pin
            # both sides to the same verdict so they cannot drift silently
            # (#871 — the repo's drift guard compares literal strings only and
            # would not see a semantic divergence here).
            _CO_MAX_AGE_MS="${SEQUANT_MAX_LOCK_AGE_MS:-86400000}"     # 24h ceiling
            _CO_SKILL_TTL_MS="${SEQUANT_SKILL_LOCK_TTL_MS:-21600000}" # 6h skill-shell
            _CO_STALE_AGE_MS=7200000                                  # 2h cross-host
            _CO_FRESH=true

            # `startedAt` is ISO-8601 **UTC**. BSD `date -j -f` parses in LOCAL
            # time, so without TZ=UTC the age comes out shifted by the UTC
            # offset — west of UTC that is *negative*, and a stale lock then
            # reads as fresh forever, wedging the tree. TZ=UTC pins the BSD
            # branch; Linux/CI falls through to GNU `date -u -d`, which honors
            # the trailing Z.
            _CO_AGE_MS=""
            if [[ -n "$_CO_HOLDER_STARTED" ]]; then
                _CO_STARTED_EPOCH=$(TZ=UTC date -j -f "%Y-%m-%dT%H:%M:%S" "${_CO_HOLDER_STARTED%%.*}" +%s 2>/dev/null \
                    || date -u -d "$_CO_HOLDER_STARTED" +%s 2>/dev/null || echo "")
                if [[ -n "$_CO_STARTED_EPOCH" ]]; then
                    _CO_AGE_MS=$(( ( $(date +%s) - _CO_STARTED_EPOCH ) * 1000 ))
                    # Negative age = clock skew between hosts. Treat as unknown
                    # rather than stale: refusing is recoverable, silently
                    # ignoring a live holder is not.
                    [[ "$_CO_AGE_MS" -lt 0 ]] && _CO_AGE_MS=""
                fi
            fi

            _CO_SKIP_PID=false
            grep -q '"skipPidCheck"[[:space:]]*:[[:space:]]*true' "$_CO_LOCK" 2>/dev/null && _CO_SKIP_PID=true

            # 0. Absolute ceiling, checked first and unconditionally (#856):
            #    past it a PID is no longer trustworthy identity.
            if [[ -n "$_CO_AGE_MS" && "$_CO_AGE_MS" -gt "$_CO_MAX_AGE_MS" ]]; then
                _CO_FRESH=false
            # 1. Same-host PID check is authoritative — unless the holder asked
            #    us to skip it (a skill shell whose PID dies after acquire).
            elif [[ "$_CO_HOLDER_HOST" == "$(hostname)" && "$_CO_SKIP_PID" == "false" ]]; then
                # `kill -0` is a bash builtin: no subprocess on the hot path.
                if [[ -n "$_CO_HOLDER_PID" ]] && ! kill -0 "$_CO_HOLDER_PID" 2>/dev/null; then
                    _CO_FRESH=false
                fi
            # 2. Cross-host or skipPidCheck: the PID is meaningless, use age.
            elif [[ -n "$_CO_AGE_MS" ]]; then
                if [[ "$_CO_SKIP_PID" == "true" ]]; then
                    _CO_TTL_MS="$_CO_SKILL_TTL_MS"
                else
                    _CO_TTL_MS="$_CO_STALE_AGE_MS"
                fi
                [[ "$_CO_AGE_MS" -gt "$_CO_TTL_MS" ]] && _CO_FRESH=false
            fi

            # Is this session the holder? sessionId is the only identity that
            # survives a skill shell exiting between acquire and this call, so
            # it wins when both sides have one. Otherwise fall back to the
            # issue this session is working on.
            _CO_IS_HOLDER=false
            if [[ -n "$_CO_HOLDER_SESSION" && -n "$SESSION_ID" ]]; then
                [[ "$_CO_HOLDER_SESSION" == "$SESSION_ID" ]] && _CO_IS_HOLDER=true
            elif [[ -n "${SEQUANT_ISSUE:-}" && -n "$_CO_HOLDER_ISSUE" ]]; then
                # Reachable only from a parent process that exported it — never
                # from a skill bash block (#906). Kept for `sequant run`-shaped
                # callers; the binding below is what works interactively.
                [[ "${SEQUANT_ISSUE}" == "$_CO_HOLDER_ISSUE" ]] && _CO_IS_HOLDER=true
            elif [[ -n "${SESSION_ID:-}" && -n "$_CO_HOLDER_ISSUE" ]]; then
                # The binding this hook recorded when it saw THIS session run
                # `locks checkout acquire --issue=N` (#906).
                _CO_BIND=$(_co_binding_path "$_CO_ROOT" "$SESSION_ID")
                [[ -f "$_CO_BIND" \
                   && "$(cat "$_CO_BIND" 2>/dev/null)" == "$_CO_HOLDER_ISSUE" ]] \
                    && _CO_IS_HOLDER=true
            fi

            if [[ "$_CO_FRESH" == "true" && "$_CO_IS_HOLDER" == "false" ]]; then
                log_block "checkout-lock"
                {
                    echo "HOOK_BLOCKED: Checkout held by another session"
                    echo ""
                    echo "  The working tree is held by the session working #${_CO_HOLDER_ISSUE:-?}"
                    echo "  (PID ${_CO_HOLDER_PID:-?} on ${_CO_HOLDER_HOST:-?}, started ${_CO_HOLDER_STARTED:-?})."
                    echo "  Command: ${_CO_HOLDER_CMD:-?}"
                    echo ""
                    echo "  Branch-mutating git here would race with that session."
                    echo ""
                    echo "  To proceed:"
                    echo "    • Work in your own worktree: ../worktrees/feature/<your-issue>-*/"
                    echo "      (create it with: ./scripts/new-feature.sh <your-issue>)"
                    echo "    • Or target it explicitly: git -C <worktree> <command>"
                    echo "    • If that session is gone: sequant locks checkout clear --force"
                } >&2
                exit 2
            fi
        fi
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
        # Resolve where to check for changes: the last resolvable `cd`
        # target if the command has one (multi-line commands included —
        # #963), else the command's own cwd from the hook payload (never
        # this hook process's own cwd, which need not match).
        TARGET_DIR=$(resolve_cd_target "$TOOL_INPUT")
        HAS_CD_LINE=false
        echo "$TOOL_INPUT" | grep -qE '^[[:space:]]*cd[[:space:]]+' && HAS_CD_LINE=true

        if [[ -n "$TARGET_DIR" ]]; then
            CHANGES=$(git -C "$TARGET_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
        elif [[ "$HAS_CD_LINE" == true ]]; then
            # A `cd` line is present but its target is dynamic (a shell
            # variable/command substitution) or doesn't exist as a
            # directory — fail open rather than check the wrong
            # directory. `git commit` itself already rejects a genuinely
            # empty commit, so this costs one harmless git error (#963).
            CHANGES=1
        else
            CHANGES=$(git -C "${HOOK_CWD:-$PWD}" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
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

# commit_message_from <segment> — print the message argument of the git
# commit in <segment>: the first body line for the
# `-m "$(cat <<'EOF' ... EOF)"` idiom, else the quoted string after the
# message flag (`-m`, a short-flag cluster ending in m such as `-am`,
# `--message=…` or `--message …`), else — when there is no quoted message
# flag at all — the first line of a heredoc feeding the commit (`-F-` /
# `--file=-`), which is what the guard validated before #981. Anchored on
# the `git commit` token and then on its own flag, scanning past quoted
# regions, so text elsewhere in the segment (an earlier quoted string — even
# one containing `-m` — or a heredoc body that precedes the commit inside the
# same subshell) can neither supply nor shadow the message (#981 root cause).
# Prints nothing for an editor commit or an unquoted message word; the guard
# then validates nothing, as before. The caller keeps only the first line
# (the subject) — a body line must never launder a non-conventional subject.
commit_message_from() {
    printf '%s' "$1" | awk '
    BEGIN { RS = "\001"; sq = sprintf("%c", 39); dq = sprintf("%c", 34) }
    # strip_comments(s) — same-length copy of s with every unquoted `#`
    # comment (at a word boundary) blanked to end-of-line, so neither the
    # `git commit` anchor nor the flag scan can land inside a comment.
    function strip_comments(s,    n, i, c, q, out) {
        n = length(s); out = ""; q = ""; i = 1
        while (i <= n) {
            c = substr(s, i, 1)
            if (q != "") {
                if (q == dq && c == "\\" && i < n) { out = out c substr(s, i + 1, 1); i += 2; continue }
                if (c == q) q = ""
                out = out c; i++; continue
            }
            if (c == dq || c == sq) { q = c; out = out c; i++; continue }
            if (c == "#" && (i == 1 || substr(s, i - 1, 1) ~ /[ \t\n;&|(]/)) {
                while (i <= n && substr(s, i, 1) != "\n") { out = out " "; i++ }
                continue
            }
            out = out c; i++
        }
        return out
    }
    function heredoc_first_line(s, from,    h, k, nl, rest, e, line) {
        h = index(substr(s, from), "<<"); if (h == 0) return ""
        k = from + h - 1 + 2
        if (substr(s, k, 1) == "<") return ""
        if (substr(s, k, 1) == "-") k++
        nl = index(substr(s, k), "\n"); if (nl == 0) return ""
        rest = substr(s, k + nl)
        e = index(rest, "\n")
        line = (e == 0) ? rest : substr(rest, 1, e - 1)
        sub(/^[ \t]+/, "", line)
        return line
    }
    # message_at(s, j, n) — the quoted argument starting at or after j (after
    # optional blanks): prints it and exits; returns silently when the
    # argument is unquoted (not validated, as before).
    function message_at(s, j, n,    q, msg, k, d, line) {
        while (j <= n && substr(s, j, 1) ~ /[ \t]/) j++
        q = substr(s, j, 1)
        # `-m "$( … <<DELIM … )"` — any spacing, any command path: the
        # message is the first body line of that heredoc. No heredoc inside the
        # substitution (or a `<<<` herestring): fall through to the generic
        # quoted reader below.
        if (q == dq && substr(s, j + 1, 2) == "$(") {
            line = heredoc_first_line(s, j)
            if (line != "") { print line; exit }
        }
        if (q == dq || q == sq) {
            msg = ""; k = j + 1
            while (k <= n) {
                d = substr(s, k, 1)
                if (q == dq && d == "\\" && k < n) { msg = msg substr(s, k + 1, 1); k += 2; continue }
                if (d == q) break
                msg = msg d; k++
            }
            print msg; exit
        }
    }
    {
        s = strip_comments($0); n = length(s)
        start = index(s, "git commit"); if (start == 0) exit
        i = start + 10
        while (i <= n) {
            c = substr(s, i, 1)
            if (c == dq || c == sq) {
                k = i + 1
                while (k <= n) {
                    d = substr(s, k, 1)
                    if (c == dq && d == "\\") { k += 2; continue }
                    if (d == c) break
                    k++
                }
                i = k + 1; continue
            }
            prev = (i > 1) ? substr(s, i - 1, 1) : " "
            if (c == "-" && prev ~ /[ \t]/) {
                if (substr(s, i, 9) == "--message") {
                    e = i + 9; a = substr(s, e, 1)
                    if (a == "=") { message_at(s, e + 1, n); i = e + 1; continue }
                    if (a == "" || a ~ /[ \t]/ || a == dq || a == sq) { message_at(s, e, n); i = e; continue }
                    i = e; continue
                }
                if (substr(s, i + 1, 1) ~ /[A-Za-z]/) {
                    e = i + 1
                    while (e <= n && substr(s, e, 1) ~ /[A-Za-z]/) e++
                    a = substr(s, e, 1)
                    if (substr(s, e - 1, 1) == "m" && (a == "" || a ~ /[ \t]/ || a == dq || a == sq)) {
                        message_at(s, e, n); i = e; continue
                    }
                    i = e; continue
                }
            }
            i++
        }
        line = heredoc_first_line(s, start)
        if (line != "") print line
    }'
}

# literal_assignment_value <name> <command> [<limit>] — print the value of
# the LAST `<name>=` assignment (`"…"`, `'…'`, or a bare word; first line of
# the value) that appears in CODE context in the first <limit> characters of
# <command> (whole command when <limit> is -1 or absent; a limit of 0 is a
# zero-width window — a commit that is the FIRST segment has nothing before it). Quoted strings, `#`
# comments and heredoc bodies are skipped as data, so `echo 'usage:
# MSG=updated ./s.sh'` or `# set MSG=updated` cannot supply a value — the
# same segment-scoping discipline the extractor itself follows (#981).
# Prints nothing when the command never assigns the name in code context.
literal_assignment_value() {
    printf '%s' "$2" | awk -v name="$1" -v limit="${3:--1}" '
    BEGIN { RS = "\001"; sq = sprintf("%c", 39); dq = sprintf("%c", 34) }
    {
        s = $0; n = length(s); if (limit >= 0 && limit < n) n = limit
        i = 1; found = ""; have = 0; L = length(name)
        while (i <= n) {
            c = substr(s, i, 1)
            if (c == dq || c == sq) {
                k = i + 1
                while (k <= n) { d = substr(s, k, 1); if (c == dq && d == "\\") { k += 2; continue }; if (d == c) break; k++ }
                i = k + 1; continue
            }
            if (c == "#" && (i == 1 || substr(s, i - 1, 1) ~ /[ \t\n;&|(]/)) {
                while (i <= n && substr(s, i, 1) != "\n") i++
                continue
            }
            if (c == "<" && substr(s, i + 1, 1) == "<" && substr(s, i + 2, 1) != "<") {
                j = i + 2; if (substr(s, j, 1) == "-") j++
                while (j <= n && substr(s, j, 1) ~ /[ \t]/) j++
                q = substr(s, j, 1); delim = ""
                if (q == sq || q == dq) { j++; while (j <= n && substr(s, j, 1) != q) { delim = delim substr(s, j, 1); j++ }; j++ }
                else { while (j <= n && substr(s, j, 1) ~ /[A-Za-z0-9_.-]/) { delim = delim substr(s, j, 1); j++ } }
                nl = index(substr(s, j), "\n"); if (nl == 0) break
                i = j + nl
                while (i <= n) {
                    e = index(substr(s, i), "\n")
                    line = (e == 0) ? substr(s, i) : substr(s, i, e - 1)
                    t = line; sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t)
                    i = (e == 0) ? n + 1 : i + e
                    if (t == delim) break
                }
                continue
            }
            if ((i == 1 || substr(s, i - 1, 1) ~ /[ \t\n;&|(]/) && substr(s, i, L + 1) == name "=") {
                k = i + L + 1; q = substr(s, k, 1); val = ""
                if (q == dq || q == sq) {
                    k++
                    while (k <= n) { d = substr(s, k, 1); if (q == dq && d == "\\" && k < n) { val = val substr(s, k + 1, 1); k += 2; continue }; if (d == q) break; val = val d; k++ }
                    k++
                } else {
                    while (k <= n && substr(s, k, 1) !~ /[ \t\n;&|)]/) { val = val substr(s, k, 1); k++ }
                }
                found = val; have = 1; i = k; continue
            }
            i++
        }
        if (have) { sub(/\n.*/, "", found); print found }
    }'
}
# resolve_message_ref <subject> <command> [<limit>] — a subject that is one
# bare variable reference resolves through literal_assignment_value over the
# command text BEFORE the commit segment (shell semantics: the last
# assignment before the commit is the one it carries); anything else passes
# through unchanged.
resolve_message_ref() {
    local subject="$1" input="$2" limit="${3:--1}"
    if [[ "$subject" =~ ^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$ ]]; then
        literal_assignment_value "${BASH_REMATCH[1]}" "$input" "$limit"
    else
        printf '%s\n' "$subject"
    fi
}
# --- Commit Message Validation (AC-3) ---
# Enforce conventional commits format: type(scope): description
# Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf
#
# validate_commit_subject <subject> — block (exit 2) unless <subject> is a
# conventional-commit line. An empty subject validates nothing (editor
# commits, unquoted -m words), as before.
validate_commit_subject() {
    local subject="$1"
    [[ -z "$subject" ]] && return 0
    # Conventional commits pattern: type(optional-scope): description
    # Also accepts ! for breaking changes: feat!: or feat(scope)!:
    local pattern='^(feat|fix|docs|style|refactor|test|chore|ci|build|perf)(\([^)]+\))?(!)?\s*:'
    if ! echo "$subject" | grep -qE "$pattern"; then
        log_block "commit-format"
        {
            echo "HOOK_BLOCKED: Commit must follow conventional commits format"
            echo "  Expected: type(scope): description"
            # AC-1 & AC-2 (Issue #198): Detect merge commits and provide helpful suggestion
            if [[ "$subject" == Merge\ * ]]; then
                echo ""
                echo "  💡 For merge commits, use: chore: merge main into feature branch"
                echo ""
            fi
            echo "  Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf"
            echo "  Got: $subject"
        } >&2
        exit 2
    fi
    return 0
}
if [[ "$TOOL_NAME" == "Bash" ]] && seg_match 'git commit'; then
    # Scope extraction to each git-commit segment itself (#981), never the
    # whole command, so an earlier quoted string or a heredoc elsewhere can
    # neither supply nor shadow a message. EVERY qualifying segment that
    # yields a message is validated (spec Open Question 2): a decoy
    # conventional commit earlier in a compound command must not let a later
    # non-conventional one through, and a -m-less segment that merely
    # mentions "git commit" cannot hide the real commit behind it. Extraction
    # is anchored on the segment's own message flag (-m / -am / --message,
    # the -m "$(cat <<'EOF' ... EOF)" idiom, or a heredoc feeding -F-), and
    # only the subject line is validated. Falls back to the whole command only
    # if the raw scan finds no segment at all (fail-safe, not fail-open).
    _validated=0
    while IFS= read -r -d $'\001' _seg || [[ -n "$_seg" ]]; do
        [[ -z "$_seg" ]] && continue
        _validated=1
        _before="${TOOL_INPUT%%"$_seg"*}"
        validate_commit_subject "$(resolve_message_ref "$(commit_message_from "$_seg" | head -n 1)" "$TOOL_INPUT" "${#_before}")"
    done < <(raw_commit_segment "$TOOL_INPUT")
    if [[ "$_validated" -eq 0 ]]; then
        validate_commit_subject "$(resolve_message_ref "$(commit_message_from "$TOOL_INPUT" | head -n 1)" "$TOOL_INPUT" -1)"
    fi
fi

# Resolve a path to its canonical form, tolerating components that do not exist
# yet. Plain `realpath` fails outright on a missing path, and BSD/macOS realpath
# has no `-m`. The old code fell back to the raw string on failure, which broke
# the comparison below whenever the worktree path crossed a symlink: a Write
# creating a NEW file resolved to nothing (raw "/tmp/.../x.ts") while the
# existing worktree dir resolved through the symlink ("/private/tmp/.../"), so
# the prefix test failed and writes *inside* the worktree were blocked. macOS
# hits this every time, since /tmp is a symlink to /private/tmp.
#
# Walk up to the nearest existing ancestor, canonicalise that, then re-append
# the missing tail so both sides normalise identically.
resolve_path_allow_missing() {
    local p="$1"
    local suffix=""

    while [[ ! -e "$p" && "$p" != "/" && "$p" != "." && -n "$p" ]]; do
        suffix="/$(basename "$p")$suffix"
        local parent
        parent="$(dirname "$p")"
        [[ "$parent" == "$p" ]] && break
        p="$parent"
    done

    local resolved
    resolved="$(realpath "$p" 2>/dev/null || echo "$p")"
    # Avoid a doubled slash when the resolved ancestor is "/"
    [[ "$resolved" == "/" ]] && resolved=""
    echo "${resolved}${suffix}"
}

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

    # Priority 2: Fall back to parallel marker file. The glob prefix is already
    # scoped to this project's hash (#881, AC-2), so a foreign project's marker
    # is not matched here. As defense-in-depth (AC-3), also verify the marker's
    # stored owning project root (line 2) matches the current one before trusting
    # it — a stale or hand-placed marker with a colliding name is ignored rather
    # than allowed to redirect enforcement.
    if [[ -z "$EXPECTED_WORKTREE" ]]; then
        for marker in "${PARALLEL_MARKER_PREFIX}"*.marker; do
            if [[ -f "$marker" ]]; then
                MARKER_PROJECT_ROOT=$(sed -n '2p' "$marker" 2>/dev/null || true)
                if [[ -n "$MARKER_PROJECT_ROOT" && -n "$PARALLEL_MARKER_PROJECT_ROOT" \
                      && "$MARKER_PROJECT_ROOT" != "$PARALLEL_MARKER_PROJECT_ROOT" ]]; then
                    # Foreign owner — ignore this marker entirely.
                    continue
                fi
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
            # Resolve to canonical absolute paths for consistent comparison.
            # resolve_path_allow_missing (defined above) tolerates a file that
            # does not exist yet; a bare `realpath` fallback-to-raw-string broke
            # new-file Writes whenever the worktree path crossed a symlink
            # (macOS /tmp -> /private/tmp): the new file stayed raw while the
            # existing worktree dir resolved, so the prefix test always failed.
            REAL_FILE_PATH=$(resolve_path_allow_missing "$FILE_PATH")
            REAL_WORKTREE=$(resolve_path_allow_missing "$EXPECTED_WORKTREE")

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
