# Sequant

**Quantize your development workflow.**

Sequential AI phases with quality gates for any codebase.

[![npm version](https://img.shields.io/npm/v/sequant.svg)](https://www.npmjs.com/package/sequant)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

## The Sequant Method

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  /spec  │───▶│  /exec  │───▶│  /test  │───▶│   /qa   │───▶ Merge
└─────────┘    └─────────┘    └─────────┘    └─────────┘
     │              │              │              │
     ▼              ▼              ▼              ▼
   Plan          Build          Verify        Quality
  Approval     Implementation   (Optional)      Gate
```

Work is "quantized" into atomic units—each GitHub issue becomes a discrete quantum of work, processed through sequential phases with quality gates.

## Quick Start

```bash
# Initialize in your project
npx sequant init

# Start using in Claude Code
/spec 123    # Plan implementation for issue #123
/exec 123    # Implement the feature
/qa 123      # Quality review
```

## Installation

```bash
npm install -g sequant
# or
npx sequant init
```

## Features

- **🔢 Quantized** - Each issue is an atomic unit of work
- **🔄 Sequential** - Phases execute in order with gates
- **🚦 Gated** - Quality checks before progression
- **🌳 Isolated** - Git worktrees prevent cross-contamination
- **📦 Stack Adapters** - Pre-configured for Next.js, Rust, Python, Go
- **🔄 Update-Safe** - Customize without losing updates

## Commands

### CLI Commands

```bash
sequant init              # Initialize in your project
sequant update            # Update templates from package
sequant doctor            # Check installation health
sequant status            # Show version and config
sequant run <issues...>   # Execute workflow for issues
```

#### Run Command Options

```bash
sequant run 123                    # Single issue
sequant run 1 2 3                  # Multiple issues in parallel
sequant run 1 2 3 --sequential     # Run in order
sequant run 123 --phases spec,qa   # Custom phases
sequant run 123 --dry-run          # Preview without execution
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

### Requirements

- **Node.js** 18.0.0 or higher
- **Git** for worktree support
- **GitHub CLI** (`gh`) for issue integration
- **Bash** for shell scripts (included in macOS/Linux, use WSL on Windows)

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

## Philosophy

Sequant is built on these principles:

1. **Explicit over implicit** - Every phase has clear inputs and outputs
2. **Quality gates** - No phase completes without validation
3. **Isolation** - Work happens in dedicated worktrees
4. **Traceability** - All decisions recorded in GitHub issues
5. **Composability** - Use phases individually or combine them

## Based On

Sequant extracts and generalizes the workflow system developed for [Matcha Maps](https://github.com/admarble/matcha-maps).

Planning issue: https://github.com/admarble/matcha-maps/issues/498

Research sources:
- [Agent Skills](https://agentskills.io) - Open standard for cross-platform skills
- [BMAD Method](https://github.com/bmad-code-org/BMAD-METHOD) - Update-safe directories
- [Spec Kit](https://github.com/github/spec-kit) - Constitution pattern
- [SuperClaude](https://github.com/SuperClaude-Org/SuperClaude_Framework) - Doctor command

## License

MIT © [Matcha Maps](https://getmatchamaps.com)

---

Built with 🍵 by the Matcha Maps team
