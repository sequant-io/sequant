# What We've Built: Sequant v1.16.1

> **Quantize your development workflow** — Sequential AI phases with quality gates

Sequant transforms the chaos of AI-assisted development into
a structured, repeatable process. Every GitHub issue becomes a
journey through planning, implementation, testing, and review
— with quality gates at every step.

---

## At a Glance

| Metric | Count |
|--------|-------|
| Slash Commands | 18 |
| CLI Commands | 11 |
| Core Library Modules | 46 |
| Test Files | 55 |
| Documentation Files | 39 |
| Stack Configurations | 9 |
| Lines of TypeScript | ~36,600 |

**License:** MIT
**Platforms:** macOS, Linux, Windows WSL (full), Windows Native (CLI only)
**Philosophy:** Local-first. No telemetry. Your code stays yours.

---

## The Big Picture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          GitHub Issue #123                          │
│                    "Add user authentication"                        │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           Claude Code                               │
│                                                                     │
│   /spec ──────► /exec ──────► /test ──────► /qa ──────► PR Ready   │
│   (Plan)       (Build)      (Verify)      (Review)                 │
│                                                                     │
│   ─────────────── or just: /fullsolve 123 ──────────────           │
└─────────────────────────────────────────────────────────────────────┘
                                │
                    ┌───────────┼───────────┐
                    │           │           │
            ┌───────▼───────┐   │   ┌───────▼───────┐
            │ Git Worktrees │   │   │   Quality     │
            │  (isolation)  │   │   │    Checks     │
            └───────────────┘   │   └───────────────┘
                        ┌───────▼───────┐
                        │    GitHub     │
                        │   CLI (gh)    │
                        └───────────────┘
```

### Why Sequant Exists

AI coding assistants are powerful but chaotic. Without structure, you get:
- Half-finished features scattered across branches
- Acceptance criteria ignored or misunderstood
- No clear definition of "done"
- Security issues slipping through

Sequant brings **discipline without friction**:
- **Phases** ensure nothing gets skipped
- **Worktrees** keep each issue isolated
- **Quality gates** catch problems before merge
- **Local state** tracks what's done and what's not

### Phase Isolation by Design

Each phase runs as a **fresh conversation** — no implicit memory carried forward. This is intentional:

- **No context pollution** — stale planning notes don't crowd out implementation context
- **Honest review** — `/qa` evaluates the actual diff, not the implementer's memory of it
- **Composable phases** — run `/qa` alone, re-run `/exec` after failure, skip phases freely

Cross-phase context flows through **explicit channels**:
`state.json` (phase progress, AC status), GitHub issue
comments (spec plans, QA verdicts), git diff (what actually
changed), and environment variables (orchestration context).
These are inspectable, scoped per issue, and don't accumulate
noise.

---

## Skill Commands

Sequant provides **18 slash commands** organized by purpose. Run them inside Claude Code.

### Core Workflow

The four pillars of the Sequant workflow:

| Command | Purpose | What It Does |
|---------|---------|--------------|
| `/spec` | **Plan** | Extracts AC, creates implementation plans, posts to GitHub |
| `/exec` | **Build** | Creates worktrees, implements incrementally, creates PRs |
| `/test` | **Verify** | Browser automation via Chrome DevTools, screenshot evidence |
| `/qa` | **Review** | Validates AC, runs quality checks, renders merge verdicts |

**`/spec` details:**
- Lints AC for vague/unmeasurable terms
- Requires explicit verification methods (Unit/Integration/Browser/Manual)
- Feature Quality Planning (6 dimensions: completeness, error handling,
  code quality, test coverage, best practices, polish)
- Scope Assessment with verdicts: `SCOPE_OK` / `SCOPE_WARNING` /
  `SCOPE_SPLIT_RECOMMENDED`
- Content analysis (title/body patterns → phase recommendations)
- Testgen auto-detection, conflict detection, Derived ACs

**`/exec` details:**
- Pre-PR AC verification (checks each AC before PR creation)
- Shell script quality checks
- Mandatory prompt templates for parallel sub-agents

**`/test` details:**
- Coverage analysis (warns when changed files lack tests)
- Graceful fallback to manual checklists

**`/qa` details:**
- Type safety, security scans, Semgrep static analysis
- Test tautology detection (flags tests that don't call production code)
- CI status awareness, build verification against main
- Caches expensive checks (`--no-cache` to force fresh)
- Verdicts: `READY_FOR_MERGE`, `AC_NOT_MET`,
  `NEEDS_VERIFICATION`, `SECURITY_CONCERN`

### Automation Commands

For when you want to go hands-off:

| Command | Purpose | What It Does |
|---------|---------|--------------|
| `/fullsolve` | **End-to-End** | Orchestrates spec→exec→test→qa with auto-fix loops |
| `/solve` | **Advisor** | Recommends optimal workflow, outputs CLI commands |
| `/loop` | **Quality Loop** | Parses findings, applies fixes, re-validates |

### Testing & Verification

| Command | Purpose | What It Does |
|---------|---------|--------------|
| `/testgen` | **Test Generator** | Creates stubs from `/spec` verification criteria |
| `/verify` | **CLI Verification** | Runs commands, captures output, posts evidence |
| `/docs` | **Documentation** | Auto-detects doc type, generates operational docs |

### Analysis & Utilities

| Command | Purpose | What It Does |
|---------|---------|--------------|
| `/assess` | **Triage** | Detects current phase, recommends next action |
| `/clean` | **Cleanup** | Archives stale files, verifies build, commits |
| `/improve` | **Discovery** | Scans for issues, creates GitHub issues |
| `/reflect` | **Learning** | Analyzes session effectiveness |
| `/security-review` | **Security** | Domain-specific checklists, threat modeling |
| `/merger` | **Integration** | Multi-issue merge with conflict detection |
| `/upstream` | **Tracking** | Monitors Claude Code releases, creates issues |

### Shared Resources

Skills share common references in `skills/_shared/`:
- `subagent-types.md` — Valid sub-agent types
- `prompt-templates.md` — Task-specific sub-agent templates

---

## CLI Commands

The `sequant` CLI provides **10 commands** for project management.

```bash
npm install -g sequant   # Install globally
npx sequant              # Or run via npx
```

| Command | Description |
|---------|-------------|
| `sequant init` | Initialize Sequant in a project (copies templates, creates `.claude/` and `.sequant/`) |
| `sequant doctor` | Check installation health — prerequisites, closed-issue verification, config validation |
| `sequant run <issues>` | Execute workflow (`-q` quality loop, `--chain`, `--resume`, `--force`) |
| `sequant status` | Show version, config, tracked issues with cleanup options |
| `sequant update` | Update skill templates to latest versions |
| `sequant state` | Manage workflow state (`init`, `rebuild`, `clean`) |
| `sequant stats` | View local workflow analytics — success rates, timing, phase distribution |
| `sequant logs` | View and manage log files with rotation |
| `sequant merge` | Batch-level integration QA — verify feature branches before merging (`--check`, `--scan`, `--post`) |
| `sequant dashboard` | Launch real-time workflow dashboard (Hono-powered) |

### Quick Examples

```bash
# Initialize a new project
sequant init

