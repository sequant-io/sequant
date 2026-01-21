#!/bin/bash
# Post-tool hook for Claude Code
# - Timing instrumentation (END timestamp to pair with pre-tool START)
# - Auto-formatting for code quality
# - Quality observability (test/build failures, SQL queries)
# - Smart test running (P3): Runs related tests after file edits (opt-in)
# - Webhook notifications (P3): Notifies on issue close (opt-in)
# Runs AFTER each tool completes

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
    TOOL_OUTPUT=$(echo "$INPUT_JSON" | jq -r '.tool_response | tostring // empty')
else
    TOOL_NAME=$(echo "$INPUT_JSON" | grep -oE '"tool_name"\s*:\s*"[^"]+"' | head -1 | cut -d'"' -f4)
    # For Bash tool, extract command from tool_input; for others, extract the whole object
    if [[ "$TOOL_NAME" == "Bash" ]]; then
        TOOL_INPUT=$(echo "$INPUT_JSON" | grep -oE '"command"\s*:\s*"[^"]+"' | head -1 | cut -d'"' -f4)
    else
        TOOL_INPUT=$(echo "$INPUT_JSON" | grep -oE '"tool_input"\s*:\s*\{[^}]+\}' | head -1)
    fi
    TOOL_OUTPUT=$(echo "$INPUT_JSON" | grep -oE '"tool_response"\s*:\s*\{[^}]+\}' | head -1)
fi

TIMING_LOG="/tmp/claude-timing.log"
QUALITY_LOG="/tmp/claude-quality.log"
TESTS_LOG="/tmp/claude-tests.log"
PARALLEL_MARKER_PREFIX="/tmp/claude-parallel-"

# === AGENT ID DETECTION ===
# For parallel agents, detect group ID from marker files
# Format: /tmp/claude-parallel-<group-id>.marker
AGENT_ID=""
IS_PARALLEL_AGENT="false"
for marker in "${PARALLEL_MARKER_PREFIX}"*.marker; do
    if [[ -f "$marker" ]]; then
        # Extract group ID from marker filename
        AGENT_ID=$(basename "$marker" | sed 's/claude-parallel-//' | sed 's/\.marker//')
        IS_PARALLEL_AGENT="true"
        break
    fi
done

# === TIMING END ===
# Include agent ID in log format if available (AC-4)
if [[ -n "$AGENT_ID" ]]; then
    echo "$(date +%s.%N) [$AGENT_ID] END $TOOL_NAME" >> "$TIMING_LOG"
else
    echo "$(date +%s.%N) END $TOOL_NAME" >> "$TIMING_LOG"
fi

# === LOG ROTATION FOR QUALITY LOG ===
# Rotate if over 1000 lines to prevent unbounded growth
if [[ -f "$QUALITY_LOG" ]]; then
    LINE_COUNT=$(wc -l < "$QUALITY_LOG" 2>/dev/null || echo 0)
    if [[ "$LINE_COUNT" -gt 1000 ]]; then
        tail -500 "$QUALITY_LOG" > "${QUALITY_LOG}.tmp" && mv "${QUALITY_LOG}.tmp" "$QUALITY_LOG"
    fi
fi

# === LOG ROTATION FOR TESTS LOG ===
if [[ -f "$TESTS_LOG" ]]; then
    LINE_COUNT=$(wc -l < "$TESTS_LOG" 2>/dev/null || echo 0)
    if [[ "$LINE_COUNT" -gt 1000 ]]; then
        tail -500 "$TESTS_LOG" > "${TESTS_LOG}.tmp" && mv "${TESTS_LOG}.tmp" "$TESTS_LOG"
    fi
fi

# === JSON PARSING HELPER ===
# Try jq first for reliable JSON parsing, fall back to grep for simpler systems
extract_file_path() {
    local input="$1"
    local path=""

    if command -v jq &>/dev/null; then
        path=$(echo "$input" | jq -r '.file_path // empty' 2>/dev/null)
    fi

    # Fallback to grep if jq fails or isn't available
    if [[ -z "$path" ]]; then
        path=$(echo "$input" | grep -oE '"file_path"\s*:\s*"[^"]+"' | head -1 | cut -d'"' -f4)
    fi

    echo "$path"
}

