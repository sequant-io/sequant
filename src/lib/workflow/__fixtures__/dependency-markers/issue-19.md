## Summary

The `sequant run` command doesn't work because it tries to invoke skills via CLI syntax (`/spec`, `/exec`) in print mode, which is not supported. Skills are model-invoked, not command-invoked. Additionally, it's missing key features from the old `execute-issues.ts` script.

## Current (Broken) Implementation

```typescript
// src/commands/run.ts:81-89
const proc = spawn(
  "claude",
  ["--print", "--dangerously-skip-permissions", "-p", command],  // command = "/spec 5"
  { ... }
);
```

**Problem:** Slash commands like `/spec` only work in interactive mode. In `-p` mode, Claude expects natural language prompts and chooses skills based on task description matching.

## Root Cause

From Claude Code docs:
> "Slash commands like `/commit` are only available in interactive mode. In `-p` mode, describe the task you want to accomplish instead."

## Solution

Rewrite `sequant run` using the **Claude Agent SDK** TypeScript library:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const phasePrompts = {
  'spec': 'Review GitHub issue #{issue} and create implementation plan with verification criteria',
  'exec': 'Implement the feature for issue #{issue} following the spec',
  'qa': 'Review implementation for issue #{issue} against acceptance criteria'
};

async function executePhase(issueNumber: number, phase: Phase) {
  const prompt = phasePrompts[phase].replace('{issue}', String(issueNumber));
  
  for await (const message of query({
    prompt,
    options: {
      settingSources: ['project'],  // Loads .claude/skills/
      permissionMode: 'bypassPermissions',
      allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep', 'Task']
    }
  })) {
    if (message.type === 'result') {
      return { success: true, result: message.result };
    }
  }
}
```

---

## New Features to Add

### 1. Quality Loop (`--quality-loop`)
Auto-retry failed phases with fix iterations:
```bash
sequant run 12 --quality-loop
sequant run 12 --quality-loop --max-iterations 3
```

Behavior:
- After `/exec`, if tests fail → run `/loop` to fix → retry (up to N iterations)
- After `/qa`, if issues found → run `/loop` to fix → retry
- Exit when all phases pass or max iterations reached

### 2. Batch Execution (`--batch`)
Run groups of issues sequentially while issues within a batch run in parallel:
```bash
sequant run --batch "12 13" --batch "14 15"
```

Use case: Issue 14 depends on 12+13 being merged first.

### 3. Smart Tests Integration (`--smart-tests` / `--no-smart-tests`)
Auto-run related tests after file edits during `/exec`:
```bash
sequant run 12 --smart-tests        # Enable (could be default)
sequant run 12 --no-smart-tests     # Disable for speed
```

### 4. Auto-detect UI Issues
Automatically add `/test` phase if issue has `ui`, `frontend`, or `admin` labels:
```bash
sequant run 12  # Auto-detects labels and adjusts phases
```

### 5. Testgen Integration (`--testgen`)
Run `/testgen` after `/spec` to generate test stubs before implementation:
```bash
sequant run 12 --testgen
sequant run 12 --quality-loop  # Could auto-include testgen
```

---

## Proposed CLI Interface

```bash
# Basic
sequant run 12

# With quality loop (auto-fix iterations)
sequant run 12 --quality-loop
sequant run 12 -q  # Short form

# Batch execution
sequant run --batch "12 13" --batch "14"

# Full options
sequant run 12 \
  --quality-loop \
  --max-iterations 3 \
  --phases spec,exec,test,qa \
  --testgen \
  --smart-tests \
  --verbose

# Speed mode (no smart tests, no quality loop)
sequant run 12 13 14 --no-smart-tests
```

---

## Acceptance Criteria

### Core Rewrite (Agent SDK)
- [ ] AC-1: Install `@anthropic-ai/claude-agent-sdk` dependency
- [ ] AC-2: Rewrite `executePhase()` to use `query()` instead of `spawn()`
- [ ] AC-3: Use `settingSources: ['project']` to load project skills
- [ ] AC-4: Capture and display streaming output during execution
- [ ] AC-5: Handle errors and timeouts properly
- [ ] AC-6: Support session resumption for multi-phase workflows
- [ ] AC-7: Verify skills are actually invoked (check GitHub issue comments)

### New Features
- [ ] AC-8: Implement `--quality-loop` / `-q` flag with auto-retry logic
- [ ] AC-9: Implement `--max-iterations` option (default: 3)
- [ ] AC-10: Implement `--batch` option for grouped sequential execution
- [ ] AC-11: Implement `--smart-tests` / `--no-smart-tests` flags
- [ ] AC-12: Implement `--testgen` flag to run testgen after spec
- [ ] AC-13: Auto-detect UI issues by label and add test phase
- [ ] AC-14: Support environment variables for CI (`SEQUANT_QUALITY_LOOP`, `SEQUANT_MAX_ITERATIONS`)

---

## Implementation Notes

### Dependencies to Add
```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^latest"
  }
}
```

### Key Changes
1. Remove `spawn()` calls to `claude` CLI
2. Use Agent SDK `query()` function
3. Define natural language prompts for each phase
4. Stream output in real-time using async iterator
5. Optionally use `--json-schema` for structured results

### Session Management
For multi-phase workflows, capture session ID to maintain context:
```typescript
let sessionId: string;
for await (const msg of query({...})) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    sessionId = msg.session_id;
  }
}
// Resume later with: options: { resume: sessionId }
```

### Quality Loop Logic
- Already exists in `/fullsolve` and `/loop` skills - extract and reuse
- Smart tests need hook integration (pre/post tool hooks)
- Label detection can use `gh issue view --json labels`

---

## References

- [Claude Code Headless/Agent SDK](https://code.claude.com/docs/en/headless.md)
- [Agent SDK TypeScript](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [CLI Reference](https://code.claude.com/docs/en/cli-reference.md)

## Workaround

Until fixed, invoke skills manually in Claude Code interactive mode:
```bash
/spec 5
/exec 5  
/qa 5
```

Or use `/fullsolve 5` for the complete workflow.