# Check everything is working
sequant doctor

# Run full workflow for issue #42
sequant run 42

# Run with quality loop (auto-retry on failures)
sequant run 42 -q

# View your success rates
sequant stats
```

---

## Core Libraries

The engine room lives in `src/lib/`. These modules power everything.

### Primary Libraries

| Module | Purpose |
|--------|---------|
| `stacks.ts` | Detects project type and package manager, provides build/test commands |
| `semgrep.ts` | Stack-aware Semgrep static analysis with custom rules support |
| `templates.ts` | Copies skill templates to `.claude/`, handles variable substitution |
| `manifest.ts` | Tracks installed skills and versions in `.sequant-manifest.json` |
| `settings.ts` | Reads/writes `.sequant/settings.json` for persistent configuration (deep merge for nested objects) |
| `config.ts` | Core configuration file operations |
| `fs.ts` | Async file helpers (`exists`, `read`, `write`, `ensureDir`) |
| `system.ts` | Validates prerequisites (`gh` CLI, `jq`), MCP server configuration |
| `tty.ts` | Detects interactive vs non-interactive mode |
| `wizard.ts` | Guides users through dependency installation |
| `shutdown.ts` | Signal handling for graceful shutdown |
| `version-check.ts` | Checks for updates, warns on stale local installs |
| `cli-ui.ts` | Centralized CLI UI (spinners, boxes, tables, colors, ASCII branding) with graceful degradation |
| `phase-spinner.ts` | Animated phase spinner with elapsed time and TTY fallback |
| `ac-parser.ts` | Extracts acceptance criteria from markdown (AC-1, B2, etc.) |
| `ac-linter.ts` | Flags vague, unmeasurable, incomplete, or open-ended AC before implementation |
| `content-analyzer.ts` | Analyzes issue title/body for phase-relevant keywords (UI, security, complexity patterns) |
| `phase-signal.ts` | Phase signal types and priority-based merging (Labels > Solve > Title > Body) |
| `solve-comment-parser.ts` | Detects and parses `/solve` workflow recommendations from issue comments |
| `project-name.ts` | Auto-detects project name from package.json, Cargo.toml, pyproject.toml, go.mod, git remote |

### Workflow Subsystem

State management and analytics live in `src/lib/workflow/`:

| Module | Purpose |
|--------|---------|
| `types.ts` | Core types: `Phase`, `ExecutionConfig`, `IssueResult`, `PhaseResult` |
| `state-manager.ts` | Persistent workflow state in `.sequant/state.json` |
| `state-schema.ts` | Zod schemas for state validation |
| `state-utils.ts` | State manipulation utilities |
| `state-hook.ts` | Hook utility for skills to update state |
| `log-writer.ts` | Run log writer for workflow execution |
| `run-log-schema.ts` | Schema for run logs |
| `log-rotation.ts` | Log file rotation and cleanup |
| `metrics-writer.ts` | Analytics metrics writer |
| `metrics-schema.ts` | Schema for local analytics data |
| `phase-detection.ts` | Phase marker parsing; powers `--resume` resumption |
| `qa-cache.ts` | QA check result caching keyed by diff hash + config hash |
| `test-tautology-detector.ts` | Detects tautological tests that pass without calling production code |

---

## Stack Support

Sequant auto-detects your project type and configures itself.
Each stack injects testing, linting, and build notes into your
constitution template.

| Stack | Detection | Build Command | Test Command |
|-------|-----------|---------------|--------------|
| **Next.js** | `next.config.*`, `next` dep | `npm run build` | `npm test` |
| **Astro** | `astro.config.*`, `astro` dep | `npm run build` | `npm test` |
| **SvelteKit** | `svelte.config.*`, `@sveltejs/kit` dep | `npm run build` | `npm test` |
| **Remix** | `remix.config.*`, `@remix-run/react` dep | `npm run build` | `npm test` |
| **Nuxt** | `nuxt.config.*`, `nuxt` dep | `npm run build` | `npm test` |
| **Rust** | `Cargo.toml` | `cargo build --release` | `cargo test` |
| **Python** | `pyproject.toml`, `setup.py`, `requirements.txt` | `python -m build` | `pytest` |
| **Go** | `go.mod` | `go build ./...` | `go test ./...` |
| **Generic** | `package.json` (fallback) | `npm run build` | `npm test` |

Stack-specific constitution notes include:
- **Testing:** Frameworks, patterns, test file locations
- **Linting:** Tools, commands, configuration
- **Build:** Output directories, commands, deployment notes

---

## State & Analytics

Sequant tracks everything locally. **No data ever leaves your machine.**

### State Tracking (`.sequant/state.json`)

Tracks per-issue:
- Current phase (spec, exec, test, qa)
- AC completion status
- Worktree location
- PR information
- Phase history

### Local Analytics (`.sequant/metrics.json`)

Tracks aggregate metrics:
- Success/failure rates by phase
- Average time per phase
- Most common failure modes
- Issue completion trends

View with `sequant stats`:

```bash
$ sequant stats

