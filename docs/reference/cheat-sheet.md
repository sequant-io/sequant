# Sequant Cheat Sheet

> Quick reference for all commands, flags, and common workflows.
> For detailed docs, see the [full documentation](../README.md).

---

## Quick Start

| Goal | Command |
|------|---------|
| Solve an issue end-to-end | `/fullsolve 123` |
| Step-by-step workflow | `/spec 123` → `/exec 123` → `/qa 123` |
| Headless batch run | `npx sequant run 1 2 3 --quality-loop` |

---

## Slash Commands

**Core Workflow**

| Command | Purpose |
|---------|---------|
| `/spec <issue>` | Plan and review acceptance criteria, post issue comment |
| `/exec <issue>` | Build in isolated worktree until AC met |
| `/test <issue>` | Browser-based testing for admin features (needs Chrome DevTools MCP) |
| `/qa <issue>` | Code review and quality gate validation |

**Automation**

| Command | Purpose |
|---------|---------|
| `/fullsolve <issue>` | Full pipeline: spec → exec → test → qa with auto-fix |
| `/solve <issues...>` | Recommend optimal workflow for issue(s) |
| `/loop` | Re-run quality checks, fix failures, iterate |

**Testing & Docs**

| Command | Purpose |
|---------|---------|
| `/testgen <issue>` | Generate test stubs from spec verification criteria |
| `/verify` | CLI/script execution verification with captured output |
| `/docs <issue>` | Generate admin-facing feature documentation |

**Analysis & Utilities**

| Command | Purpose |
|---------|---------|
| `/assess <issue>` | Triage issue, recommend next phase |
| `/improve` | Discover codebase improvements, create issues |
| `/reflect` | Analyze workflow effectiveness |
| `/security-review` | Deep security analysis for sensitive features |
| `/clean` | Repository cleanup (stale worktrees, branches) |
| `/merger` | Multi-issue post-QA merge coordination |
| `/upstream` | Monitor Claude Code releases for compatibility |
| `/release` | Version bump, tag, GitHub release, npm publish |
| `/setup` | Initialize Sequant in a project (worktrees, templates, stack detection) |

---

## CLI Commands

| Command | Purpose |
|---------|---------|
| `sequant init` | Initialize Sequant in a project |
| `sequant update` | Update skill templates to latest versions |
| `sequant sync` | Sync skills and templates (non-interactive) |
| `sequant doctor` | Check installation health and prerequisites |
| `sequant status [issue]` | Show version, config, workflow state |
| `sequant run <issues...>` | Execute workflow headlessly |
| `sequant state [init\|rebuild\|clean]` | Manage workflow state |
| `sequant stats` | View local workflow analytics |
| `sequant dashboard` | Launch real-time workflow dashboard |
| `sequant logs` | View and manage log files |

---

## `sequant run` Flags

**Execution Mode**

| Flag | Description | Default |
|------|-------------|---------|
| `--sequential` | Run issues one at a time | off (parallel) |
| `--chain` | Chain issues: each branches from previous (requires `--sequential`) | off |
| `--qa-gate` | Wait for QA pass before next issue in chain (requires `--chain`) | off |
| `--phases <list>` | Phases to run | `spec,exec,qa` |
| `--resume` | Resume from last completed phase (reads GitHub markers) | off |
| `--base <branch>` | Base branch for worktree creation | `main` (or `settings.run.defaultBase`) |

**Quality**

| Flag | Description | Default |
|------|-------------|---------|
| `-q, --quality-loop` | Auto-retry on failures | off |
| `--max-iterations <n>` | Max retry iterations | `3` |
| `--testgen` | Run testgen phase after spec | off |
| `--smart-tests` | Enable smart test detection | on |
| `--no-smart-tests` | Disable smart test detection | — |

**Environment**

| Flag | Description | Default |
|------|-------------|---------|
| `--no-mcp` | Disable MCP server injection | off |
| `--timeout <seconds>` | Timeout per phase in seconds | `1800` |
| `--batch <issues>` | Group issues to run together (e.g., `--batch "1 2"`) | `[]` |

**Output**

| Flag | Description | Default |
|------|-------------|---------|
| `-d, --dry-run` | Preview without execution | off |
| `-v, --verbose` | Verbose output with streaming | off |
| `--log-json` | Enable structured JSON logging | on |
| `--no-log` | Disable JSON logging for this run | — |
| `--log-path <path>` | Custom log directory path | `.sequant/logs/` |
| `--quiet` | Suppress version warnings and non-essential output | off |

---

## Common Workflows

#### Single issue, full auto
```bash
/fullsolve 123
```
Runs spec → exec → test → qa with automatic fix loops.

#### Step-by-step with control
```bash
/spec 123        # Review the plan
/exec 123        # Implement in worktree
/qa 123          # Quality gate check
```
Pause between phases to review output and adjust.

#### Batch three issues
```bash
npx sequant run 101 102 103 --quality-loop
```
Runs all issues with auto-retry on failures.

#### Sequential chain (each builds on previous)
```bash
npx sequant run 101 102 103 --sequential --chain --qa-gate
```
Each issue branches from the last; waits for QA pass before continuing.

#### Resume a failed run
```bash
npx sequant run 123 --resume
```
Picks up from the last completed phase using GitHub markers.

#### Dry run to preview
```bash
npx sequant run 101 102 --dry-run
```
Shows what would happen without executing anything.

#### Generate tests before implementation
```bash
npx sequant run 123 --phases spec,testgen,exec,qa
```
Creates test stubs from spec, then implements against them.

#### Security-sensitive feature
```bash
/spec 123
/exec 123
/security-review
/qa 123
```
Adds a security review phase before final QA.

---

## Phase Verdicts

| Verdict | Meaning | Action |
|---------|---------|--------|
| `READY_FOR_MERGE` | All AC met, quality high | Merge the PR |
| `AC_MET_BUT_NOT_A_PLUS` | AC met, meaningful improvements suggested | Merge or iterate |
| `NEEDS_VERIFICATION` | AC met, pending external verification | Verify in CI/staging |
| `AC_NOT_MET` | Acceptance criteria failures | Fix and re-run `/qa` |

---

## Key File Locations

```
.claude/skills/          # Skill definitions (slash commands)
.claude/settings.json    # Claude Code settings
.sequant/settings.json   # Sequant configuration
.sequant/state.json      # Workflow state tracking
.sequant/metrics.json    # Local analytics data
.sequant/logs/           # Run logs
worktrees/               # Isolated git worktrees per issue
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Something feels broken | `npx sequant doctor` |
| Check current state | `npx sequant status` |
| View recent logs | `npx sequant logs` |
| Clean up stale worktrees | `/clean` |
| Reset workflow state | `npx sequant state clean` |
