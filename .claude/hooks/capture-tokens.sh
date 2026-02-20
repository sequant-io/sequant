#!/bin/bash
# SessionEnd hook: Parse transcript JSONL for token usage (AC-5)
#
# This hook runs at the end of each Claude Code session and extracts
# token usage from the transcript file. The data is written to a
# JSON file that sequant run.ts can read for metrics.
#
# Input (via stdin): JSON object with session info including transcript_path
# Output: Token usage JSON written to .sequant/.token-usage-<session_id>.json
#
# Fields captured per ccusage project:
# - input_tokens
# - output_tokens
# - cache_creation_input_tokens
# - cache_read_input_tokens

set -e

# Read input from stdin
INPUT=$(cat)

# Extract transcript path and session ID from input
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')

# Exit early if no transcript path
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi

# Generate a session ID if not provided
if [ -z "$SESSION_ID" ]; then
  SESSION_ID=$(date +%s%N)
fi

# Sum token fields from JSONL messages
# The transcript is a JSONL file where each line may contain usage data
TOTALS=$(cat "$TRANSCRIPT" | jq -s '
  [.[] | .usage // empty] |
  {
    input_tokens: (map(.input_tokens // 0) | add // 0),
    output_tokens: (map(.output_tokens // 0) | add // 0),
    cache_creation_tokens: (map(.cache_creation_input_tokens // 0) | add // 0),
    cache_read_tokens: (map(.cache_read_input_tokens // 0) | add // 0),
    session_id: "'"$SESSION_ID"'",
    timestamp: (now | todate)
  }
' 2>/dev/null)

# Exit if jq parsing failed
if [ -z "$TOTALS" ]; then
  exit 0
fi

# Ensure .sequant directory exists
mkdir -p .sequant

# Write to known location for sequant to pick up
TOKEN_FILE=".sequant/.token-usage-${SESSION_ID}.json"
echo "$TOTALS" > "$TOKEN_FILE"

exit 0
