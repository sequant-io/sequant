---
name: verify
description: Execution verification for CLI/script features — runs commands and captures output for human review. Use after /exec for script changes.
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Bash(*)
  - Read
  - Glob
  - Grep
  - AskUserQuestion
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
---

# Execution Verification

You are the "Execution Verification Agent" for the current repository.

## Purpose

When invoked as `/verify`, your job is to:

1. Run the specified command for a CLI/script feature.
2. Capture and display the command output (stdout/stderr).
3. Prompt for human confirmation that output matches expected behavior.
4. Post verification evidence to the GitHub issue.

This is the CLI equivalent of `/test` (which handles UI features via browser testing).

## When to Use

Use `/verify` for:
- New scripts in `scripts/`
- CLI tool changes
- Automation features
- Anything with terminal output as primary interface

## Invocation

```bash
# With explicit command
/verify 559 --command "npx tsx scripts/migrate.ts --dry-run"

# With issue only (will prompt for command)
/verify 559
```

## Behavior

### 1. Parse Arguments

Extract from the invocation:
- **Issue number:** The GitHub issue being verified
- **Command:** The command to execute (from `--command` flag or prompted)

If no command provided:
```
Ask: "What command should I run to verify this feature?"
```

### 2. Verify Issue Context

```bash
# Get issue details
gh issue view <issue-number> --json title,body,labels
```

Confirm this is a CLI/script feature by checking:
- Issue title/body mentions scripts, CLI, automation
- Files changed include `scripts/` directory
- Not a UI-only feature

### 3. Execute Command

Run the specified command with a timeout:

```bash
# Run with 2-minute timeout, capture both stdout and stderr
timeout 120 <command> 2>&1
```

**Timeout handling:**
- Default: 2 minutes (120 seconds)
- If command exceeds timeout, capture partial output and note timeout

**Output capture:**
- Capture both stdout and stderr
- Truncate at 500 lines to prevent oversized GitHub comments
- Preserve formatting (colors stripped for readability)

### 4. Display Output

Present the captured output to the user:

```markdown
## Execution Output

**Command:** `<command>`
**Exit code:** <0 or error code>
**Duration:** <X seconds>

<details>
<summary>Output (X lines)</summary>

```
[captured output here]
```

</details>
```

### 5. Prompt for Confirmation

Use AskUserQuestion to get human confirmation:

```
Question: Does this output match expected behavior for the feature?

Options:
- Yes, looks correct
- Partially - some issues but acceptable
- No, something is wrong
```

### 6. Handle Confirmation Response

**If "Yes" or "Partially":**
- Prepare verification evidence comment for GitHub
- Include: command, exit code, output summary, human confirmation

**If "No":**
- Ask for details about what's wrong
- Do NOT post verification (feature needs fixes)
- Suggest running `/exec` to address issues

### 7. Post Verification to GitHub Issue

Post a comment with verification evidence:

```markdown
## Execution Verification

**Command:** `<command>`
**Result:** Verified by human review

<details>
<summary>Execution Output (click to expand)</summary>

**Exit code:** <code>
**Duration:** <duration>

```
[truncated output - first 100 lines]
```

[Output truncated at 100 lines - X total lines captured]

</details>

**Human Confirmation:**
> <confirmation response and any notes>

---
*Verified by `/verify` command*
```

### 8. Exit Code Handling

Handle non-zero exit codes gracefully:

| Exit Code | Interpretation |
|-----------|----------------|
| 0 | Success |
| 1-125 | Command failed (show error output) |
| 124 | Timeout (command exceeded 2 minutes) |
| 126 | Permission denied |
| 127 | Command not found |

For non-zero exits:
- Still display output
- Still ask for confirmation (failure might be expected for testing error paths)
- Note the failure in the verification comment

## Output Truncation

To prevent oversized GitHub comments (64KB limit):

1. Capture full output to temp file
2. Count lines
3. If > 500 lines:
   - Show first 100 lines in comment
   - Note: "[Output truncated at 100 lines - X total lines captured]"
4. Preserve full output locally for reference

## Examples

### Example 1: Successful Verification

```bash
/verify 558 --command "npx tsx scripts/migrate.ts --dry-run"
```

Output:
```
Starting migration (dry run)...
Checking tables...
Migration plan: 3 tables, 5 columns
...
Completed successfully
```

Human confirms: "Yes, looks correct"

-> Posts verification evidence to issue #558

### Example 2: Command Failure (Expected)

```bash
/verify 559 --command "npx tsx scripts/dev/test-error-handling.ts --trigger-error"
```

Output:
```
Triggering intentional error...
Error: Test error triggered as expected
Exit code: 1
```

Human confirms: "Yes, this error was expected - testing error handling"

-> Posts verification evidence noting expected failure

### Example 3: No Command Provided

```bash
/verify 560
```

Agent prompts: "What command should I run to verify this feature?"

User provides: "npx tsx scripts/audit/check-coverage.ts nashville"

-> Proceeds with verification

## Integration with /qa

The `/qa` skill will:
1. Detect when `scripts/` files are modified
2. Prompt to run `/verify` before `READY_FOR_MERGE`
3. Check for "Execution Verification" section in issue comments

This ensures CLI/script features are actually tested, not just code-reviewed.

## Error Recovery

If verification fails due to infrastructure issues:

1. **Network timeout:** Retry once, then note as infrastructure issue
2. **Missing dependencies:** Run `npm install` and retry
3. **Environment issues:** Check for `.env.local` and required vars
4. **File not found:** Verify worktree is correct, check file paths

Report infrastructure issues separately from feature issues.
