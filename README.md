# Sequant

**Structured AI workflow for GitHub issues.**

Turn GitHub issues into working code through sequential AI-assisted phases with quality gates.

[![npm version](https://img.shields.io/npm/v/sequant.svg)](https://www.npmjs.com/package/sequant)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

## Why Sequant?

When using AI coding assistants, work can become scattered and quality inconsistent. Sequant solves this by:

- **Consistent quality** — Every issue goes through the same review gates
- **Traceable decisions** — Plans and progress documented in GitHub issues
- **Isolated work** — Git worktrees prevent half-finished features from polluting main
- **AI-assisted** — Claude Code handles implementation while you review and approve

## How It Works

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  /spec  │───▶│  /exec  │───▶│  /test  │───▶│   /qa   │───▶ Merge
└─────────┘    └─────────┘    └─────────┘    └─────────┘
     │              │              │              │
     ▼              ▼              ▼              ▼
   Plan          Build          Verify        Review
  (drafts AC)   (worktree)    (optional)    (vs criteria)
```

1. **`/spec`** — Reads issue, drafts implementation plan, posts to GitHub for your approval
2. **`/exec`** — Creates isolated git worktree, implements changes, runs tests
3. **`/test`** — Optional browser/CLI verification
4. **`/qa`** — Reviews code against acceptance criteria, suggests fixes

## Quick Start

### Prerequisites

| Requirement | Check Command | Notes |
|------------|---------------|-------|
| [Claude Code](https://claude.ai/code) | `claude --version` | Required |
| [GitHub CLI](https://cli.github.com/) | `gh auth status` | Required, must be authenticated |
| Node.js 18+ | `node --version` | Required |
| Git | `git --version` | Required |
| [jq](https://jqlang.github.io/jq/) | `jq --version` | Optional, improves hook performance |

> **Note:** Sequant currently requires GitHub for issue tracking. GitLab and Bitbucket support is planned for a future release. See [Platform Requirements](docs/platform-requirements.md) for workarounds if you use a different platform.

### Setup

```bash
# Install and initialize in your project
npx sequant init

# Verify installation and prerequisites
npx sequant doctor
```

The `doctor` command checks all prerequisites including GitHub CLI authentication.

### First Workflow

Open Claude Code in your project, then:

```bash
/spec 123    # Plan implementation for GitHub issue #123
/exec 123    # Implement the feature in a worktree
/qa 123      # Quality review before merge
```

> Replace `123` with an actual GitHub issue number from your repository.

## Installation

```bash
npm install -g sequant
# or use npx
npx sequant init
```

## Features

- **🔢 Quantized** - Each issue is an atomic unit of work
- **🔄 Sequential** - Phases execute in order with gates
- **🚦 Gated** - Quality checks before progression
- **🌳 Isolated** - Git worktrees prevent cross-contamination
- **📦 Stack Adapters** - Pre-configured for Next.js, Rust, Python, Go
- **🔄 Update-Safe** - Customize without losing updates

## Optional MCP Integrations

Sequant works fully without any MCP servers, but these optional integrations enhance specific workflows. See the [MCP Integrations Guide](docs/mcp-integrations.md) for detailed setup and troubleshooting.

| MCP Server | Skills | Purpose | Install |
|------------|--------|---------|---------|
| [Chrome DevTools](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-chrome-devtools) | `/test`, `/testgen`, `/loop` | Browser automation for UI testing | See [setup guide](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-chrome-devtools#setup) |
| [Context7](https://github.com/upstash/context7) | `/exec`, `/fullsolve` | External library documentation lookup | `npx -y @anthropic/mcp-cli add upstash/context7` |
| [Sequential Thinking](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-sequential-thinking) | `/fullsolve` | Complex multi-step reasoning | See [setup guide](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-sequential-thinking#setup) |

**What happens without MCPs:**
- `/test` and `/testgen` fall back to manual testing instructions
- `/exec` uses codebase search instead of library docs lookup
- `/fullsolve` uses standard reasoning (no extended thinking)

Run `sequant doctor` to check which optional MCPs are configured.

## Commands

### CLI Commands

```bash
npx sequant init              # Initialize in your project
npx sequant update            # Update templates from package
npx sequant doctor            # Check installation health
npx sequant status            # Show version and config
npx sequant run <issues...>   # Execute workflow for issues
```

#### Run Command Options

```bash
npx sequant run 123                    # Single issue
npx sequant run 1 2 3                  # Multiple issues in parallel
npx sequant run 1 2 3 --sequential     # Run in order
npx sequant run 123 --phases spec,qa   # Custom phases
npx sequant run 123 --quality-loop     # Auto-retry on failures
npx sequant run 123 --dry-run          # Preview without execution
```

#### Quality Loop

Quality loop provides automatic fix iterations when phases fail:

```bash
npx sequant run 123 --quality-loop              # Enable for any issue
npx sequant run 123 --quality-loop --max-iterations 5  # Custom limit
```

**How it works:**
1. Runs phases normally (spec → exec → qa)
2. If a phase fails, runs `/loop` to fix issues
3. Re-runs failed phases after fixes
4. Iterates up to 3 times (default)

**Smart defaults:** Quality loop auto-enables for issues with `complex`, `refactor`, `breaking`, or `major` labels—no flag needed.

#### Phase Detection

When you run `sequant run`, phases are determined automatically using a three-level detection system:

1. **Explicit phases** — If you specify `--phases`, those are used
2. **Spec-driven** — Otherwise, `/spec` runs first and outputs a recommended workflow
3. **Label-based fallback** — If spec parsing fails, issue labels determine phases

**Label-based detection:**

| Labels | Phases | Notes |
|--------|--------|-------|
| `bug`, `fix`, `hotfix`, `patch` | `exec → qa` | Skip spec for simple fixes |
| `docs`, `documentation`, `readme` | `exec → qa` | Skip spec for docs changes |
| `ui`, `frontend`, `admin`, `web`, `browser` | `spec → exec → test → qa` | Add browser testing |
| `complex`, `refactor`, `breaking`, `major` | (default phases) | Enable quality loop |

**Spec-driven detection:**

The `/spec` command outputs a recommended workflow that the CLI parses:

```markdown
## Recommended Workflow

**Phases:** exec → test → qa
**Quality Loop:** disabled
**Reasoning:** UI changes detected, adding browser testing phase
```

**CLI examples:**

```bash
# Phases auto-detected (default)
npx sequant run 123

# Explicit phases (skip auto-detection)
npx sequant run 123 --phases exec,qa

# Disable logging for one run
npx sequant run 123 --no-log

# Enable quality loop for complex changes
npx sequant run 123 --quality-loop
```

### Workflow Commands (in Claude Code)

| Command | Phase | Purpose |
|---------|-------|---------|
| `/assess` | 0 | Issue triage and status assessment |
| `/spec` | 1 | Plan implementation vs acceptance criteria |
| `/exec` | 2 | Implement in feature worktree |
| `/test` | 2.5 | Browser-based UI testing (optional) |
| `/verify` | 2.5 | CLI/script verification (optional) |
| `/qa` | 3 | Code review and quality gate |
| `/docs` | 4 | Generate feature documentation |
| `/loop` | * | Fix iteration when tests fail |
| `/fullsolve` | 1-4 | Complete pipeline in one command |

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| macOS | ✅ Tested | Full support with Claude Code, Cursor, VS Code |
| Linux | ✅ Supported | Bash required for shell scripts |
| Windows WSL | ✅ Supported | Use WSL2 with bash |
| Windows Native | ⚠️ Limited | CLI works, but shell scripts require WSL |

### Windows Users

**WSL is recommended** for the full Sequant experience on Windows. Here's why:

| Feature | Native Windows | Windows + WSL |
|---------|----------------|---------------|
| CLI commands (`init`, `doctor`, `status`) | ✅ Works | ✅ Works |
| Workflow hooks (pre-tool, post-tool) | ❌ Requires bash | ✅ Works |
| Shell scripts (`new-feature.sh`, etc.) | ❌ Requires bash | ✅ Works |
| Git worktree workflows | ✅ Works | ✅ Works |

**Quick WSL Setup:**

1. Install WSL (run in PowerShell as Administrator): `wsl --install`
2. Restart your computer when prompted
3. Open Ubuntu from Start menu and complete setup
4. Install Node.js: See [NodeSource distributions](https://github.com/nodesource/distributions)
5. Install GitHub CLI: `apt install gh` then `gh auth login`
6. Use Sequant: `npx sequant init`

For detailed instructions, see [Microsoft's WSL documentation](https://learn.microsoft.com/en-us/windows/wsl/install).

### Requirements

- **Node.js** 18.0.0 or higher
- **Git** for worktree support
- **GitHub CLI** (`gh`) for issue integration — must be authenticated via `gh auth login`
- **Bash** for shell scripts (included in macOS/Linux, use WSL on Windows)
- **jq** (optional) for faster JSON parsing in hooks — falls back to grep if not installed

### IDE Compatibility

| IDE | Status |
|-----|--------|
| Claude Code | ✅ Full support |
| Cursor | ✅ Supported |
| VS Code + Copilot | ✅ Supported |

## Stack Support

Sequant auto-detects your project stack and configures appropriate commands:

| Stack | Detection | Test | Build | Lint |
|-------|-----------|------|-------|------|
| Next.js | `next.config.*` | `npm test` | `npm run build` | `npm run lint` |
| Rust | `Cargo.toml` | `cargo test` | `cargo build --release` | `cargo clippy` |
| Python | `pyproject.toml` | `pytest` | `python -m build` | `ruff check .` |
| Go | `go.mod` | `go test ./...` | `go build ./...` | `golangci-lint run` |

## Customization

### Local Overrides

Create files in `.claude/.local/` to override templates without losing updates:

```
.claude/
├── skills/           # Package-provided (updated by sequant update)
├── skills.local/     # Your overrides (never modified)
├── hooks/            # Package-provided
├── hooks.local/      # Your overrides
└── memory/           # Your project context (never modified)
```

### Constitution

Edit `.claude/memory/constitution.md` to define project-specific principles:

```markdown
# My Project Constitution

## Core Principles
1. Always use TypeScript strict mode
2. Test coverage must exceed 80%
3. All PRs require security review

## Naming Conventions
- Components: PascalCase
- Utilities: camelCase
- Constants: SCREAMING_SNAKE_CASE
```

### Settings

Configure `sequant run` defaults in `.sequant/settings.json`:

```json
{
  "version": "1.0",
  "run": {
    "logJson": true,
    "logPath": ".sequant/logs",
    "autoDetectPhases": true,
    "timeout": 300,
    "sequential": false,
    "qualityLoop": false,
    "maxIterations": 3,
    "smartTests": true
  },
  "agents": {
    "parallel": false,
    "model": "haiku"
  }
}
```

#### Run Settings

| Option | Default | Description |
|--------|---------|-------------|
| `logJson` | `true` | Enable JSON logging for run sessions |
| `logPath` | `.sequant/logs` | Directory for log files |
| `autoDetectPhases` | `true` | Auto-detect phases from labels/spec output |
| `timeout` | `300` | Timeout per phase in seconds |
| `sequential` | `false` | Run issues sequentially (vs parallel) |
| `qualityLoop` | `false` | Enable quality loop by default |
| `maxIterations` | `3` | Max quality loop iterations |
| `smartTests` | `true` | Auto-detect test commands |

#### Agent Settings

| Option | Default | Description |
|--------|---------|-------------|
| `parallel` | `false` | Run sub-agents in parallel (faster but higher token usage) |
| `model` | `"haiku"` | Default model for sub-agents (`haiku`, `sonnet`, or `opus`) |

##### Cost vs Speed Trade-offs

Skills like `/qa`, `/merger`, and `/fullsolve` spawn sub-agents for quality checks. The `agents` settings control how these agents execute:

| Mode | Token Usage | Speed | Best For |
|------|-------------|-------|----------|
| Sequential (`parallel: false`) | 1x (baseline) | Slower | Limited API plans, cost-conscious users |
| Parallel (`parallel: true`) | ~2-3x | ~50% faster | Unlimited plans, batch operations |

**Override per invocation:**

```bash
/qa 123 --parallel     # Force parallel (faster)
/qa 123 --sequential   # Force sequential (cheaper)
```

CLI flags override settings file values.

## Directory Structure

After `sequant init`:

```
.claude/
├── skills/              # Workflow commands
│   ├── spec/SKILL.md
│   ├── exec/SKILL.md
│   ├── qa/SKILL.md
│   └── ...
├── hooks/               # Pre/post tool hooks
│   ├── pre-tool.sh
│   └── post-tool.sh
├── memory/              # Project context
│   └── constitution.md
└── settings.json        # Hooks configuration

.sequant-manifest.json   # Version tracking
```

## Documentation

- [Run Command](docs/run-command.md) — Batch execution options
- [Customization Guide](docs/customization.md) — Override templates safely
- [MCP Integrations](docs/mcp-integrations.md) — Optional MCP server setup
- [Platform Requirements](docs/platform-requirements.md) — GitHub dependency and workarounds
- [Troubleshooting](docs/troubleshooting.md) — Common issues and solutions
- [Testing Guide](docs/testing.md) — Cross-platform testing matrix
- [Git Patterns](docs/git-patterns.md) — Worktree and merge workflows
- [Release Checklist](docs/release-checklist.md) — Pre-release verification
- Stack Guides: [Next.js](docs/stacks/nextjs.md) | [Rust](docs/stacks/rust.md) | [Python](docs/stacks/python.md) | [Go](docs/stacks/go.md)

## Philosophy

Sequant is built on these principles:

1. **Explicit over implicit** — Every phase has clear inputs and outputs
2. **Quality gates** — No phase completes without validation
3. **Isolation** — Work happens in dedicated worktrees
4. **Traceability** — All decisions recorded in GitHub issues
5. **Composability** — Use phases individually or combine them

## Acknowledgments

Built on ideas from:
- [Agent Skills](https://agentskills.io) — Open standard for cross-platform skills
- [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) — Update-safe directories

## License

MIT