Workflow Statistics
───────────────────
Total Issues: 47
Completed: 41 (87%)
Failed: 6 (13%)

Phase Success Rates:
  /spec: 98%
  /exec: 89%
  /test: 76%
  /qa:   94%

Average Time to Completion: 23m
```

### Run Logs

Full execution logs with automatic rotation:
- Stored in `.sequant/logs/`
- Configurable retention
- Searchable with `sequant logs`

---

## Testing & Quality

**47 test files** ensure reliability.

### Test Coverage

| Area | Test Files |
|------|------------|
| **Commands** | `init`, `doctor`, `run`, `run-resume`, `status`, `state`, `stats` |
| **Libraries** | `fs`, `stacks`, `system`, `templates`, `wizard`, `tty`, `shutdown`, `version-check`, `ac-parser`, `ac-linter` |
| **Workflow** | `state-manager`, `state-utils`, `state-hook`, `log-writer`, `log-rotation`, `metrics-writer`, `phase-detection` |
| **Integration** | `cli.integration`, `doctor.integration` |

### Running Tests

```bash
npm test                    # Run all tests (Vitest)
npm run lint               # ESLint
npm run validate:skills    # Validate skill YAML frontmatter
npm run build              # TypeScript compilation check
```

### Quality Gates in CI

Every PR goes through:
1. TypeScript compilation
2. ESLint checks
3. Vitest test suite
4. Skill YAML validation

---

## Documentation

**26+ documentation files** covering installation to troubleshooting.

### Getting Started
- `getting-started/installation.md` — Installation guide
- `README.md` — Documentation hub

### Concepts
- `concepts/what-is-sequant.md` — Elevator pitch, pipeline diagram, architecture overview
- `concepts/workflow-phases.md` — Phase overview and selection

### Features
- `features/scope-assessment-settings.md` — Customizing scope thresholds
- `features/package-manager-detection.md` — Auto-detection of npm/Bun/Yarn/pnpm
- `features/test-tautology-detector.md` — Tautological test detection and QA integration

### Guides
- `guides/customization.md` — Configuration options
- `guides/mcp-integrations.md` — MCP server configuration
- `guides/git-workflows.md` — Git workflow patterns

### Reference
- `reference/cheat-sheet.md` — Quick reference for all commands, flags, and workflows
- `reference/run-command.md` — Comprehensive `sequant run` guide
- `reference/state-command.md` — State management
- `reference/analytics.md` — Local analytics deep-dive
- `reference/telemetry.md` — Privacy statement (spoiler: no telemetry)
- `reference/platform-requirements.md` — OS support matrix

### Stack-Specific
- `stacks/nextjs.md`, `stacks/rust.md`, `stacks/python.md`, `stacks/go.md`

### Troubleshooting
- `troubleshooting.md` — Common issues and solutions
- `logging.md` — Logging system
- `testing.md` — Testing approach

### Internal
- `release-checklist.md` — Release process
- `dashboard-spike.md` — Dashboard design notes
- `plugin-updates.md` — Plugin versioning
- `upstream-skill.md` — Claude Code release tracking and gap analysis

---

## Architecture Deep Dive

### Directory Structure

```
sequant/
├── bin/cli.ts              # CLI entry point
├── src/
│   ├── commands/           # CLI command implementations
│   ├── lib/                # Shared utilities
│   │   └── workflow/       # State, metrics, logging
│   └── index.ts            # Public exports
├── skills/                 # Live skill files (16)
├── templates/              # Distributable templates
│   ├── skills/             # Skill templates
│   ├── hooks/              # Pre/post tool hooks
│   ├── memory/             # Constitution template
│   └── scripts/            # Helper scripts
├── stacks/                 # Stack configurations
├── hooks/                  # Tool hooks
├── scripts/                # Shell scripts
├── dashboard/              # Real-time dashboard
├── vscode-extension/       # VS Code extension
├── docs/                   # Documentation
└── .claude-plugin/         # Plugin marketplace config
```

### Integration Points

**Claude Agent SDK**
- Skills are executed through the SDK
- Proper tool permissions per skill
- Graceful error handling

**GitHub CLI (`gh`)**
- Issue fetching and parsing
- PR creation and management
- Comment posting
- Label management

**Git Worktrees**
- One worktree per issue
- Clean isolation
- Easy cleanup

**Optional MCPs**
- `chrome-devtools` — Browser testing with `/test`
- `sequential-thinking` — Complex reasoning
- `context7` — Library documentation lookup

### Data Flow

```
Issue #123 ──► /spec ──► Plan Posted ──► User Approves
                              │
                              ▼
              /exec ──► Worktree Created ──► Code Written ──► PR Created
                              │
                              ▼
              /test ──► Tests Run ──► Evidence Captured
                              │
                              ▼
               /qa ──► Quality Checks ──► Verdict Rendered
                              │
                        ┌─────┴─────┐
                        ▼           ▼
                 READY_FOR_MERGE    NEEDS_WORK
                        │           │
                        ▼           ▼
                    Merge PR    /loop ──► Fix ──► Re-QA
