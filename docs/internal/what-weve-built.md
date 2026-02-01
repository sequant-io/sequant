# What We've Built: Sequant v1.12.0

> **Quantize your development workflow** — Sequential AI phases with quality gates

Sequant transforms the chaos of AI-assisted development into a structured, repeatable process. Every GitHub issue becomes a journey through planning, implementation, testing, and review — with quality gates at every step.

---

## At a Glance

| Metric | Count |
|--------|-------|
| Slash Commands | 18 |
| CLI Commands | 9 |
| Core Library Modules | 30 |
| Test Files | 38 |
| Documentation Files | 26+ |
| Stack Configurations | 9 |
| Lines of TypeScript | ~17,000+ |

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

---

## Skill Commands

Sequant provides **17 slash commands** organized by purpose. Run them inside Claude Code.

### Core Workflow

The four pillars of the Sequant workflow:

| Command | Purpose | What It Does |
|---------|---------|--------------|
| `/spec` | **Plan** | Extracts acceptance criteria from issues, **lints AC for vague/unmeasurable terms**, **requires explicit verification methods** (Unit/Integration/Browser/Manual test), **Feature Quality Planning** (6 dimensions: completeness, error handling, code quality, test coverage, best practices, polish), generates Derived ACs, **content analysis** (title/body patterns → phase recommendations with signal priority: Labels > Solve > Title > Body), creates implementation plans, detects conflicts with in-flight work, posts plan comments |
| `/exec` | **Build** | Creates feature worktrees, implements incrementally, runs tests, **Pre-PR AC verification** (checks each AC addressed before PR), **shell script quality checks**, **mandatory prompt templates** for parallel sub-agents, creates PRs |
| `/test` | **Verify** | Browser automation with Chrome DevTools, screenshot evidence, **coverage analysis** (warns when files lack tests), graceful fallback to manual checklists |
| `/qa` | **Review** | Validates against AC, type safety checks, security scans, Semgrep static analysis, scope analysis, CI status awareness, build verification against main. Verdicts: `READY_FOR_MERGE`, `AC_NOT_MET`, `NEEDS_VERIFICATION`, `SECURITY_CONCERN` |

### Automation Commands

For when you want to go hands-off:

| Command | Purpose | What It Does |
|---------|---------|--------------|
| `/fullsolve` | **End-to-End** | Orchestrates spec→exec→test→qa with auto-fix loops, max iteration limits, progress tracking |
| `/solve` | **Advisor** | Analyzes issue labels and content, recommends optimal workflow, outputs ready-to-run CLI commands |
| `/loop` | **Quality Loop** | Parses test/QA findings, applies fixes, re-validates until quality gates pass |

### Testing & Verification

| Command | Purpose | What It Does |
|---------|---------|--------------|
| `/testgen` | **Test Generator** | Creates test stubs from `/spec` verification criteria |
| `/verify` | **CLI Verification** | Runs CLI commands, captures output, posts evidence to issues |
| `/docs` | **Documentation** | Auto-detects doc type, generates admin-facing operational docs |

### Analysis & Utilities

| Command | Purpose | What It Does |
|---------|---------|--------------|
| `/assess` | **Triage** | Determines current phase, detects existing artifacts, recommends next action |
| `/clean` | **Cleanup** | Archives stale files, verifies build, commits changes |
| `/improve` | **Discovery** | Scans for issues (type safety, tests, docs), creates GitHub issues, offers execution |
| `/reflect` | **Learning** | Analyzes session effectiveness, proposes documentation/process improvements |
| `/security-review` | **Security Audit** | Domain-specific checklists (auth, API, admin), threat modeling |
| `/setup` | **Initialize** | Creates worktrees directory, copies constitution template, auto-detects project name and stack, injects stack-specific notes; `--interactive` mode for guided setup, multi-stack support for monorepos |
| `/merger` | **Integration** | Multi-issue merge with conflict detection, dependency ordering, worktree cleanup |
| `/upstream` | **Release Tracking** | Monitors Claude Code releases, detects breaking changes/opportunities, auto-creates issues for sequant maintainers |

### Shared Resources

Skills share common references stored in `skills/_shared/`:
- `references/subagent-types.md` — Valid Claude Code sub-agent types
- `references/prompt-templates.md` — Task-specific templates for sub-agent spawning (component, type, CLI, test, refactor)

---

## CLI Commands

