---
name: upstream
description: "Monitor Claude Code releases, assess compatibility with sequant, and auto-create issues for feature opportunities and breaking changes."
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash(gh *)
  - Bash(git *)
  - Bash(jq *)
  - Bash(base64 *)
  - Bash(npx tsx *)
---

# Upstream: Claude Code Release Tracking

You are the "Upstream Assessment Agent" for the sequant repository.

## Purpose

When invoked as `/upstream`, your job is to:

1. Fetch Claude Code release information from the public GitHub repo
2. Analyze changes against sequant's current capabilities baseline
3. Detect relevant changes using keyword matching and regex patterns
4. Generate a structured compatibility assessment report
5. Auto-create GitHub issues for actionable findings

## Invocation

```bash
# Analyze latest release
/upstream

# Analyze specific version
/upstream v2.1.29

# Analyze all releases since version
/upstream --since v2.1.25

# Dry-run mode (no issues created)
/upstream --dry-run

# Help
/upstream --help
```

## Assessment Process

### 1. Parse Arguments

Parse the command arguments to determine:

- **Target version**: Specific version (e.g., `v2.1.29`) or `latest`
- **Since version**: If `--since` flag provided, assess all versions since that release
- **Dry-run mode**: If `--dry-run` flag, generate report but skip issue creation
- **Help**: If `--help` flag, show usage instructions

### 2. Fetch Release Data

Fetch release information from the public Claude Code repository:

```bash
# Get latest release
gh release view --repo anthropics/claude-code --json tagName,name,body,publishedAt

# Get specific version
gh release view v2.1.29 --repo anthropics/claude-code --json tagName,name,body,publishedAt

# List releases for --since support
gh release list --repo anthropics/claude-code --limit 50 --json tagName,publishedAt
```

### 3. Load Baseline

Load the sequant capabilities baseline from `.sequant/upstream/baseline.json`:

```json
{
  "lastAssessedVersion": "v2.1.25",
  "tools": {
    "core": ["Task", "Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    "optional": ["WebFetch", "WebSearch", "NotebookEdit"]
  },
  "hooks": {
    "used": ["PreToolUse"],
    "files": ["src/hooks/pre-tool-hook.ts"]
  },
  "mcpServers": {
    "required": [],
    "optional": ["chrome-devtools", "context7", "sequential-thinking"]
  },
  "keywords": [
    "Task", "Bash", "hook", "PreToolUse", "PostToolUse",
    "MCP", "permission", "allow", "deny", "tool",
    "background", "parallel", "agent", "subagent",
    "settings", "config", "plugin"
  ],
  "dependencyMap": {
    "permission": ["src/hooks/pre-tool-hook.ts", ".claude/settings.json"],
    "hook": ["src/hooks/pre-tool-hook.ts"],
    "Task": [".claude/skills/**/*.md", "src/lib/workflow/*.ts"],
    "MCP": ["docs/mcp-integrations.md", ".claude/settings.json"]
  }
}
```

### 4. Analyze Changes

For each release, analyze the changelog/release body:

**Step 1: Extract Changes**

Parse the release body to extract individual change items. Common formats:
- Bullet points: `- Added new feature X`
- "What's changed" sections
- BREAKING CHANGE markers

**Step 2: Relevance Detection**

For each change, check if it's relevant to sequant:

```typescript
// Keyword matching
const isRelevant = baseline.keywords.some(kw =>
  change.toLowerCase().includes(kw.toLowerCase())
);

// Pattern matching
const patterns = {
  newTool: /added.*tool|new.*tool|introducing/i,
  deprecation: /deprecat|remov|no longer support/i,
  breaking: /breaking|incompatible|must update/i,
  hook: /hook|PreToolUse|PostToolUse/i,
  permission: /permission|allow|deny|ask/i,
};
```

**Step 3: Categorize**

Categorize each relevant change:

| Category | Detection Pattern | Issue Labels |
|----------|------------------|--------------|
| `breaking` | Breaking, incompatible, must update | `upstream`, `bug`, `priority:high` |
| `deprecation` | Deprecated, removed, no longer supported | `upstream`, `bug` |
| `new-tool` | Added tool, new tool, introducing | `upstream`, `enhancement` |
| `hook-change` | Hook, PreToolUse, PostToolUse | `upstream`, `enhancement` |
| `opportunity` | Keywords match but not above categories | `upstream`, `enhancement` |
| `no-action` | Doesn't match patterns or keywords | (no issue) |

**Step 4: Impact Mapping**

For relevant changes, map to affected sequant files using `dependencyMap`:

```typescript
const impactFiles = baseline.dependencyMap[matchedKeyword] || [];
```

### 5. Check for Duplicates

Before creating issues, check for existing upstream issues:

```bash
# Search for similar issues
gh issue list --label upstream --search "<finding-title>" --json number,title
```

If a similar issue exists:
- Add a comment linking to the new assessment
- Skip creating a duplicate

### 6. Generate Outputs

**Output 1: Assessment Report (GitHub Issue)**

Create a summary issue with the full assessment:

```markdown
## Upstream: Claude Code <version> Assessment

**Release:** [<version>](https://github.com/anthropics/claude-code/releases/tag/<version>)
**Released:** <date>
**Assessed:** <today>

### Summary

| Category | Count | Action Required |
|----------|-------|-----------------|
| Breaking Changes | N | [status] |
| New Tools | N | [status] |
| Deprecations | N | [status] |
| Opportunities | N | [status] |

### Breaking Changes

[list or "None detected"]

### New Tools

[list with opportunity descriptions]

### Deprecations

[list with impact and migration notes]

### Feature Opportunities

[list with potential uses]

### No Action Required

[list of irrelevant changes]

---

*Generated by /upstream skill*
```

**Output 2: Individual Issues (Actionable Findings)**

For each actionable finding, create an issue:

```markdown
## feat: Leverage <feature> from Claude Code <version>

**Upstream:** Claude Code <version>
**Category:** <category>
**Assessment:** #<assessment-issue>

### Context

<description from release notes>

### Opportunity

<how sequant could use this>

### Proposed Implementation

[To be determined during /spec phase]

### Acceptance Criteria

- [ ] AC-1: [To be defined]

---

*Auto-created by /upstream assessment #<N>*
```

Labels: `upstream`, `needs-triage`, `enhancement`

**Output 3: Local Report**

Save to `.sequant/upstream/<version>.md`:

```markdown
# Claude Code <version> Assessment

Assessed: <date>
Previous: <last-assessed-version>

## Summary

[same as GitHub issue]

## Raw Findings

[detailed analysis data]
```

**Output 4: Update Baseline**

Update `.sequant/upstream/baseline.json`:
- Set `lastAssessedVersion` to the assessed version

### 7. Multi-Version Batching

When `--since <version>` is used:

1. List all releases after the specified version
2. Assess each version individually
3. Create a batched summary issue linking all individual assessments
4. Update baseline to latest assessed version

## Dry-Run Mode

When `--dry-run` is specified:

1. Perform full analysis
2. Generate local report
3. Output what issues WOULD be created (titles, labels)
4. Skip actual GitHub issue creation
5. Skip baseline update

## Error Handling

- **No releases found**: Exit with clear message
- **Baseline missing**: Create default baseline, warn user
- **GitHub API errors**: Retry with backoff, then fail gracefully
- **Already assessed**: Skip with message (idempotent)

## Output Verification

**Before completing, verify:**

- [ ] Release data successfully fetched
- [ ] Baseline loaded (or created with defaults)
- [ ] Each change categorized
- [ ] Duplicates checked before issue creation
- [ ] Assessment report created (or dry-run output shown)
- [ ] Individual issues created for actionable findings
- [ ] Local report saved
- [ ] Baseline updated with new version

## Examples

### Example 1: Assess Latest Release

```
/upstream

Fetching latest Claude Code release...
Release: v2.1.29 (2025-01-31)

Loading baseline from .sequant/upstream/baseline.json...
Last assessed: v2.1.27

Analyzing 12 changes from release notes...
- 3 relevant changes detected
- 9 no-action changes

Findings:
1. [opportunity] New --background flag on Task tool
   Matched keywords: Task, background
   Impact files: .claude/skills/**/*.md

2. [hook-change] Permissions now respect content-level ask
   Matched keywords: permission
   Impact files: src/hooks/pre-tool-hook.ts

3. [deprecation] oldHookName deprecated
   Matched pattern: deprecat
   Impact files: src/hooks/pre-tool-hook.ts

Creating assessment issue...
Created: #250 - Upstream: Claude Code v2.1.29 Assessment

Creating individual issues...
Created: #251 - feat: Leverage new --background flag from Claude Code v2.1.29
Created: #252 - chore: Update to new hook name (deprecation from v2.1.29)

Saving local report to .sequant/upstream/v2.1.29.md...
Updating baseline lastAssessedVersion to v2.1.29...

Done! Assessment complete.
```

### Example 2: Dry Run

```
/upstream --dry-run

[DRY RUN MODE - No issues will be created]

Fetching latest Claude Code release...
Release: v2.1.29 (2025-01-31)

...analysis...

Would create issues:
1. Assessment: Upstream: Claude Code v2.1.29 Assessment
2. Finding: feat: Leverage new --background flag from Claude Code v2.1.29
3. Finding: chore: Update to new hook name (deprecation from v2.1.29)

Local report saved: .sequant/upstream/v2.1.29.md
Baseline NOT updated (dry-run mode)
```

### Example 3: Already Assessed

```
/upstream

Fetching latest Claude Code release...
Release: v2.1.29 (2025-01-31)

Already assessed: .sequant/upstream/v2.1.29.md exists
Use --force to re-assess.

No action taken.
```

## Notes

- This is an internal tool for sequant maintainers
- All created issues get `needs-triage` label for human review
- The skill is read-only for Claude Code repo (no PRs or edits)
- Baseline file should be committed to version control
- Local reports in `.sequant/upstream/` should be committed

---

*This skill monitors the upstream Claude Code project to help sequant stay current with new features and breaking changes.*
