# Sequant

**Spec-driven AI coding agents — every acceptance criterion verified, stops at the human merge gate.**

For teams that can't ship un-reviewed AI code. Solve GitHub issues with structured phases and quality gates — from issue to merge-ready PR.

**[sequant.io](https://sequant.io)** — docs, guides, and getting started.

[![npm version](https://img.shields.io/npm/v/sequant.svg)](https://www.npmjs.com/package/sequant)
[![npm downloads](https://img.shields.io/npm/dm/sequant.svg)](https://www.npmjs.com/package/sequant)
[![GitHub stars](https://img.shields.io/github/stars/sequant-io/sequant.svg)](https://github.com/sequant-io/sequant/stargazers)
[![CI](https://github.com/sequant-io/sequant/actions/workflows/ci.yml/badge.svg)](https://github.com/sequant-io/sequant/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

AI coding agents write code well, but leave you to run the workflow around it — planning, isolation, review, and merge safety. Sequant wraps an agent in a structured **spec → exec → qa** pipeline with isolated git worktrees and quality gates, taking a GitHub issue from triage to a merge-ready PR without babysitting each step.

See the [CHANGELOG](CHANGELOG.md) for release notes, or the [migration guide](CHANGELOG.md#migration-from-v1x) if upgrading from v1.x.

### What's new in 2.5

- **`sequant ready <issue>`** — a post-resolve A+ QA gate that drives a resolved issue through a full-weight `qa → loop → qa` pass and **stops at the human merge gate — it never merges**.
- **Live phase-matrix TUI** — `sequant ready` and `sequant run` render the active phase and quality-loop iteration in place (boxed Ink dashboard on a TTY by default), so a long run is never indistinguishable from a hang. Opt out with `--no-tui` (line renderer) or `-s`/`--quiet` (heartbeat-only); non-TTY output auto-degrades.
- **Per-issue concurrency locks** — a second session on the same issue is skipped with a clear message instead of clobbering the first; `sequant locks` inspects and clears them.

## Quick Start

### Prerequisites

**An AI coding agent — one of:**
- [Claude Code](https://claude.ai/code) — default agent
- [Aider](https://aider.chat/) — alternative, via `--agent aider`

**Always required (both):**
- [GitHub CLI](https://cli.github.com/) — run `gh auth login`
- Git — for worktree-based isolation

**For the npm/CLI install path:** Node.js 22.12+

**Optional MCP (Model Context Protocol) servers — enhanced features:**
- `chrome-devtools` — enables `/test` for browser-based UI testing
- `sequential-thinking` — enhanced reasoning for complex decisions
- `context7` — library documentation lookup

> **Note:** Sequant is optimized for Node.js/TypeScript projects. The worktree workflow works with any git repository.

### Install

Pick the path that matches **where you run Sequant**:

**Inside Claude Code (plugin)** — skills, hooks, and MCP tools, no npm required:
```
/plugin install sequant@sequant-io/sequant
/sequant:setup
```

**Headless / CI (npm package)** — drive runs from the terminal or a CI job:
```bash
npm install sequant          # or: pnpm add / yarn add / bun add sequant
npx sequant init             # install skills into your project
npx sequant doctor           # verify setup
```

### Your first run

Inside Claude Code, solve an issue end-to-end:
```
/fullsolve 123
```

Or headless from the terminal (`-Q` runs the quality loop):
```bash
npx sequant run 123 -Q
```

Either way, Sequant creates an isolated worktree, posts a plan comment to the issue, and opens a merge-ready PR.

### What a run looks like

A real `/fullsolve 683` (the run that built `sequant ready` itself):

```text
SEQUANT WORKFLOW · #683
  spec   ✔  9 ACs extracted · plan posted to the issue
  exec   ✔  29 tests + docs + lint fix · committed to the feature branch
  qa     ✔  full build + suite · 8/9 ACs MET · 1 manual AC marked PENDING (not faked)
  pr     ✔  opened #686 · 7/7 checks green · MERGEABLE

  → stops at the human merge gate · never auto-merges · run `merge` to land it
```

QA findings post back to the issue as comments, with each acceptance criterion re-checked independently.

> 📹 A recorded demo GIF of the live run grid is coming — tracked in [#695](https://github.com/sequant-io/sequant/issues/695).

---

## How It Works

Sequant enforces a structured workflow through slash commands (interactive) or CLI (headless):

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  /spec  │───▶│  /exec  │───▶│  /test  │───▶│   /qa   │───▶ Merge
└─────────┘    └─────────┘    └─────────┘    └─────────┘
     │              │              │              │
     ▼              ▼              ▼              ▼
   Plan          Build        Verify (UI)     Review
```

> `/test` is optional — used for UI features when Chrome DevTools MCP is available.

### Worktree Isolation

Sequant uses Git worktrees to isolate each issue's work:

```
your-project/           # Main repo (stays on main branch)
../worktrees/
  feature/
    123-add-login/     # Issue #123 worktree (feature branch)
    456-fix-bug/       # Issue #456 worktree (feature branch)
```

**Why worktrees?**
- Work on multiple issues simultaneously
- Never pollute your main branch
- Each issue has its own dependencies and build
- Safe to discard failed experiments

### Quality Gates

Every `/qa` runs automated checks:

- **AC Adherence** — Code verified against acceptance criteria
- **Type Safety** — Detects `any`, `as any`, missing types
- **Security Scans** — OWASP-style vulnerability detection
- **Semgrep Static Analysis** — Stack-aware rulesets, custom rules via `.sequant/semgrep-rules.yaml`
- **Scope Analysis** — Flags changes outside issue scope
- **Execution Evidence** — Scripts/CLI must pass smoke tests
- **Test Quality** — Validates test coverage and mock hygiene
- **Anti-Pattern Detection** — Catches N+1 queries, empty catch blocks, stale dependencies

When checks fail, `/loop` automatically fixes and re-runs (up to 3x).

---

## Using Sequant

### Solve one issue (the 80% path)

The most common invocation — no flags. Auto-creates a worktree, posts a plan comment to the issue, and opens a PR.

In Claude Code:
```
/fullsolve 123
```

Headless (`-Q` runs the quality loop):
```bash
npx sequant run 123 -Q
```

> `sequant run --help` is the authoritative flag list. There is **no** `--skip-spec` — to skip the plan phase, use `--phases exec,qa`.

### Batch: triage, then run

For several issues at once, the ritual is `/assess` → paste the commands it emits:

```
/assess 101 102 103
```

`/assess` returns a dashboard (PROCEED / PARK / CLOSE per issue), dependency ordering, and ready-to-paste commands like `npx sequant run 101 -Q`. The quality loop (`-Q`) is part of every command it generates.

### From Claude Code, via the MCP server

With the plugin installed, drive runs through the MCP server from inside Claude Code:

```
use sequant plugin to fullsolve 123
```

You get back a structured phase-timing table and verdict. The same tools — `sequant_run`, `sequant_status`, `sequant_logs` — are available to any MCP client; `npx sequant serve` exposes them headlessly.

### QA on the issue

Re-verify a resolved issue or PR. Findings land as **issue comments**, with each acceptance criterion independently re-checked:

```
123 any gaps?     # re-QA issue #123
/qa pr488         # re-QA a PR
```

### Merge

```
merge             # squash-merge + sync main + worktree cleanup + post-merge build/test
```

---

## Command Reference

Most work goes through a handful of top-level commands. The rest are either pipeline internals (run for you) or occasional tools.

### Everyday

| Command | What it does |
|---------|--------------|
| `/fullsolve <issue>` | Complete spec → exec → qa pipeline; opens a PR. The 80% path. |
| `/assess <issues…>` | Triage one or more issues; emits a dashboard + ready-to-paste `run` commands (6-action vocabulary). |
| `npx sequant run <issues…>` | Headless equivalent of `/fullsolve`; batches run in parallel. Add `-Q` for the quality loop. |
| `/qa <issue>` | Code review + quality gate; posts findings as issue comments. |
| `npx sequant merge <issues…>` | Batch integration QA before merging. |

### Pipeline internals

`/spec`, `/exec`, `/loop`, `/testgen`, `/test` are the phases that `/fullsolve` and `sequant run` orchestrate for you. You can invoke them directly, but rarely need to.

### Occasional / advanced

| Command | What it does |
|---------|--------------|
| `sequant ready <issue>` | Post-resolve full-weight A+ QA gate; drives to merge-readiness, then stops at the human merge gate (never merges). |
| `/merger` | Multi-issue merge coordination. |
| `/improve` | Codebase analysis and improvement discovery. |
| `/security-review` | Deep security analysis. |
| `/verify` | CLI/script execution verification. |
| `/docs` · `/clean` · `/reflect` | Feature docs, repo cleanup, workflow reflection. |

### CLI utilities

```bash
npx sequant init              # initialize in project
npx sequant update            # update skill templates
npx sequant doctor            # check installation
npx sequant status            # show version and config
npx sequant state <cmd>       # manage workflow state (init/rebuild/clean)
npx sequant locks <cmd>       # inspect/clear per-issue concurrency locks
npx sequant stats             # local workflow analytics (cohort filter: --label / --since)
npx sequant dashboard         # real-time workflow dashboard
npx sequant serve             # expose workflow tools over MCP
```

See [Run Command Options](docs/reference/run-command.md), [Merge Command](docs/reference/merge-command.md), [State Command](docs/reference/state-command.md), and [Analytics](docs/reference/analytics.md) for details.

---

## Concurrency

Multi-issue runs are parallel by default, and a per-issue lock (`.sequant/locks/<issue>.lock`) stops two sessions from clobbering the same issue — see [Concurrency & Per-Issue Locks](docs/reference/concurrency.md) for stale recovery, takeover (`--force`), and `sequant locks` subcommands.

---

## Configuration

```json
// .sequant/settings.json
{
  "run": {
    "qualityLoop": false,
    "maxIterations": 3,
    "defaultBase": "feature/dashboard"  // Optional: custom default base branch
  }
}
```

See [Customization Guide](docs/guides/customization.md) for all options.

---

## Platform Support

| Platform | Status |
|----------|--------|
| macOS | ✅ Full support |
| Linux | ✅ Full support |
| Windows WSL | ✅ Full support |
| Windows Native | ⚠️ CLI only |

---

## Documentation

- [Quickstart](docs/guides/quickstart.md) — 5-minute guide
- [Complete Workflow](docs/guides/workflow.md) — Full workflow including post-QA patterns
- [Getting Started](docs/getting-started/installation.md)
- [What We've Built](docs/internal/what-weve-built.md) — Comprehensive project overview
- [What Is Sequant](docs/concepts/what-is-sequant.md) — Elevator pitch, pipeline diagram, architecture
- [Workflow Concepts](docs/concepts/workflow-phases.md)
- [Run Command](docs/reference/run-command.md)
- [Concurrency & Per-Issue Locks](docs/reference/concurrency.md)
- [Git Workflows](docs/guides/git-workflows.md)
- [Customization](docs/guides/customization.md)
- [Troubleshooting](docs/troubleshooting.md)

Stack guides: [Next.js](docs/stacks/nextjs.md) · [Rust](docs/stacks/rust.md) · [Python](docs/stacks/python.md) · [Go](docs/stacks/go.md)

---

## Feedback & Contributing

### Reporting Issues

- **Bug reports:** [Bug template](https://github.com/sequant-io/sequant/issues/new?template=bug.yml)
- **Feature requests:** [Feature template](https://github.com/sequant-io/sequant/issues/new?template=feature.yml)
- **Questions:** [GitHub Discussions](https://github.com/sequant-io/sequant/discussions)

### Using `/improve` for Feedback

Run `/improve` in Claude Code to analyze your codebase and create structured issues:

```
/improve              # Analyze entire codebase
/improve security     # Focus on security concerns
/improve tests        # Find test coverage gaps
```

The skill will present findings and offer to create GitHub issues automatically.

### Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

### Telemetry

Sequant does not collect any usage telemetry. See [docs/reference/telemetry.md](docs/reference/telemetry.md) for details.

---

## License

MIT
