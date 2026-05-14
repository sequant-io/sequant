#!/bin/bash
# Relay check (#383): sourced from post-tool.sh on every PostToolUse when
# SEQUANT_RELAY=true. Reads unread user messages from inbox.jsonl, renders the
# framing prompt to stdout (which Claude Code surfaces as additional context),
# and advances the per-issue read cursor.
#
# Fast path (no pending messages): exits silently in well under 5 ms.
# Slow path (messages pending): renders one framing block per invocation.

# Opt-in guard. Fast path #1: env var unset / not exactly "true".
# Bash precedence makes `cmd1 && cmd2 || cmd3` equivalent to `(cmd1 && cmd2) || cmd3`,
# so we must use an explicit `if` block to avoid falling through to `exit 0`
# when the test is FALSE (which is the relay-enabled case).
if [[ "${SEQUANT_RELAY:-}" != "true" ]]; then
    return 0 2>/dev/null || exit 0
fi

# Resolve relay directory. Inside an isolated worktree, the phase-executor sets
# SEQUANT_WORKTREE. During the spec phase (main repo) we fall back to the
# per-issue layout under .sequant/relay/<issue>/.
if [[ -n "${SEQUANT_WORKTREE:-}" ]]; then
  _RELAY_DIR="${SEQUANT_WORKTREE}/.sequant/relay"
elif [[ -n "${SEQUANT_ISSUE:-}" ]]; then
  _RELAY_DIR="${PWD}/.sequant/relay/${SEQUANT_ISSUE}"
else
  # Nothing to do without a target issue or worktree.
  return 0 2>/dev/null || exit 0
fi

_INBOX="${_RELAY_DIR}/inbox.jsonl"
_CURSOR="${_RELAY_DIR}/.cursor"

# Fast path #2: AC-8 — `test -s` is sub-millisecond. Empty/missing inbox skips.
[[ -s "${_INBOX}" ]] || return 0 2>/dev/null || exit 0

# Cursor read (missing → 0). Compare against current inbox line count.
_CURSOR_VAL=0
if [[ -f "${_CURSOR}" ]]; then
  _CURSOR_VAL=$(cat "${_CURSOR}" 2>/dev/null || echo 0)
  [[ "${_CURSOR_VAL}" =~ ^[0-9]+$ ]] || _CURSOR_VAL=0
fi

_INBOX_LINES=$(wc -l < "${_INBOX}" 2>/dev/null || echo 0)
_INBOX_LINES=${_INBOX_LINES// /} # trim whitespace from wc output on macOS

# Fast path #3: cursor caught up.
if [[ "${_INBOX_LINES}" -le "${_CURSOR_VAL}" ]]; then
  return 0 2>/dev/null || exit 0
fi

# Slow path: render frame.

# Resolve frame template. Phase-executor sets SEQUANT_RELAY_FRAME to the
# absolute path within the sequant installation. Falls back to ./templates/
# (when running from the sequant repo itself).
_FRAME_PATH="${SEQUANT_RELAY_FRAME:-}"
if [[ -z "${_FRAME_PATH}" || ! -f "${_FRAME_PATH}" ]]; then
  for _candidate in \
      "${PWD}/.claude/relay/frame.txt" \
      "${PWD}/templates/relay/frame.txt"; do
    if [[ -f "${_candidate}" ]]; then
      _FRAME_PATH="${_candidate}"
      break
    fi
  done
fi
if [[ -z "${_FRAME_PATH}" || ! -f "${_FRAME_PATH}" ]]; then
  # Missing template — emit a minimal frame so the user still gets through.
  _FRAME_PATH=""
fi

# Skip the lines we've already shown the model. `tail -n +N` is 1-indexed.
_START=$((_CURSOR_VAL + 1))

# Render messages. Sort by timestamp ascending (AC-9). jq handles JSON parsing.
# Messages are separated by `---` lines; a single message has no separator.
_render_messages() {
  if command -v jq &>/dev/null; then
    tail -n "+${_START}" "${_INBOX}" \
      | jq -s -r 'sort_by(.timestamp) | map("Type: \(.type)\nMessage: \((.message // "") | tojson)") | join("\n---\n")'
  else
    # Fallback without jq: dump raw lines.
    tail -n "+${_START}" "${_INBOX}"
  fi
}

if [[ -n "${_FRAME_PATH}" ]]; then
  # Split frame template at {{MESSAGES}} placeholder.
  _PREFIX=$(awk '/\{\{MESSAGES\}\}/ {exit} {print}' "${_FRAME_PATH}")
  _SUFFIX=$(awk '/\{\{MESSAGES\}\}/ {found=1; next} found {print}' "${_FRAME_PATH}")
  printf '%s\n' "${_PREFIX}"
  _render_messages
  if [[ -n "${_SUFFIX}" ]]; then
    printf '%s\n' "${_SUFFIX}"
  fi
else
  printf '[SEQUANT RELAY — message from user]\n'
  _render_messages
fi

# Advance cursor atomically (temp + rename on same fs).
_TMP="${_CURSOR}.tmp.$$"
if printf '%s' "${_INBOX_LINES}" > "${_TMP}" 2>/dev/null; then
  mv -f "${_TMP}" "${_CURSOR}" 2>/dev/null || rm -f "${_TMP}" 2>/dev/null || true
fi

return 0 2>/dev/null || exit 0