# === SECURITY WARNING LOGGING (AC-3 for Issue #492) ===
# Log warnings (don't block) for dangerous patterns in edited/written files
# These are not blocking because there may be legitimate uses, but should be reviewed
check_security_patterns() {
    local content="$1"
    local file_path="$2"
    local warnings=()

    # dangerouslyDisableSandbox usage (Bash tool security bypass)
    if echo "$content" | grep -qE 'dangerouslyDisableSandbox.*true'; then
        warnings+=("dangerouslyDisableSandbox=true (Bash security bypass)")
    fi

    # eval() usage (dynamic code execution - XSS/injection risk)
    if echo "$content" | grep -qE '\beval\s*\('; then
        warnings+=("eval() usage (dynamic code execution)")
    fi

    # innerHTML assignment (XSS vulnerability without sanitization)
    if echo "$content" | grep -qE '\.innerHTML\s*='; then
        warnings+=("innerHTML assignment (potential XSS)")
    fi

    # SQL string concatenation (SQL injection risk)
    # Look for patterns like: query + variable or `SELECT ... ${variable}`
    if echo "$content" | grep -qE "(query|sql|SQL)\s*\+\s*|query\s*=.*\\\$\{"; then
        warnings+=("SQL string concatenation (potential injection)")
    fi

    # Log any warnings found
    for warning in "${warnings[@]}"; do
        echo "$(date +%H:%M:%S) SECURITY_WARNING: $warning in $file_path" >> "$QUALITY_LOG"
    done
}

if [[ "${CLAUDE_HOOKS_SECURITY:-true}" != "false" ]]; then
    if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
        FILE_PATH=$(extract_file_path "$TOOL_INPUT")

        if [[ -n "$FILE_PATH" && -f "$FILE_PATH" ]]; then
            # Only check TypeScript/JavaScript files for security patterns
            if [[ "$FILE_PATH" =~ \.(ts|tsx|js|jsx)$ ]]; then
                FILE_CONTENT=$(cat "$FILE_PATH" 2>/dev/null || true)
                if [[ -n "$FILE_CONTENT" ]]; then
                    check_security_patterns "$FILE_CONTENT" "$FILE_PATH"
                fi
            fi
        fi
    fi
fi

# === AUTO-FORMAT ON FILE WRITE ===
# Skip auto-formatting for parallel agents (AC-5)
# Parent agent will format after the parallel group completes
if [[ "$IS_PARALLEL_AGENT" == "true" ]]; then
    # Log that formatting was skipped for parallel agent
    if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
        FILE_PATH=$(extract_file_path "$TOOL_INPUT")
        if [[ -n "$FILE_PATH" ]]; then
            echo "$(date +%H:%M:%S) SKIP_FORMAT (parallel): $FILE_PATH" >> "$QUALITY_LOG"
        fi
    fi
