# What Is Sequant

Sequant is workflow automation for Claude Code. It turns GitHub issues into
merge-ready pull requests through structured phases and quality gates.

You write issues. Sequant plans, builds, tests, and reviews them — each step
with guardrails that catch problems before they reach your codebase.

---

## The Problem

Claude Code is remarkably capable. Give it a well-scoped issue and it can
plan, implement, and test a feature in minutes. But capability alone doesn't
guarantee consistency.

Without structure, AI-assisted development has a "results may vary" quality:

- A vague issue produces a vague implementation
- There's no formal review step — code goes from "written" to "done"
- Context accumulates over long sessions, drifting from the original goal
- There's nothing tracking which issues are planned, in progress, or reviewed
- Each session starts from scratch with no memory of prior work

These aren't flaws in Claude Code. They're the natural consequence of
working without a process. Human developers solve this with methodologies,
code review, CI/CD, and project management. AI-assisted development needs
the same discipline.

Sequant provides that discipline.

---

## How It Works

Sequant installs slash commands into Claude Code that enforce a phased
workflow. Each issue moves through plan, build, and review — with an
isolated worktree keeping your main branch clean and a quality loop
that catches problems before merge.

```text
                         ┌──────────────┐
                         │ GitHub Issue  │
                         │    #123       │
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │    /spec     │  Runs in main repo.
                         │     Plan     │  Reads issue, lints AC,
                         │              │  posts plan to GitHub.
                         └──────┬───────┘
                                │
               ┌────────────────▼─────────────────────┐
               │           WORKTREE                    │
               │    isolated branch + dependencies     │
               │                                       │
               │         ┌──────────────┐              │
               │         │    /exec     │              │
               │         │    Build     │              │
               │         │              │              │
               │         │ Implement,   │              │
               │         │ commit, push,│              │
               │         │ create PR    │              │
               │         └──────┬───────┘              │
               │                │                      │
               │         ┌──────▼───────┐              │
               │         │     /qa      │◄──┐          │
               │         │    Review    │   │          │
               │         │              │   │          │
               │         │ Type safety, │   │ /loop    │
               │         │ security,    │   │ auto-fix │
               │         │ scope, tests │   │ (up to   │
               │         └──────┬───────┘   │  3x)     │
               │                │           │          │
               │           Pass? ───NO──────┘          │
               │                │                      │
               │               YES                     │
               │                │                      │
               └────────────────┼──────────────────────┘
                                │
                         ┌──────▼───────┐
                         │    Merge     │  PR lands on main.
                         │   + Clean    │  Worktree removed.
                         └──────────────┘
                                │
                                ▼
                         Code on main
```

Or run the full pipeline in one command:

```text
/fullsolve 123
```

### Each Phase Is a Fresh Conversation

This is a deliberate design choice. Phases don't share implicit context.
The QA phase reviews the actual code diff — not a memory of having written
it. The implementation phase reads the spec plan from the issue comment —
not from conversation history.

Cross-phase context flows through explicit, inspectable channels:

| Channel | What it carries |
| --- | --- |
| **GitHub Comments** | Spec plans, QA verdicts, and phase markers posted to the issue thread |
| **Git Diff** | What actually changed in the worktree |
| **State File** (`.sequant/`) | Phase progress, AC status, and timestamps tracked locally per issue |
| **Environment** | Issue number, worktree path, and base branch passed between phases |

This prevents context pollution, keeps phases composable, and makes the
entire workflow auditable by reading issue comments.

---

## What Sequant Installs

Sequant is not a platform or a service. It's a set of files that live
in your project and extend Claude Code's capabilities.

```text
your-project/
│
├── .claude/
│   ├── skills/              ◄── 18 slash commands (markdown prompts)
│   │   ├── spec/SKILL.md         /spec, /exec, /qa, /fullsolve,
│   │   ├── exec/SKILL.md         /test, /testgen, /loop, /solve,
│   │   ├── qa/SKILL.md           /verify, /docs, /assess, /clean,
│   │   └── ...                   /improve, /reflect, /merger,
│   │                             /security-review, /upstream
│   ├── hooks/               ◄── 2 Claude Code hooks
│   │   ├── pre-tool.sh           Security guardrails, timing
│   │   └── post-tool.sh          Quality observability, formatting
│   └── settings.json        ◄── Hook configuration
│
├── .sequant/
│   ├── state.json           ◄── Workflow state per issue
│   ├── settings.json        ◄── Project configuration
│   ├── metrics.json         ◄── Aggregated run analytics
│   └── logs/                ◄── Structured JSON run logs
│
├── scripts/dev/
│   ├── new-feature.sh       ◄── Create worktree from issue
│   ├── cleanup-worktree.sh  ◄── Remove worktree after merge
│   └── list-worktrees.sh    ◄── Show active worktrees
│
└── .sequant-manifest.json   ◄── Version tracking for updates
```

Everything is local. No telemetry. No external services. Your code and
workflow data stay in your repository.

---

## What the Quality Gates Catch

The `/qa` phase isn't a rubber stamp. It runs structured checks against
your code and renders one of four verdicts:

| Verdict | Meaning |
| ------- | ------- |
| **READY_FOR_MERGE** | All acceptance criteria met, quality checks pass |
| **AC_MET_BUT_NOT_A_PLUS** | Functional but has suggestions for improvement |
| **NEEDS_VERIFICATION** | Requires manual testing or confirmation |
| **AC_NOT_MET** | Acceptance criteria not satisfied — needs fixes |

The checks behind those verdicts:

```text
┌─────────────────────────────────────────────────────────┐
│                     /qa Quality Gates                    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  AC Adherence ─── Does the code do what the issue asked │
│                                                         │
│  Type Safety ──── Detects `any`, missing types,         │
│                   unsafe casts                          │
│                                                         │
│  Security ─────── Semgrep static analysis, OWASP        │
│                   checks, secret detection              │
│                                                         │
│  Scope ────────── Flags changes outside issue scope     │
│                                                         │
│  Test Coverage ── File-by-file coverage, critical path  │
│                   flagging, deleted test detection       │
│                                                         │
│  Build ────────── Distinguishes regressions from        │
│                   pre-existing failures                  │
│                                                         │
│  Anti-Patterns ── N+1 queries, empty catch blocks,      │
│                   over-mocking, stale dependencies       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

When checks fail, `/loop` can automatically parse findings, apply fixes,
and re-run — up to 3 iterations — without human intervention.

---

## What Runs Underneath

The phases are the visible workflow. Underneath, four systems run
continuously to keep everything safe, tracked, and connected:

```text
  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌────────────┐
  │  Skills   │  │   Hooks   │  │   State   │  │   GitHub   │
  │           │  │           │  │           │  │  Comments   │
  │ 18 slash  │  │ Pre-tool: │  │ .sequant/ │  │            │
  │ commands  │  │ blocks    │  │ tracks    │  │ Plans,     │
  │ that tell │  │ secrets,  │  │ phase     │  │ verdicts,  │
  │ Claude    │  │ unsafe    │  │ progress, │  │ and phase  │
  │ Code what │  │ commands  │  │ metrics,  │  │ markers    │
  │ to do in  │  │           │  │ run logs  │  │ that carry │
  │ each      │  │ Post-tool:│  │           │  │ context    │
  │ phase     │  │ formats,  │  │ Updated   │  │ between    │
  │           │  │ observes  │  │ at phase  │  │ sessions   │
  │           │  │ quality   │  │ boundaries│  │            │
  └───────────┘  └───────────┘  └───────────┘  └────────────┘
```

- **Skills** are markdown prompts — they tell Claude Code exactly what to
  do in each phase. The intelligence lives in the prompts.
- **Hooks** fire on every tool call. Pre-tool hooks block secrets,
  destructive commands, and edits outside the worktree. Post-tool hooks
  auto-format code and log quality signals.
- **State** tracks phase progress locally in `.sequant/state.json`,
  aggregates metrics across runs, and writes structured JSON logs.
- **GitHub Comments** carry context between phases. The spec plan, QA
  verdict, and phase markers are all posted to the issue thread —
  making the workflow resumable across sessions and machines.

---

## Worktree Isolation

The worktree in the diagram above isn't just a feature — it's the
boundary between planning and execution. `/spec` runs in your main
repo (no code changes). Everything inside the worktree — `/exec`,
`/qa`, `/loop` — operates on an isolated branch with its own
dependencies. Your main branch is never touched.

```text
your-project/                     ◄── Main repo (stays on main)

../worktrees/feature/
    ├── 123-add-auth/             ◄── Issue #123 (own branch + deps)
    ├── 124-fix-nav-bug/          ◄── Issue #124 (own branch + deps)
    └── 125-update-api/           ◄── Issue #125 (own branch + deps)
```

Work on multiple issues in parallel. Discard failed experiments. When
a PR merges, the worktree is cleaned up and the code lands on main.

---

## Two Ways to Use It

### Interactive — Inside Claude Code

Type slash commands directly. Review plans before building. Step through
at your own pace.

```text
/spec 123          Plan the implementation
/exec 123          Build it
/qa 123            Review it
```

### Headless — From the CLI

Run the full pipeline without the Claude Code UI. Batch multiple issues.
Let it iterate overnight.

```bash
npx sequant run 123                    # Single issue, full pipeline
npx sequant run 1 2 3                  # Three issues in parallel
npx sequant run 123 --quality-loop     # Auto-fix on QA failure
npx sequant run 123 --resume           # Pick up where you left off
```

---

## Issues as Building Blocks

The core idea behind Sequant is that a project is a collection of
well-defined issues, and each issue follows the same lifecycle:

```text
              ┌─────────────────────────────────────────────┐
              │              Your Project                    │
              │                                             │
              │   ┌───────┐  ┌───────┐  ┌───────┐         │
              │   │ #101  │  │ #102  │  │ #103  │         │
              │   │ Auth  │  │ Nav   │  │ API   │  ...    │
              │   │ [done]│  │ [done]│  │ [wip] │         │
              │   └───────┘  └───────┘  └───────┘         │
              │                                             │
              │   ┌───────┐  ┌───────┐  ┌───────┐         │
              │   │ #104  │  │ #105  │  │ #106  │         │
              │   │ Tests │  │ Perf  │  │ Docs  │  ...    │
              │   │ [plan]│  │ [plan]│  │ [plan]│         │
              │   └───────┘  └───────┘  └───────┘         │
              │                                             │
              └─────────────────────────────────────────────┘
```

Each block passes through the same phases. Each block gets the same
quality checks. The output is predictable because the process is
consistent — not because every issue is simple, but because every
issue is treated with the same rigor.

Sequant doesn't make Claude Code less flexible. It makes the workflow
around it more structured. You still get the full power of Claude Code
inside each phase. Sequant just ensures that power is applied
methodically — plan first, build in isolation, review before merging.

---

## Quick Start

```bash
npm install sequant
npx sequant init
npx sequant doctor
```

Then in Claude Code:

```text
/fullsolve 123
```

See the [Quickstart Guide](../guides/quickstart.md) for the full walkthrough.