The `sequant` CLI provides **9 commands** for project management.

```bash
npm install -g sequant   # Install globally
npx sequant              # Or run via npx
```

| Command | Description |
|---------|-------------|
| `sequant init` | Initialize Sequant in a project (copies templates, creates `.claude/` and `.sequant/`) |
| `sequant doctor` | Check installation health — prerequisites, closed-issue verification, config validation |
| `sequant run <issues>` | Execute workflow for issues using Claude Agent SDK (supports `-q` quality loop, `--chain` mode) |
| `sequant status` | Show version, config, tracked issues with cleanup options |
| `sequant update` | Update skill templates to latest versions |
| `sequant state` | Manage workflow state (`init`, `rebuild`, `clean`) |
| `sequant stats` | View local workflow analytics — success rates, timing, phase distribution |
| `sequant logs` | View and manage log files with rotation |
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
| `stacks.ts` | Detects project type (Next.js, Astro, SvelteKit, Remix, Nuxt, Rust, Python, Go), package manager, provides build/test commands, stack-specific constitution notes |
| `semgrep.ts` | Stack-aware Semgrep static analysis integration — ruleset mapping, graceful degradation, custom rules support, verdict contribution |
| `templates.ts` | Copies skill templates to `.claude/`, handles variable substitution |
| `manifest.ts` | Tracks installed skills and versions in `.sequant-manifest.json` |
| `settings.ts` | Reads/writes `.sequant/settings.json` for persistent configuration |
| `config.ts` | Core configuration file operations |
| `fs.ts` | Async file helpers (`exists`, `read`, `write`, `ensureDir`) |
| `system.ts` | Validates prerequisites (`gh` CLI, `jq`), MCP server configuration |
| `tty.ts` | Detects interactive vs non-interactive mode |
| `wizard.ts` | Guides users through dependency installation |
| `shutdown.ts` | Signal handling for graceful shutdown |
| `version-check.ts` | Checks for updates, warns on stale local installs |
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

---

## Stack Support

Sequant auto-detects your project type and configures itself appropriately. Each stack injects specific testing, linting, and build notes into your constitution template.

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

**27 test files** ensure reliability.

### Test Coverage

| Area | Test Files |
|------|------------|
| **Commands** | `init`, `doctor`, `run`, `status`, `state`, `stats` |
| **Libraries** | `fs`, `stacks`, `system`, `templates`, `wizard`, `tty`, `shutdown`, `version-check`, `ac-parser`, `ac-linter`, `project-name` |
| **Workflow** | `state-manager`, `state-utils`, `state-hook`, `log-writer`, `log-rotation`, `metrics-writer` |
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
- `concepts/workflow-phases.md` — Phase overview and selection

### Guides
- `guides/customization.md` — Configuration options
- `guides/mcp-integrations.md` — MCP server configuration
- `guides/git-workflows.md` — Git workflow patterns

### Reference
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

The **pre-tool hook** (`templates/hooks/pre-tool.sh`) is a 450+ line security and quality enforcement system. It intercepts every tool call before execution.

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

When `SEQUANT_WORKTREE` is set (by `sequant run`), blocks file edits outside the designated worktree. Prevents accidental edits to the main repo during feature work.

### File Locking for Parallel Agents

Uses `lockf` (macOS) or `flock` (Linux) to prevent concurrent edits to the same file when multiple agents run in parallel.

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
| `qa/references/quality-gates.md` | Verdict criteria (READY_FOR_MERGE, AC_NOT_MET, etc.) |
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
- **Dynamic stack-specific notes** — Auto-injected based on detected stack (Next.js, Astro, SvelteKit, Remix, Nuxt, Rust, Python, Go) with testing, linting, and build conventions
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
- `/setup` skill for easy initialization
- Auto-detect project name
- VS Code extension
- Dashboard for workflow visualization
- **Claude Code Plugin** marketplace listing

