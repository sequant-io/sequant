# Sequant

**AI coding agents that prove their work — each acceptance criterion checked, and you hold the merge button.**

For developers who won't merge what they can't trust — solo or on a team.

Sequant takes a GitHub issue to a merge-ready PR through three phases — plan, implement, review — each in its own git worktree, with quality gates between them. The PR arrives with evidence: every acceptance criterion re-checked against the code and posted to the issue. The merge is always yours.

**[sequant.io](https://sequant.io)** — docs, guides, and getting started.

[![npm version](https://img.shields.io/npm/v/sequant.svg)](https://www.npmjs.com/package/sequant)
[![npm downloads](https://img.shields.io/npm/dm/sequant.svg)](https://www.npmjs.com/package/sequant)
[![GitHub stars](https://img.shields.io/github/stars/sequant-io/sequant.svg)](https://github.com/sequant-io/sequant/stargazers)
[![CI](https://github.com/sequant-io/sequant/actions/workflows/ci.yml/badge.svg)](https://github.com/sequant-io/sequant/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/sequant-io/sequant/badge)](https://scorecard.dev/viewer/?uri=github.com/sequant-io/sequant)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

<p align="center">
  <img src="https://raw.githubusercontent.com/sequant-io/sequant/main/docs/assets/run-grid.gif" alt="Sequant run grid: the live boxed TUI driving issue #64 through spec, exec, and qa to a green success rollup" width="760">
</p>

**Why Sequant**

- **Stop babysitting the agent.** AI coding agents write code well and leave the workflow to you — planning, isolation, review, merge safety. One command runs the whole issue → PR path, not just the coding step.
- **You stay in control.** The pipeline stops at the PR and never merges. That is an invariant, not a setting.

**Works with** [Claude Code](https://claude.ai/code) (default) or [Aider](https://aider.chat/), on any git repository with GitHub issues. Tuned for Node.js/TypeScript projects; the worktree workflow is language-agnostic.

## Quick Start

### Prerequisites

- **An AI coding agent:** [Claude Code](https://claude.ai/code) (recommended ≥ 2.1.208) or [Aider](https://aider.chat/) via `--agent aider`. Experimental: [Codex](docs/features/codex-agent-backend.md) via `--agent codex`, [opencode](docs/troubleshooting.md#opencode-issues) via `--agent opencode` — read their notes before relying on either.
- **[GitHub CLI](https://cli.github.com/)** (`gh auth login`) and **Git**.
- **Node.js 22.13+** — for the npm/CLI install path only.
- Optional MCP servers: `chrome-devtools` (browser tests via `/test`), `sequential-thinking`, `context7`.

> **Why Claude Code ≥ 2.1.208?** Sequant's pre-tool hooks lean on Claude Code's native dangerous-`rm` analyzer, which fires even under `bypassPermissions`; its command-substitution coverage (e.g. `echo "$(rm -rf ~)"`) landed in 2.1.208. Plugins cannot declare a minimum Claude Code version, so this is a recommendation, not an enforced floor.

### Install

Pick the path that matches **where you run Sequant**:

**Inside Claude Code (plugin)** — skills, hooks, and MCP tools, no npm required:
```
/plugin install sequant@sequant-io/sequant
/sequant:setup
```

> **Plugins do not auto-update.** Claude Code pins a plugin to the version you installed and never updates it on its own — even as new releases ship. To pick up a new version, run `claude plugin update sequant@sequant`, then restart Claude Code. Sequant's pre-tool hook warns once a day when your installed version falls behind the marketplace.

**Headless / CI (npm package)** — drive runs from the terminal or a CI job:
```bash
npm install sequant          # or: pnpm add / yarn add / bun add sequant
npx sequant init             # install skills into your project
npx sequant doctor           # verify setup
```

> **Commit `.claude/skills/`.** It is a runtime dependency, not a cache: `sequant run` phase agents load skills from that directory only, so a checkout (or cleanup) that drops it breaks every run. `sequant run` pre-flights the directory and fails fast with the fix (`sequant sync`) if it is missing.

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

### What's new in 2.18

- **Per-phase agents** — `run.phases.<phase>.agent` runs one phase on a different driver, e.g. codex for `exec` and Claude Code for `qa`.
- **In-place checkout mode** — `SEQUANT_CHECKOUT=in-place` lets the phase skills work on a branch in the current clone when a worktree is not an option (a fresh cloud clone, for one). Opt-in only.
- **Safer writes** — `init`, `sync` and `update` never overwrite what a symlink points at, and `sync`/`update` settle on the first run even with an older sequant in `node_modules`.

Since 2.17, every release soaks on the `next` tag against a downstream canary — a real install of the previous minor, driven through `sync`, `init`, `update` and `doctor` by the new build — before it is promoted to `latest`.

Full history: [CHANGELOG](CHANGELOG.md) · [Migrating from v1.x](CHANGELOG.md#migration-from-v1x)

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

### Agent Contract

Every project gets `.claude/memory/constitution.md` — the machine-enforceable agent contract that answers "what will the agent refuse to do, what must every PR satisfy, and where does it stop for me?":

- **Definition of Done** — generated from `/qa`'s §7 gate list; a CI check (`lint:constitution-dod`) fails when the table drifts from the live gates. These are project-wide — issue ACs don't restate them.
- **AC Authoring Standard** — the house format for writing ACs (single-line, `Evidence:`/`Risk:`/`Human decision` fields, Non-Goals); referenced by `/spec`'s lint warnings.
- **Boundaries** — every rule names its enforcer: the force-push hook, the worktree-only editing guard, the mutation-verification gate.
- **Budgets & Stop Conditions** — iteration caps, the human merge gate, hold states, and gap-prompt discipline.

The file's declared ownership policy is `user-owned`: plain `sequant update` and `sync` preserve your edits. Only `--force` replaces it.

**`AGENTS.md` ownership.** Every `AGENTS.md` sequant generates starts with a marker line, `<!-- sequant:agents-md v=<version> h=<sha1> -->`, whose hash covers the rest of the file. `sync` only regenerates the file when that marker is present and its hash still matches the body — otherwise the file is treated as user-owned (hand-edited, or written before the marker existed) and is left byte-identical, reported as preserved, and only replaced with `sync --force`. Use `sync --no-agents-md` to skip `AGENTS.md` entirely. (`update` has no `AGENTS.md` awareness — unaffected.)

**`scripts/dev` links and `--dry-run`.** The `scripts/dev/*.sh` links point at your project's own `node_modules/sequant/templates/scripts/` whenever it exists, so a fresh clone plus `npm install` keeps them working; a templates directory under an npx cache or outside the project tree yields copies instead, with one line saying why. `sync --dry-run` and `update --dry-run` list exactly the paths the apply step writes — the `AGENTS.md` decision, each link whose target would change (`sync` only: `update` leaves `scripts/dev` links to `sync` and names any that are out of date), and the opencode shim (refreshed only on projects that opted in with `--agent opencode`, and only when it drifted). No writer follows a symlink: a link at any sequant-written destination, `.mcp.json` included, is replaced and its target left untouched, and a directory where a file belongs is reported as `<path> is a directory; move it aside` and skipped.

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

### Thinking of building this on a graph framework?

You could assemble this workflow yourself on LangGraph, CrewAI, Mastra, or the Claude Agent SDK — they sell the primitives and leave the workflow as an exercise. Sequant is the finished, hardened version of what you'd end up building, in the frameworks' own vocabulary:

- **Isolated execution** — one git worktree per issue, resolved by the branch git reports rather than directory globs
- **Human-in-the-loop approval gate** — the pipeline stops at the PR and never merges; this is an invariant, not optional wiring
- **Guardrails** — QA verdicts with an enforced floor, mutation-verified gate tests, scope and security checks
- **Durable execution** — a rate-limit halt writes a resumable record; `sequant resume` picks up where it left off, skipping completed phases
- **State management** — per-issue and checkout-scoped locks, so concurrent sessions can't interleave git operations in the same tree
- **Deterministic control flow** — dependency-ordered batch scheduling over `blocked by #N` relationships

On a general framework, every one of these is something you wire up — and can wire wrong or skip. Here they hold for every run. The boring 80% (retries, resume, locking, exit codes your scripts can trust) has already been run in anger; the [CHANGELOG](CHANGELOG.md) is the receipts.

---

## Using Sequant

### Solve one issue (the 80% path)

The most common invocation — no flags. Auto-creates a worktree, posts a plan comment to the issue, and opens a PR.

In Claude Code:
```
/fullsolve 123
```

Headless (`-Q` runs the quality loop; `--full-qa` makes the reviewer come in cold with the full standalone pre-flight):
```bash
npx sequant run 123 -Q
npx sequant run 123 --full-qa
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

### Upgrade without surprises

You keep your own `AGENTS.md` and a customized constitution. A new sequant version should not eat either — so look before it writes:

```
$ npx sequant sync --dry-run
AGENTS.md: preserved
Summary (dry-run):
  New files: 1
  Modified: 3
  Customizable (preserved): 1
(dry-run mode - no changes made)
```

`preserved` means user-owned: `sync` leaves it byte-identical until you run `sync --force` once. Exit code 1 means there is work to apply, so a CI job can gate on the preview.

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
| `npx sequant merge <issues…>` | Batch integration QA before merging. Add `--watch` to wait for each PR's CI checks to finish (configurable `--interval`/`--timeout`), then run the checks and report — it never merges. |

### Pipeline internals

`/spec`, `/exec`, `/loop`, `/testgen`, `/test` are the phases that `/fullsolve` and `sequant run` orchestrate for you. You can invoke them directly, but rarely need to.

### Occasional / advanced

| Command | What it does |
|---------|--------------|
| `sequant ready <issue>` | Post-resolve full-weight A+ QA gate; drives to merge-readiness, then stops at the human merge gate (never merges). |
| `sequant resume` | Re-enter runs halted on a rate-limit window once it reopens; no-op before `resumeAt`, so it is safe to schedule via cron/launchd. See [halt-and-resume.md](docs/reference/halt-and-resume.md). |
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
    "defaultBase": "feature/dashboard",  // Optional: custom default base branch
    "phases": {
      "exec": { "model": "sonnet", "effort": "medium" }  // Optional: per-phase model/effort override
    },
    "effortEscalation": false  // Optional: escalate effort one tier on a quality-loop retry
  }
}
```

See [Customization Guide](docs/guides/customization.md) for all options, [Per-Phase Model & Effort](docs/reference/run-command.md#per-phase-model--effort) for the `run.phases` shape, the `--models`/`--efforts` flags, and precedence, [Effort Escalation on Retries](docs/reference/run-command.md#effort-escalation-on-retries) for `run.effortEscalation`/`--escalate-effort`, and [Model Escalation Ladder](docs/reference/model-ladder.md) for `run.modelLadder`/`--model-ladder` and the three ladder halts.

`fullQa` under `run` in `.sequant/settings.json` (default `false`) mirrors `--full-qa` above — CLI flag beats the setting.

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
- [Model Escalation Ladder](docs/reference/model-ladder.md) — capability-bound escalation, `SPEC_DIVERGENCE`, and the halts that stop a runaway loop
- [Plugin Eval CI](docs/reference/plugin-eval.md) — manual-dispatch `claude plugin eval` workflow, budget cap, and canary design
- [Git Workflows](docs/guides/git-workflows.md)
- [Customization](docs/guides/customization.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Threat Model](docs/THREAT-MODEL.md) — untrusted-input surfaces, which defenses hold when the model is compromised, OWASP Agentic Top 10 mapping · [Security Policy](SECURITY.md) — reporting a vulnerability

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
