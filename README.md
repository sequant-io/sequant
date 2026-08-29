# Sequant

**AI coding agents that prove their work — every acceptance criterion verified, and you hold the merge button.**

For developers who won't merge what they can't trust — solo or on a team. Solve GitHub issues with structured phases and quality gates, from issue to merge-ready PR.

**[sequant.io](https://sequant.io)** — docs, guides, and getting started.

[![npm version](https://img.shields.io/npm/v/sequant.svg)](https://www.npmjs.com/package/sequant)
[![npm downloads](https://img.shields.io/npm/dm/sequant.svg)](https://www.npmjs.com/package/sequant)
[![GitHub stars](https://img.shields.io/github/stars/sequant-io/sequant.svg)](https://github.com/sequant-io/sequant/stargazers)
[![CI](https://github.com/sequant-io/sequant/actions/workflows/ci.yml/badge.svg)](https://github.com/sequant-io/sequant/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

AI coding agents write code well, but leave you to run the workflow around it — planning, isolation, review, and merge safety. Sequant wraps an agent in a structured **spec → exec → qa** pipeline with isolated git worktrees and quality gates, taking a GitHub issue from triage to a merge-ready PR without babysitting each step. The PR arrives with evidence — each acceptance criterion checked against the code — and the merge is always yours.

See the [CHANGELOG](CHANGELOG.md) for release notes, or the [migration guide](CHANGELOG.md#migration-from-v1x) if upgrading from v1.x.

### What's new in 2.12

- **QA gates you can parse, not just read** — `/qa` now closes every review with a structured findings marker (six-category taxonomy, evidence, recommended action) that `/loop` and `sequant ready` consume directly, so a finding QA itself called non-blocking is never burned as a fix iteration (#937). Gate-test ACs must ship a machine-checkable `SEQUANT_MUTATION` record in the PR body, enforced by `/qa` (#939), and an AC can declare its own verification command via a trailing `Evidence:` clause that QA must actually execute (#938). A new advisory CI job annotates PRs with likely-vacuous tests (#940).
- **`/fullsolve` stops at the PR** — it no longer merges the PR it creates; pass `--auto-merge` (or set `run.autoMerge: true`) for the previous end-to-end behavior (#958). `/merger` gains a Named-Set Boundary: it merges only the issues you name, halting with a report if a dependency outside that set turns up (#961).
- **Phase agents get an MCP allowlist, not your desktop config** — headless phase agents now receive the sequant MCP server plus the project's own `.mcp.json`, never a passthrough of Claude Desktop config (which can carry literal secrets into process argv). `run.mcpAllowlist` opts specific desktop-only servers back in deliberately (#936). See [run-command.md](docs/reference/run-command.md#allowlisting-a-desktop-only-server).

### What's new in 2.11

- **Per-phase `model`/`effort` configuration** — the new `sequant run`/`sequant ready` flags `--models`/`--efforts` (bare value applies to every phase, or a comma list of `phase=model` pairs) let a phase's Agent SDK session use a different Claude model or reasoning effort than the CLI default — e.g. planning with a stronger model and delegating implementation to a cheaper one. Absent by default: nothing changes unless configured. See [run-command.md](docs/reference/run-command.md#per-phase-model--effort).
- **Evidence-based effort escalation on retries** — `--escalate-effort` raises a retried phase execution's reasoning effort one tier above its resolved base, built on the per-phase effort resolver above. Escalates only on *observed* retry (an outer quality-loop iteration ≥ 2, or a `sequant ready` QA-pass ≥ 2) — never speculatively — so it can only trade cost for quality, never the reverse. See [run-command.md](docs/reference/run-command.md#effort-escalation-on-retries).
- **Checkout-scoped lock for the shared working tree** — the per-issue lock never protected the *checkout itself*: two sessions on different issues could still interleave `git checkout`/`reset`/`rebase`/`merge` in the same main working tree. `sequant locks checkout <acquire|release|check|clear>` and a `pre-tool.sh` hook now guard branch-mutating git in the main checkout directly, refusing a foreign session with the holder's identity and how to proceed (#901).
- **`sequant worktree resolve/verify`** — resolves and verifies an issue's worktree by the branch git reports rather than a directory-name glob, closing a shared-namespace collision that could point `/fullsolve`, `/exec`, `/qa`, `/loop`, `/testgen`, `/merger` or `/assess` at the wrong worktree (#899, #904).

### What's new in 2.10

- **`--auto-wait <minutes>` rides out a rate-limit window** — opt in and a run whose limit window is hours out sleeps until it reopens and continues, instead of halting for a manual restart (#804). **Off by default**; the value is a *total* budget per issue, capped at 2 waits. Never waits on out-of-credits failures (credits are purchased, not waited out). The wait is in-process — for waits that must survive closing the terminal or a reboot, see halt-and-resume below; an exhausted `--auto-wait` budget still writes the halt record so `sequant resume` can pick up where it gave up. See [run-command.md](docs/reference/run-command.md#auto-wait-for-a-rate-limit-window).
- **Durable halt-and-resume + `sequant resume`** — a run that fails on an exhausted rate-limit window now writes a durable halt record (with its `resumeAt` time) and exits cleanly, releasing the per-issue lock. `sequant resume` re-enters after the window reopens, skipping completed phases and issues — safe to invoke from cron/launchd for unattended machines (recipes in [halt-and-resume.md](docs/reference/halt-and-resume.md)) (#892).
- **`--ready-gate` runs the post-QA ready gate inside `sequant run`** — opt in and, once an issue's standard phases succeed, `run` drives it through the same full-weight `qa → loop → qa` gate as `sequant ready` (to the configured `ready.policy`) **before** opening the PR, so the gate's fixes land in it. It automates the manual any-gaps/fix-gaps second look and **still stops at the human merge gate — it never merges** (#817). **Off by default**; without the flag the run path is unchanged (an `AC_MET_BUT_NOT_A_PLUS` verdict still breaks to PR per #749). Reuses `ready`'s policy, iteration cap, and stagnation guard — no new settings. See [run-command.md](docs/reference/run-command.md#ready-gate-post-qa-second-look).
- **`sequant merge --watch` waits for CI, then reports** — instead of polling checks by hand, `merge --watch` waits for each PR's CI checks to finish, then runs the merge-check and reports the result. It never merges (#818).
- **Stricter CLI contract for scripting** — malformed numeric flags (`--timeout 30m`, `--timeout abc`) are rejected with a clear error instead of silently coerced (#833, #845), and pre-flight rejections (uninitialized project, missing prerequisites) exit non-zero across `run`/`update`/`state`/`status`/`init` (#848). Runs terminated by a signal exit `128+signum` instead of `0` (#856).

### What's new in 2.9

- **`--chain` survives a failed link** — re-running a partially-completed chain resumes from its last good link, skipping the completed prefix and rebasing onto that committed tip instead of redoing hours of finished work (#760). A warn-by-default content pre-flight also runs before the first worktree is provisioned, flagging missing ACs, mis-ordered dependencies, predicted file overlaps, and closed issues; `--strict-preflight` makes any warning a hard stop (#762).
- **Rate limits stop burning hours** — a rate limit hit inside a phase now skips doomed cold-start retries, and the run summary labels the chain halt with its cause and how to resume, instead of cascading into a ~2h retry ladder (#761).
- **Stale plugin-cache warning** — `pre-tool.sh` now prints a once-per-day, network-free reminder (`claude plugin update sequant@sequant`) when a plugin-channel install has drifted behind the marketplace (#784, #788).

### What's new in 2.8

- **Clearer failures when an agent stops early** — phases that hit a turn cap now preserve their partial work and halt cleanly for resume instead of discarding it (#739, #733), and rate-limit/out-of-credits failures are named for what they are (with reset time and credit-purchase hints) rather than buried under generic retry noise (#732).
- **Runtime Node-version guard** — `sequant` checks the running Node against its `engines.node` floor (`>=22.13.0`) at startup and exits with a friendly upgrade message instead of crashing later on a Node-22-only API (#734).
- **`/assess` avoids npx version skew** — it now emits `sequant run …` when a global install is on `PATH` (and the unchanged `npx sequant run …` otherwise), so copy-pasted commands don't silently run a stale binary (#740).

### What's new in 2.7

- **Trustworthy `--dry-run` previews for `sync` and `update`** — `sequant sync --dry-run` (`-d`) previews the exact set the apply would write (`new` + `modified` + `local-override`) and mutates nothing. Both `sync --dry-run` and `update --dry-run` now exit non-zero when work is pending, so a CI/automation job can gate on the exit code instead of parsing stdout. (`update` is the interactive command; `sync` is the documented non-interactive/CI surface.)

### What's new in 2.6

- **Boxed Ink TUI is the default for `sequant run`** — on a TTY, `run` now renders the boxed dashboard by default (matching `sequant ready`). Opt out with `--no-tui` (line renderer) or `-s`/`--quiet` (heartbeat-only); non-TTY output auto-degrades.
- **Flag change:** `--quiet` moved from `-q` to **`-s`** (silent). `-q` is now an alias for `-Q, --quality-loop`, so `sequant run … -q` enables the quality loop as intended. (`--experimental-tui` is kept as a hidden no-op alias.)

### What's new in 2.5

- **`sequant ready <issue>`** — a post-resolve A+ QA gate that drives a resolved issue through a full-weight `qa → loop → qa` pass and **stops at the human merge gate — it never merges**.
- **Live phase-matrix TUI** — `sequant ready` and `sequant run` render the active phase and quality-loop iteration in place (boxed Ink dashboard on a TTY by default), so a long run is never indistinguishable from a hang. Opt out with `--no-tui` (line renderer) or `-s`/`--quiet` (heartbeat-only); non-TTY output auto-degrades.
- **Per-issue concurrency locks** — a second session on the same issue is skipped with a clear message instead of clobbering the first; `sequant locks` inspects and clears them.

## Quick Start

### Prerequisites

**An AI coding agent — one of:**
- [Claude Code](https://claude.ai/code) — default agent. **Recommended: Claude Code ≥ 2.1.208.** The pre-tool hooks lean on Claude Code's native dangerous-`rm` analyzer (which fires even under `bypassPermissions`) instead of re-implementing catastrophic-delete detection; that analyzer's command-substitution coverage landed in 2.1.208. This is a recommendation, not an enforced floor — plugins cannot declare a minimum Claude Code version, so nothing gates install, and the pre-2.1.208 command-substitution gap (e.g. `echo "$(rm -rf ~)"`) is accepted rather than guarded.
- [Aider](https://aider.chat/) — alternative, via `--agent aider`

**Always required (both):**
- [GitHub CLI](https://cli.github.com/) — run `gh auth login`
- Git — for worktree-based isolation

**For the npm/CLI install path:** Node.js 22.13+

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

<p align="center">
  <img src="https://raw.githubusercontent.com/sequant-io/sequant/main/docs/assets/run-grid.gif" alt="Sequant run grid: the live boxed TUI driving issue #64 through spec, exec, and qa to a green success rollup" width="760">
</p>

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
- **Boundaries** — every rule names its enforcer: the force-push hook, the protected-paths settings key, the mutation-verification gate.
- **Budgets & Stop Conditions** — iteration caps, the human merge gate, hold states, and gap-prompt discipline.

The file is a `CUSTOMIZABLE_FILES` entry: plain `sequant update` and `sync` preserve your edits. Only `--force` replaces it.

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

See [Customization Guide](docs/guides/customization.md) for all options, [Per-Phase Model & Effort](docs/reference/run-command.md#per-phase-model--effort) for the `run.phases` shape, the `--models`/`--efforts` flags, and precedence, and [Effort Escalation on Retries](docs/reference/run-command.md#effort-escalation-on-retries) for `run.effortEscalation`/`--escalate-effort`.

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