### Recent Additions (v1.12.0)
- **Feature Quality Planning** — `/spec` now includes a comprehensive quality planning section with 6 dimensions (Completeness, Error Handling, Code Quality, Test Coverage, Best Practices, Polish). Generates Derived ACs from quality checklist items. `/exec` references the quality plan during implementation and explicitly extracts/tracks derived ACs in Pre-PR verification. `/qa` verifies quality plan items with threshold-based status (Complete ≥80%, Partial ≥50%, Not Addressed <50%) and includes derived ACs in AC Coverage table with source attribution
- **Skill command verification** — `/qa` now detects skill file changes (`.claude/skills/**/*.md`), extracts referenced CLI commands, validates JSON field names against `--help` output, and blocks `READY_FOR_MERGE` if commands have invalid syntax or non-existent fields (prevents bugs like #178's `conclusion` field issue)
- **Build verification against main** — `/qa` now verifies if build failures are regressions or pre-existing issues on main branch, preventing false "unrelated to our changes" dismissals
- **CI status awareness** — `/qa` checks GitHub CI status via `gh pr checks`, preventing `READY_FOR_MERGE` when CI is still pending
- **AC linting** — `/spec` flags vague, unmeasurable, or incomplete acceptance criteria before implementation begins
- **Semgrep static analysis integration** — `/qa` now runs Semgrep with stack-aware rulesets (Next.js, Python, Go, Rust, etc.), graceful skip when not installed, custom rules via `.sequant/semgrep-rules.yaml`, critical findings block merge verdict
- **Stack-aware constitution templates** — `/setup` auto-detects project stack and injects stack-specific notes for testing, linting, and build conventions (supports Next.js, Astro, SvelteKit, Remix, Nuxt, Rust, Python, Go)
- **Interactive stack selection & multi-stack support** — `/setup --interactive` offers guided stack configuration with confirmation prompts; monorepos get checkbox selection for multiple stacks (e.g., Next.js frontend + Python backend) with combined constitution notes
- Auto-detect project name from package.json, Cargo.toml, pyproject.toml, go.mod, git remote
- **Plugin marketplace integration** — Claude Code plugin with CI-enforced version sync (plugin.json must match package.json), structure validation on every PR, `/release` skill auto-syncs versions
- Strict QA verdicts (`NEEDS_VERIFICATION`, proper `PARTIALLY_MET`)
- MCP server support for headless mode
- VS Code extension with premium workflow visualization
- Sub-agent prompt templates for `/exec` (component, type, CLI, test, refactor)
- `/merger` skill for multi-issue integration with conflict detection

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

**Local-first, always.** Your code stays on your machine. No telemetry. No cloud dependencies (except GitHub, which you're already using).

**Phases, not chaos.** Breaking work into discrete phases (plan, build, test, review) catches problems early and ensures nothing gets skipped.

**Quality gates, not gatekeeping.** Automated checks help you ship better code faster. They're not there to slow you down — they're there to catch what you'd miss at 2am.

**Works with Claude Code, not against it.** Sequant enhances Claude Code with structure. It doesn't replace your workflow — it quantizes it.

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
| CLI Commands | 9 |
| Library Modules | 23 |
| Test Files | 28 |
| Docs Files | 26+ |
| Stack Configs | 9 |
| Reference Docs | 11 |
| Hook Lines | 450+ |
| Dashboard Lines | 1000+ |
| TypeScript LOC | ~17,000+ |

**Current Version:** 1.12.0
**Status:** Production-ready
**Philosophy:** Quantize your workflow

---

## The Full Picture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SEQUANT v1.12.0                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SKILLS (17)              CLI (9)                 LIBRARIES (23)            │
│  ───────────              ───────                 ──────────────            │
│  /spec                    sequant init            stacks.ts                 │
│  /exec                    sequant doctor          templates.ts              │
│  /test                    sequant run             state-manager.ts          │
│  /qa                      sequant status          metrics-writer.ts         │
│  /fullsolve               sequant update          ac-parser.ts              │
│  /solve                   sequant state           project-name.ts           │
│  /loop                    sequant stats           ... and 16 more           │
│  /testgen                 sequant logs                                      │
│  /verify                  sequant dashboard       HOOKS (450+ lines)        │
│  /docs                                            ─────────────────         │
│  /assess                  DASHBOARD (1000+)       Security guardrails       │
│  /clean                   ─────────────────       Secret detection          │
│  /improve                 Hono + htmx + SSE       Conventional commits      │
│  /reflect                 Live issue cards        Worktree enforcement      │
│  /security-review         AC tracking             File locking              │
│  /setup                   Phase indicators        Reset protection          │
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
│  TEST FILES: 28  │  DOCS: 26+  │  PLATFORMS: macOS, Linux, Windows WSL      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

*Built with obsessive attention to quality gates, because that's kind of the whole point.*