```

---

## Hooks System

The **pre-tool hook** (`templates/hooks/pre-tool.sh`) is a
450+ line security and quality enforcement system. It intercepts
every tool call before execution.

### Security Guardrails

Blocks catastrophic commands before they run:

| Threat | What's Blocked | Why |
|--------|----------------|-----|
| **Credential Reading** | Reading SSH keys, env files | Prevents secret exfiltration |
| **System Destruction** | Recursive deletes on root/home | Prevents accidental destruction |
| **Force Push** | Git force push commands | Protects shared history |
| **Deployment** | Production deployment commands | Automation shouldn't deploy |
| **CI Triggers** | Workflow dispatch commands | Prevents automation loops |
| **Environment Dump** | Bare environment dump commands | Blocks credential harvesting |

### Secret Detection

Scans staged commits for hardcoded secrets:

- OpenAI API keys (`sk-...`)
- Stripe live keys (`sk_live_...`)
- AWS Access Keys (`AKIA...`)
- GitHub Personal Tokens (`ghp_...`)
- Slack Bot Tokens (`xoxb-...`)
- Google API Keys (`AIza...`)

### Sensitive File Detection

Blocks commits containing:
- Environment files (`.env`, `.env.local`, `.env.production`)
- Credential JSON files
- Key and certificate files (`.pem`, `.key`)
- SSH private keys

### Conventional Commits Enforcement

Validates commit messages follow the format:

```text
type(scope): description