elif [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
    FILE_PATH=$(extract_file_path "$TOOL_INPUT")

    if [[ -n "$FILE_PATH" && -f "$FILE_PATH" ]]; then
        # Auto-format TypeScript/JavaScript files (synchronous to avoid race conditions)
        if [[ "$FILE_PATH" =~ \.(ts|tsx|js|jsx)$ ]]; then
            if npx prettier --write "$FILE_PATH" 2>/dev/null; then
                echo "$(date +%H:%M:%S) FORMATTED: $FILE_PATH" >> "$QUALITY_LOG"
            fi
        fi

        # Auto-format JSON files (synchronous)
        if [[ "$FILE_PATH" =~ \.json$ ]]; then
            npx prettier --write "$FILE_PATH" 2>/dev/null
        fi
    fi
fi

# === TRACK GIT OPERATIONS ===
if [[ "$TOOL_NAME" == "Bash" ]]; then
    if echo "$TOOL_INPUT" | grep -qE 'git (commit|push|pr create)'; then
        # Truncate long git commands for readability
        GIT_CMD=$(echo "$TOOL_INPUT" | head -c 200)
        echo "$(date +%H:%M:%S) GIT: $GIT_CMD" >> "$QUALITY_LOG"
    fi
fi

# === DETECT TEST FAILURES ===
if [[ "$TOOL_NAME" == "Bash" ]] && echo "$TOOL_INPUT" | grep -qE 'npm (test|run test)'; then
    if echo "$TOOL_OUTPUT" | grep -qE '(FAIL|failed|Error:)'; then
        echo "$(date +%H:%M:%S) TEST_FAILURE detected" >> "$QUALITY_LOG"
    fi
fi

# === DETECT BUILD FAILURES ===
if [[ "$TOOL_NAME" == "Bash" ]] && echo "$TOOL_INPUT" | grep -qE 'npm run build'; then
    if echo "$TOOL_OUTPUT" | grep -qE '(error TS|Build failed|Error:)'; then
        echo "$(date +%H:%M:%S) BUILD_FAILURE detected" >> "$QUALITY_LOG"
    fi
fi

# === TEST COVERAGE ANALYSIS (P3) ===
# Opt-in: Set CLAUDE_HOOKS_COVERAGE=true to enable
# Automatically appends coverage analysis to npm test output
# Logs which changed files have/don't have corresponding tests
if [[ "${CLAUDE_HOOKS_COVERAGE:-}" == "true" ]]; then
    if [[ "$TOOL_NAME" == "Bash" ]] && echo "$TOOL_INPUT" | grep -qE 'npm (test|run test)'; then
        # Only run if tests passed (don't clutter failure output)
        if ! echo "$TOOL_OUTPUT" | grep -qE '(FAIL|failed|Error:)'; then
            COVERAGE_LOG="/tmp/claude-coverage.log"

            # Get changed source files (excluding tests)
            changed_files=$(git diff main...HEAD --name-only 2>/dev/null | grep -E '\.(ts|tsx|js|jsx)$' | grep -v -E '\.test\.|\.spec\.|__tests__' || true)

            if [[ -n "$changed_files" ]]; then
                echo "$(date +%H:%M:%S) COVERAGE_ANALYSIS: Checking test coverage for changed files" >> "$QUALITY_LOG"

                files_with_tests=0
                files_without_tests=0
                critical_without_tests=""

                while IFS= read -r file; do
                    [[ -z "$file" ]] && continue
                    base=$(basename "$file" .ts | sed 's/\.tsx$//')

                    # Check for test file
                    has_test="no"
                    if find . -name "${base}.test.*" -o -name "${base}.spec.*" 2>/dev/null | grep -q .; then
                        has_test="yes"
                        ((files_with_tests++))
                    else
                        ((files_without_tests++))
                        # Check if critical path
                        if echo "$file" | grep -qE 'auth|payment|security|server-action|middleware|admin'; then
                            critical_without_tests="$critical_without_tests $file"
                        fi
                    fi
                done <<< "$changed_files"

                total=$((files_with_tests + files_without_tests))

                # Log coverage summary
                echo "$(date +%H:%M:%S) COVERAGE: $files_with_tests/$total changed files have tests" >> "$COVERAGE_LOG"

                if [[ -n "$critical_without_tests" ]]; then
                    echo "$(date +%H:%M:%S) ⚠️ CRITICAL_NO_TESTS:$critical_without_tests" >> "$COVERAGE_LOG"
                    echo "$(date +%H:%M:%S) CRITICAL_NO_TESTS:$critical_without_tests" >> "$QUALITY_LOG"
                fi

                if [[ $files_without_tests -gt 0 ]]; then
                    echo "$(date +%H:%M:%S) COVERAGE_GAP: $files_without_tests files without tests" >> "$QUALITY_LOG"
                fi
            fi
        fi
    fi
fi

# === SMART TEST RUNNING (P3) ===
# Opt-in: Set CLAUDE_HOOKS_SMART_TESTS=true to enable
# Runs related tests asynchronously after file edits
if [[ "${CLAUDE_HOOKS_SMART_TESTS:-}" == "true" ]]; then
    if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
        FILE_PATH=$(extract_file_path "$TOOL_INPUT")

        if [[ -n "$FILE_PATH" && "$FILE_PATH" =~ \.(ts|tsx)$ ]]; then
            # Extract filename without extension (use -E for macOS sed compatibility)
            FILENAME=$(basename "$FILE_PATH" | sed -E 's/\.(ts|tsx)$//')

            # Find related test file in __tests__/ directory
            # This project uses centralized tests, not co-located
            PROJECT_ROOT="${FILE_PATH%%/lib/*}"
            if [[ "$PROJECT_ROOT" == "$FILE_PATH" ]]; then
                PROJECT_ROOT="${FILE_PATH%%/components/*}"
            fi
            if [[ "$PROJECT_ROOT" == "$FILE_PATH" ]]; then
                PROJECT_ROOT="${FILE_PATH%%/app/*}"
            fi

            # Search for test files matching the source file name
            TEST_FILE=""
            if [[ -d "$PROJECT_ROOT/__tests__" ]]; then
                # Try direct match first
                if [[ -f "$PROJECT_ROOT/__tests__/${FILENAME}.test.ts" ]]; then
                    TEST_FILE="$PROJECT_ROOT/__tests__/${FILENAME}.test.ts"
                elif [[ -f "$PROJECT_ROOT/__tests__/${FILENAME}.test.tsx" ]]; then
                    TEST_FILE="$PROJECT_ROOT/__tests__/${FILENAME}.test.tsx"
                # Try integration tests
                elif [[ -f "$PROJECT_ROOT/__tests__/integration/${FILENAME}.test.ts" ]]; then
                    TEST_FILE="$PROJECT_ROOT/__tests__/integration/${FILENAME}.test.ts"
                elif [[ -f "$PROJECT_ROOT/__tests__/integration/${FILENAME}.test.tsx" ]]; then
                    TEST_FILE="$PROJECT_ROOT/__tests__/integration/${FILENAME}.test.tsx"
                fi
            fi

            if [[ -n "$TEST_FILE" && -f "$TEST_FILE" ]]; then
                echo "$(date +%H:%M:%S) SMART_TEST: Running $TEST_FILE for $FILE_PATH" >> "$TESTS_LOG"

                # Run test asynchronously to avoid blocking
                # Use timeout/gtimeout if available, otherwise run without timeout
                (
                    cd "$PROJECT_ROOT" 2>/dev/null || exit
                    TIMEOUT_CMD=""
                    if command -v timeout &>/dev/null; then
                        TIMEOUT_CMD="timeout 30"
                    elif command -v gtimeout &>/dev/null; then
                        TIMEOUT_CMD="gtimeout 30"
                    fi
                    $TIMEOUT_CMD npm test -- --testPathPatterns="$(basename "$TEST_FILE")" --silent 2>&1 | head -20 >> "$TESTS_LOG"
                    if [[ ${PIPESTATUS[0]} -ne 0 ]]; then
                        echo "$(date +%H:%M:%S) SMART_TEST_RESULT: FAIL" >> "$TESTS_LOG"
                    else
                        echo "$(date +%H:%M:%S) SMART_TEST_RESULT: PASS" >> "$TESTS_LOG"
                    fi
                ) &
            fi
        fi
    fi
fi

# === WEBHOOK NOTIFICATIONS (P3) ===
# Opt-in: Set CLAUDE_HOOKS_WEBHOOK_URL to enable
# Fires notification when issues are closed
if [[ -n "${CLAUDE_HOOKS_WEBHOOK_URL:-}" ]]; then
    if [[ "$TOOL_NAME" == "Bash" ]] && echo "$TOOL_INPUT" | grep -qE 'gh issue close'; then
        # Extract issue number
        ISSUE_NUM=$(echo "$TOOL_INPUT" | grep -oE '#?[0-9]+' | head -1 | tr -d '#')

        if [[ -n "$ISSUE_NUM" ]]; then
            echo "$(date +%H:%M:%S) WEBHOOK: Notifying issue #$ISSUE_NUM closed" >> "$QUALITY_LOG"

            # Fire-and-forget async curl (don't block on webhook failures)
            (
                curl -s -X POST "$CLAUDE_HOOKS_WEBHOOK_URL" \
                    -H 'Content-Type: application/json' \
                    -d "{\"text\":\"Issue #$ISSUE_NUM completed by Claude Code automation\"}" \
                    --max-time 5 2>/dev/null || true
            ) &
        fi
    fi
fi

exit 0