Types: feat|fix|docs|style|refactor|test|chore|ci|build|perf
```

Provides helpful suggestions for common scenarios:
- Merge commits: Suggests `chore: merge main into feature branch` format

### Worktree Path Enforcement

When `SEQUANT_WORKTREE` is set (by `sequant run`), blocks
file edits outside the designated worktree. Prevents accidental
edits to the main repo during feature work.

### File Locking for Parallel Agents

Uses `lockf` (macOS) or `flock` (Linux) to prevent concurrent
edits to the same file when multiple agents run in parallel.

### Git Reset Protection

Blocks hard resets when there's local work that would be lost:
- Unpushed commits on main/master
- Uncommitted changes (staged or unstaged)
- Unfinished merge in progress

### Pre-Merge Worktree Cleanup

Automatically removes worktrees before PR merge to prevent branch deletion failures (worktrees lock their branches).

### Timing Instrumentation

Logs tool execution times to `/tmp/claude-timing.log` for performance analysis.

### Rollback Mechanism

Set `CLAUDE_HOOKS_DISABLED=true` to bypass all hook logic when needed.

---

## VS Code Extension

**Sequant Explorer** provides visual workflow tracking directly in VS Code.

### Features

| Feature | Description |
|---------|-------------|
| **Activity Bar Icon** | Dedicated Sequant panel in the sidebar |
| **Workflow Tree View** | Shows all tracked issues with status |
| **Auto-Activation** | Activates when `.sequant/state.json` exists |

### Commands

| Command | Icon | Action |
|---------|------|--------|
| `sequant.refresh` | Refresh | Reload workflow state |
| `sequant.openWorktree` | Terminal | Open worktree in terminal |
| `sequant.openWorktreeNewWindow` | Windows | Open worktree in new VS Code window |
| `sequant.openInBrowser` | GitHub | View issue on GitHub |
| `sequant.openPR` | PR | View pull request |
| `sequant.copyBranch` | Clipboard | Copy branch name |

### Context Menu

Right-click any issue in the tree view to access all commands.

---

## Real-Time Dashboard

A **1000+ line web UI** for visualizing workflow state in real-time.

### Tech Stack

| Component | Technology |
|-----------|------------|
| **Server** | Hono (lightweight, fast) |
| **Interactivity** | htmx (HTML-first) |
| **Styling** | Pico CSS (classless) |
| **Live Updates** | Server-Sent Events (SSE) |
| **File Watching** | Chokidar |

### Launch

```bash
sequant dashboard           # Opens http://localhost:3456
sequant dashboard --port 8080
sequant dashboard --no-open # Don't auto-open browser
```

### Features

**Issue Cards**
- Status badges (in_progress, ready_for_merge, blocked, etc.)
- Phase indicators with animated pulses for active phase
- Tooltips showing duration and error messages
- PR links and worktree paths
- Branch names with copy-to-clipboard

**Acceptance Criteria Tracking**
- Expandable AC sections per issue
- Status icons (met, not_met, pending, blocked)
- Progress badges (e.g., "3/5 met")

**Live Updates**
- File watcher on `.sequant/state.json`
- SSE broadcasts changes to all connected browsers
- Connection status indicator (green dot = live)

**Summary Stats**
- Total issues tracked
- In Progress / QA Gate / Ready / Blocked counts
- Grouped by status, sorted by last activity

---

## Embedded Reference Documents

Skills include rich guidance documents in `templates/skills/*/references/`:

### Quality & Review

| Document | Purpose |
|----------|---------|
| `qa/references/quality-gates.md` | Verdict criteria (READY_FOR_MERGE, AC_NOT_MET, etc.), tautology thresholds |
| `qa/references/code-review-checklist.md` | Systematic review checklist |
| `qa/references/code-quality-exemplars.md` | Examples of good vs bad code |
| `qa/references/testing-requirements.md` | What tests are expected |
| `qa/references/semgrep-rules.md` | Semgrep integration guide and custom rule documentation |

### Planning

| Document | Purpose |
|----------|---------|
| `spec/references/verification-criteria.md` | How to write testable AC |
| `spec/references/parallel-groups.md` | Grouping issues for parallel work |
| `spec/references/recommended-workflow.md` | Workflow selection guidance |

### Security

| Document | Purpose |
|----------|---------|
| `security-review/references/security-checklists.md` | Domain-specific security checks (auth, API, admin, file ops) |

### Process

| Document | Purpose |
|----------|---------|
| `reflect/references/phase-reflection.md` | How to analyze session effectiveness |
| `reflect/references/documentation-tiers.md` | When to create what docs |

### Constitution Template

`templates/memory/constitution.md` — Project-specific AI guidelines:
- Core principles (quality first, test everything, document decisions)
- Workflow phase overview
- Code standards (naming, error handling, testing)
- Available commands reference
- **Dynamic stack-specific notes** — Auto-injected based on
  detected stack with testing, linting, and build conventions
- Space for project-specific customization

---

## Helper Scripts

Shell scripts in `templates/scripts/`:

| Script | Purpose |
|--------|---------|
| `new-feature.sh` | Create a new feature worktree |
| `cleanup-worktree.sh` | Remove a worktree and its branch |
| `list-worktrees.sh` | List all active worktrees |

---

## Timeline: How We Got Here

### Phase 1: Foundation
- Core skill structure (`/spec`, `/exec`, `/qa`)
- Basic worktree management
- GitHub integration via `gh` CLI

### Phase 2: Quality Systems
- Quality loop (`-q` flag)
- State tracking (`.sequant/state.json`)
- Local analytics (`sequant stats`)
- Run logging with rotation

### Phase 3: Automation
- `/fullsolve` end-to-end pipeline
- Auto-fix iterations
- `/loop` for targeted fixes
- Chain mode for dependent issues

### Phase 4: Polish & Distribution
- `sequant init` for easy initialization
- Auto-detect project name
- VS Code extension
- Dashboard for workflow visualization
- **Claude Code Plugin** marketplace listing

### Recent Additions (v1.16.0)

- **Batch-level integration QA** (`sequant merge`) (#313)
  - Phase 1: combined branch test, template mirroring, file overlap detection
  - Phase 2: residual pattern detection via `--scan`
  - Per-issue and batch verdicts (READY / NEEDS_ATTENTION / BLOCKED)
  - `--post` posts merge readiness reports to PRs, `--json` for CI
  - Auto-detects issues from most recent `sequant run` log
  - Worktree-aware: handles both remote and local-only branches

- **Scope assessment custom thresholds** (#249)
  - `ScopeAssessmentSettings` aligned with `ScopeAssessmentConfig` (added
    `trivialThresholds.maxACItems`, `trivialThresholds.maxDirectories`,
    `thresholds.directorySpread`)
  - `convertSettingsToConfig()` merges user settings with defaults
  - SKILL.md reads `.sequant/settings.json` before calling `performScopeAssessment`
  - Deep merge in `getSettings()` for nested threshold objects
  - 18 tests (9 unit + 9 integration covering the full settings → config pipeline)
  - Documentation: `docs/features/scope-assessment-settings.md`
- **Pipeline observability: file tracking, git SHA, diff stats, token usage** (#278)
  - `filesModified` populated in all phase logs via `git diff --name-only`
  - `startCommit`/`endCommit` on RunLog, `commitHash` on PhaseLog
  - Per-file `fileDiffStats` (additions, deletions, status) on PhaseLog
  - Token usage capture via `SessionEnd` hook + transcript JSONL parsing
  - `metrics.tokensUsed` now populated (was always 0); input/output/cache breakdown
  - QA cache hit/miss metrics written by `quality-checks.sh`, read into phase logs
  - `sequant logs` displays commit hashes, file counts, diff stats, cache metrics
  - `sequant stats` includes token usage analytics with averages
  - Shared `getGitDiffStats()` utility avoids redundant git operations
  - All fields optional — backward compatible with existing logs
  - 34 new unit tests (10 git-diff-utils, 24 token-utils)
- **MCP fallback retry for cold-start failures** (#267)
  - Two-phase retry: cold-start retries (up to 2x within 60s) then MCP fallback
  - MCP fallback disables MCP servers on retry, addressing npx cold-cache failures
  - Original error preserved on double-failure for better diagnostics
  - `--no-retry` flag and `run.retry` setting for explicit control
  - Non-fatal `logWriter.initialize()` — runs continue without logging on failure
  - 8 unit tests via dependency-injected `executePhaseFn`
- **Pre-PR rebase to prevent lockfile drift** (#295)
  - Worktree branches rebase onto `origin/main` before PR creation
  - Lockfile change detection (`ORIG_HEAD..HEAD`) triggers automatic reinstall
  - Chain mode: only final branch rebases (intermediate branches preserved)
  - Graceful conflict handling (abort, warn, continue with original state)
  - `--no-rebase` flag for manual rebase workflows
  - 10 unit tests covering rebase, lockfile detection, and conflict handling
- **Auto-sync skills on upgrade**
  - Skills automatically sync when upgrading sequant
  - `sequant status` auto-detects merged PRs
- **Fix: `--verbose` spinner garbling** (#282)
  - Propagate verbose flag to cli-ui so spinners use text-only mode
  - Prevents animated spinner control characters from colliding with
    verbose `console.log()` calls from StateManager/MetricsWriter
  - Suppressed repetitive `State saved` / `Metrics saved` noise;
    operator-useful messages (phase transitions, status changes) remain
- **Fix: streaming output truncation** (#283)
  - Pauses spinner once per streaming session instead of per-chunk
  - Eliminates truncation caused by ora's line-clearing during rapid
    pause/resume cycles in verbose mode
- **Fix: pre-flight state guard and worktree lifecycle** (#305)
  - Pre-flight state guard skips `ready_for_merge`/`merged` issues with warning
  - `--force` flag bypasses the guard for re-execution
  - Stale worktree detection: recreates worktrees >5 commits behind `origin/main`
  - Preserves worktrees with uncommitted changes or unpushed commits
  - Auto-reconciliation at run start: advances merged issues via `gh pr` and `git branch --merged`
  - Merger skill updated with explicit state update and worktree cleanup steps
  - Graceful degradation on missing state, network failures, or corrupted state
  - Merge detection uses merge-specific grep patterns (avoids false positives from docs/changelog commits)
  - 685 lines of tests: reconciliation, merge detection, worktree freshness (7 tests), stale removal (3 tests), false positive prevention
- **Fix: chain mode with pre-existing worktrees** (#289)
  - Existing worktrees are rebased onto previous chain link in chain mode
  - Conflict detection with graceful abort and user-facing warnings
  - `chain` and `qaGate` flags now recorded in run logs
- **QA script verification overrides** (#176)
  - Approved override categories for cosmetic script changes
    (syntax-only, comments, type annotations, import reorg, dead code)
  - Structured override format with risk assessment (None/Low/Medium)
  - Decision flow: overrides only for clear-cut zero-runtime-impact changes
- **Test tautology detector** (#298)
  - Flags `it()`/`test()` blocks that never call imported production functions
  - String-aware parser: nested template literals, `//` and `/* */` comments filtered
  - JS-identifier boundaries (`[\w$]` lookahead/lookbehind) prevent substring false positives
  - CLI: `scripts/qa/tautology-detector-cli.ts` (`--json`, `--verbose`)
  - QA integration: `quality-checks.sh` section 10, >50% tautological blocks merge
  - QA cache: `test-quality` check type in `qa-cache.ts`
  - 52 unit tests + 5 CLI integration tests
  - Documentation: `docs/features/test-tautology-detector.md`
- **Skill prompt tool alignment** (#265)
  - Audited all 18 `.claude/skills/` and 15 `templates/skills/` files
  - Converted bash file operations to Claude Code dedicated tools:
    `grep -r` → `Grep()`, `find` → `Glob()`, `sed -i` → `Edit()`, `cat` → `Read()`
  - 21 files updated across 13 skills (assess, exec, fullsolve, improve, loop, merger, qa, release, security-review, solve, spec + templates)
  - Preserves CLI output processing as bash (piped git/gh output, .sh scripts)
- **Fix: phase marker regex matches inside code blocks** (#269)
  - `stripMarkdownCode()` pre-strips fenced blocks and inline code
    before phase marker regex matching
  - Handles 3+ backtick/tilde fences per CommonMark spec
  - 5 regression tests (backtick, tilde, 4+ backtick, inline, mixed)
- **Test: gh CLI wrapper error path coverage** (#270)
  - Unit tests for `getIssuePhase`, `getCompletedPhases`,
    `getResumablePhasesForIssue` error and success paths
  - Mocks `child_process.execSync` following `state-utils.test.ts` pattern
  - 9 new tests covering all 5 AC items plus edge cases

### v1.14.0

- **GitHub-based smart resumption**
  - `sequant run --resume` skips completed phases across
    sessions, machines, and users
  - Reads phase markers from GitHub issue comments
  - 32 unit tests + 8 integration tests
- **`--resume` integration tests**
  - Extracted `filterResumedPhases()` helper from `run.ts`
  - Covers: flag parsing, phase filtering, failed phase retry,
    error fallback
- **Sub-agent type restrictions**
  - Skills declare `Task(agent_type)` in frontmatter
  - `/spec` → `Task(Explore)`, `/exec` → `Task(general-purpose)`
  - Skills without sub-agents have `Task` removed entirely
- **Scope assessment**
  - Detects overscoped issues via AC clustering and title verbs
  - Verdicts: `SCOPE_OK` / `SCOPE_WARNING` /
    `SCOPE_SPLIT_RECOMMENDED`
  - `--skip-scope-check` flag to bypass
- **AC status management CLI**
  - `init-ac` and `ac` commands for state CLI
  - `/qa` persists AC verification status to workflow state
- **Pre-PR lint validation**
  - `npm run lint` added to quality gates (build → lint → test)
  - Graceful skip for projects without lint script
- **Animated phase spinners**
  - `ora` spinners with elapsed time during `sequant run`
  - Progress indicators (1/3, 2/3, 3/3), TTY fallback
  - 35 unit tests
- **`/loop` orchestrated mode** — reads QA findings from
  GitHub comments when `SEQUANT_ORCHESTRATOR` is set
- **Better SDK error diagnostics** — captures stderr from
  Claude Code CLI (up to 500 chars), streams with `--verbose`
- **Derived AC decoupling** — flexible model replacing
  hardcoded quality dimensions (#251)

### Earlier Additions (v1.13.0)

- **QA caching**
  - Caches check results keyed by diff hash + config hash
  - `--no-cache` to force fresh run
  - Graceful degradation on corrupted cache; 36 unit tests
- **Testgen auto-detection**
  - `/spec` and `/solve` recommend `--testgen` for testable ACs
- **Enhanced CLI UI**
  - Spinners (`ora`), boxes (`boxen`), tables (`cli-table3`)
  - Graceful degradation for CI, non-TTY, Windows legacy
  - 73 unit tests
- **Feature Quality Planning**
  - 6 dimensions in `/spec`: completeness, error handling,
    code quality, test coverage, best practices, polish
  - Generates Derived ACs from quality checklist items
  - `/qa` verifies with threshold-based status
- **Skill command verification**
  - Detects skill file changes, validates CLI commands
  - Blocks `READY_FOR_MERGE` on invalid syntax/fields
- **Build verification against main** — distinguishes
  regressions from pre-existing failures
- **CI status awareness** — checks `gh pr checks`,
  blocks merge when CI is pending
- **AC linting** — flags vague/unmeasurable AC before
  implementation
- **Semgrep static analysis**
  - Stack-aware rulesets, graceful skip when not installed
  - Custom rules via `.sequant/semgrep-rules.yaml`
- **Stack-aware constitution templates**
  - Auto-detects stack, injects testing/linting/build notes
  - 9 stacks: Next.js, Astro, SvelteKit, Remix, Nuxt,
    Rust, Python, Go, Generic
- **Interactive stack selection** — `--interactive` mode
  with multi-stack support for monorepos
- Auto-detect project name from package.json, Cargo.toml,
  pyproject.toml, go.mod, git remote
- **Plugin marketplace integration** — CI-enforced version
  sync, structure validation, `/release` auto-syncs
- Strict QA verdicts (`NEEDS_VERIFICATION`, `PARTIALLY_MET`)
- MCP server support for headless mode
- VS Code extension with workflow visualization
- Sub-agent prompt templates for `/exec`
- `/merger` skill for multi-issue integration

---

## Installation Methods

### As NPM Package

```bash
# Global install
npm install -g sequant
sequant init

# Or via npx
npx sequant init
```

### As Claude Code Plugin

```bash
# Inside Claude Code
/plugin install sequant
```

### Plugin Configuration

Sequant's plugin config lives in `.claude-plugin/`:
- `plugin.json` — Plugin metadata
- `marketplace.json` — Marketplace listing

---

## What Makes Sequant Different

| Feature | Without Sequant | With Sequant |
|---------|-----------------|--------------|
| **Planning** | "I'll figure it out as I go" | AC extracted, plan reviewed |
| **Isolation** | All work in one branch | Worktree per issue |
| **Quality** | "Looks good to me" | Automated checks, verdicts |
| **State** | "Where was I?" | Full phase tracking |
| **Learning** | Start fresh each time | Analytics on what works |

---

## Philosophy

**Local-first, always.** Your code stays on your machine.
No telemetry. No cloud dependencies (except GitHub, which
you're already using).

**Phases, not chaos.** Breaking work into discrete phases
(plan, build, test, review) catches problems early and
ensures nothing gets skipped.

**Quality gates, not gatekeeping.** Automated checks help
you ship better code faster. They're not there to slow you
down — they're there to catch what you'd miss at 2am.

**Works with Claude Code, not against it.** Sequant enhances
Claude Code with structure. It doesn't replace your workflow
— it quantizes it.

---

## Contributing

Sequant is MIT licensed. Contributions welcome.

```bash
# Clone and setup
git clone https://github.com/yourusername/sequant
cd sequant
npm install

# Run tests
npm test

# Build
npm run build
```

---

## Stats Summary

| What | How Many |
|------|----------|
| Slash Commands | 18 |
| CLI Commands | 11 |
| Library Modules | 46 |
| Test Files | 55 |
| Docs Files | 39 |
| Stack Configs | 9 |
| Reference Docs | 11 |
| Hook Lines | 450+ |
| Dashboard Lines | 1000+ |
| TypeScript LOC | ~36,600 |

**Current Version:** 1.16.1
**Status:** Production-ready
**Philosophy:** Quantize your workflow

---

## The Full Picture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SEQUANT v1.16.1                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SKILLS (18)              CLI (11)                LIBRARIES (45)            │
│  ───────────              ───────                 ──────────────            │
│  /spec                    sequant init            stacks.ts                 │
│  /exec                    sequant doctor          templates.ts              │
│  /test                    sequant run             state-manager.ts          │
│  /qa                      sequant status          metrics-writer.ts         │
│  /fullsolve               sequant update          ac-parser.ts              │
│  /solve                   sequant state           project-name.ts           │
│  /loop                    sequant stats           ... and 38 more           │
│  /testgen                 sequant logs                                      │
│  /verify                  sequant merge           HOOKS (450+ lines)        │
│  /docs                    sequant dashboard       ─────────────────         │
│  /assess                  DASHBOARD (1000+)       Security guardrails       │
│  /clean                   ─────────────────       Secret detection          │
│  /improve                 Hono + htmx + SSE       Conventional commits      │
│  /reflect                 Live issue cards        Worktree enforcement      │
│  /security-review         AC tracking             File locking              │
│                           Phase indicators        Reset protection          │
│                                                                             │
│  REFERENCE DOCS (10)      VS CODE EXTENSION       STACKS (9)                │
│  ──────────────────       ─────────────────       ──────────                │
│  Quality gates            Workflow tree view      Next.js, Astro            │
│  Code review checklist    Issue tracking          SvelteKit, Remix          │
│  Security checklists      Worktree commands       Nuxt, Rust                │
│  Verification criteria    GitHub integration      Python, Go                │
│  Documentation tiers      Copy branch names       Generic                   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  TEST FILES: 55  │  DOCS: 39   │  PLATFORMS: macOS, Linux, Windows WSL      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

*Built with obsessive attention to quality gates, because that's kind of the whole point.*

---

*Last updated: 2026-02-21 · `5025e55` feat(#298): Add test tautology detector to QA quality gates*
