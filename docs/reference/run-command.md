# Run Command

**Quick Start:** Execute the Sequant workflow (`/spec` → `/exec` → `/qa`) for one or more GitHub issues with a single command. Use this to automate issue resolution through sequential AI phases.

## Access

- **Command:** `npx sequant run <issues...> [options]`
- **Requirements:**
  - Sequant initialized (`sequant init`)
  - Claude CLI installed and configured
  - GitHub CLI authenticated (`gh auth login`)

## Usage

### Running a Single Issue

```bash
npx sequant run 123
```

Executes the default workflow phases (spec → exec → qa) for issue #123.

### Running Multiple Issues

```bash
npx sequant run 100 101 102
```

Processes issues #100, #101, and #102. By default, issues continue processing even if one fails.

### Sequential Mode with Dependencies

```bash
npx sequant run 100 101 102 --sequential
```

Processes issues in order, stopping if any issue fails. Use this when later issues depend on earlier ones.

### Preview with Dry Run

```bash
npx sequant run 100 --dry-run
```

Shows what would be executed without actually running any phases. Useful for verifying configuration.

## Options & Settings

| Option | Description | Default |
|--------|-------------|---------|
| `--phases <list>` | Comma-separated phases to run. Validated against the phase registry — unknown names exit with `error: option '--phases <list>' argument 'X' is invalid. Unknown phase 'X'. Available: spec, security-review, exec, testgen, test, verify, qa, loop, merger` | `spec,exec,qa` |
| `--sequential` | Run issues in order, stop on first failure (see [Execution Model](#execution-model)) | `false` |
| `--chain` | Chain issues: each branches from previous (implies `--sequential`) | `false` |
| `--stacked` | Stack PRs: non-first PRs target predecessor branch (implies `--chain`) | `false` |
| `--qa-gate` | **Deprecated (#795) — no-op.** Still accepted so existing scripts keep working; prints a deprecation notice. `--chain` already halts on any failed issue, QA included. See [QA Gate Mode](#qa-gate-mode-deprecated) | `false` |
| `--strict-preflight` | Make `--chain` content pre-flight warnings (missing AC section, dependency/overlap order, closed issues) fatal before any worktree is provisioned | `false` |
| `-d, --dry-run` | Preview without execution | `false` |
| `-v, --verbose` | Show detailed output | `false` |
| `--timeout <seconds>` | Timeout per phase. Whole seconds only — `30m` and `abc` are rejected rather than read as `30` (#833) | `1800` (30 min) |
| `-Q, --quality-loop` | Enable auto-retry on failures (`-q` is a hidden alias — both enable it) | `false` |
| `--max-iterations <n>` | Max iterations for quality loop. Whole number ≥ 1 (#833) | `3` |
| `-s, --quiet` | Suppress version warnings and non-essential output (heartbeat-only liveness; `-q` no longer maps here — see #705) | `false` |
| `--no-tui` | Disable the default boxed Ink dashboard; use the line phase-matrix renderer. Non-TTY output auto-degrades. (`--experimental-tui` is a hidden no-op alias.) | TUI on (TTY) |
| `--testgen` | Run testgen phase after spec | `false` |
| `--batch "<issues>"` | Group issues to run together | - |
| `--no-mcp` | Disable MCP servers for faster/cheaper runs | `false` |
| `--auto-wait <minutes>` | Total minutes willing to wait for an exhausted rate-limit window to reopen instead of halting. See [Auto-wait](#auto-wait-for-a-rate-limit-window) | `0` (off) |
| `--ready-gate` | After an issue's standard phases succeed, run the post-QA ready gate (`qa → loop → qa` to `ready.policy`) before opening the PR. **Never merges** — stops at the human merge gate. See [Ready Gate](#ready-gate-post-qa-second-look) | `false` (off) |
| `--models <spec>` | Per-phase Claude model override — a bare value (`sonnet`) applies to every phase, or a comma list of `phase=model` pairs (`spec=fable,exec=sonnet`). See [Per-Phase Model & Effort](#per-phase-model--effort) | none (CLI default model) |
| `--efforts <spec>` | Per-phase reasoning-effort override (`low\|medium\|high\|xhigh\|max`), same grammar as `--models`. See [Per-Phase Model & Effort](#per-phase-model--effort) | none (SDK default) |
| `--escalate-effort` | On a quality-loop retry (loop iteration ≥ 2), run every phase dispatched in that iteration one reasoning-effort tier above its resolved base. See [Effort Escalation on Retries](#effort-escalation-on-retries) | `false` (off) |

### Available Phases

| Phase | Description |
|-------|-------------|
| `spec` | Planning and specification review |
| `security-review` | Deep security analysis (auto-added for `security`/`auth`/`authentication`/`permissions`/`admin`-labeled issues) |
| `exec` | Implementation execution |
| `testgen` | Generate test stubs from spec |
| `test` | Browser-based testing (auto-added for `ui`/`frontend`/`admin`/`web`/`browser`-labeled issues) |
| `verify` | Execution verification — runs commands and captures output for review |
| `qa` | Quality review and approval |
| `loop` | Quality iteration loop |
| `merger` | Multi-issue integration and merge |

Phase definitions, prompt templates, retry strategies, and label triggers all live in `src/lib/workflow/phase-registry.ts` — see [phase type definitions](../features/phase-type-definitions.md) for the registry pattern and how to add a new phase.

## Execution Model

Issues are always processed **one at a time** (serially). The `--sequential` flag controls **failure behavior**, not concurrency:

| Mode | Flag | Behavior on Failure |
|------|------|---------------------|
| Default | _(none)_ | Continue to next issue |
| Sequential | `--sequential` | Stop immediately |

**Why not concurrent?** The Claude Agent SDK processes one agent session at a time. True concurrent execution (e.g., via listr2) is a potential future enhancement, but the current architecture runs issues serially regardless of the `--sequential` flag.

**What `--sequential` actually controls:**

```bash
# Default: process all issues, continue if #101 fails
npx sequant run 100 101 102
#   ✓ #100 → ✗ #101 → ✓ #102  (all attempted)

# Sequential: stop on first failure
npx sequant run 100 101 102 --sequential
#   ✓ #100 → ✗ #101  (stopped, #102 skipped)
```

> **Note:** The settings file and logs may show `"sequential": false` and `Mode: parallel`. This refers to the failure behavior described above — issues still run one at a time.

## Common Workflows

### Standard Issue Resolution

Run the default workflow for a single issue:

```bash
npx sequant run 42
```

**What happens:**
1. `/spec 42` - Reviews issue and creates implementation plan
2. `/exec 42` - Implements the solution
3. `/qa 42` - Reviews code and validates against acceptance criteria

### Quick Fix (Skip Planning)

For simple fixes where planning isn't needed:

```bash
npx sequant run 42 --phases exec,qa
```

### Full Workflow with Tests

Include test generation and execution:

```bash
npx sequant run 42 --phases spec,testgen,exec,test,qa
```

### Batch Processing

Process a sprint's worth of issues:

```bash
npx sequant run 100 101 102 103 104 --sequential
```

### Quality Loop Mode

Enable automatic fix iterations when phases fail:

```bash
npx sequant run 42 --quality-loop
```

**What happens:**
1. Runs phases normally (spec → exec → qa)
2. If a phase fails, runs `/loop` to fix issues
3. Re-runs failed phases after fixes
4. Iterates up to 3 times (configurable with `--max-iterations`)

This is useful for complex issues where initial implementation may need refinement.

```bash
# Quality loop with more iterations
npx sequant run 42 --quality-loop --max-iterations 5
```

When a phase fails on one iteration but **recovers** on a later one, the issue is reported as passed consistently across the live view, the summary table, and the JSON log — a transient failure that the loop later fixes is not left showing as `failed`. The summary's failure reason reflects the *last* failing attempt, not the first.

### Chain Mode

Run dependent issues where each branches from the previous:

```bash
npx sequant run 1 2 3 --sequential --chain
```

**What happens:**

1. Issue #1 branches from `origin/main`
2. Issue #2 branches from `feature/1-xxx` (Issue #1's completed branch)
3. Issue #3 branches from `feature/2-xxx` (Issue #2's completed branch)

```text
origin/main
    └─→ feature/1-add-auth (Issue #1)
            └─→ feature/2-add-login-page (Issue #2)
                    └─→ feature/3-add-logout (Issue #3)
```

**How the chaining is established:**

Worktrees are provisioned up front, but at that moment a successor's predecessor has not committed yet — so each successor is initially cut from the base. To make the chain real, just before a successor runs (and after its predecessor has executed and committed), Sequant rebases the successor's worktree onto its predecessor's **local** committed branch. This is what guarantees `git merge-base --is-ancestor <predecessor-tip> <successor-HEAD>` holds — the successor genuinely contains its predecessor's work, not just a same-named branch cut from `main`.

**Broken chain links stop the chain:**

If a successor cannot be rebased onto its predecessor — a merge conflict, or (should-not-happen) a missing worktree — the link is broken: the successor would otherwise build on the wrong base and silently miss its predecessor's work, and that break would cascade to every later issue. Rather than ship a misleadingly "chained" PR, Sequant aborts the rebase (restoring the branch), prints a warning, and **stops the chain** — the conflicted issue and all later issues are left unrun, exactly like a stop-on-failure. Resolve the conflict (e.g. rebase the predecessor's work manually) and re-run the chain. The stopped issue is reported in the run summary with an abort reason.

**Rate-limit halts fail fast and are labeled:**

A Claude rate limit or an "Out of credits" billing failure hit mid-chain used to manifest as cascading phase timeouts — each retry burning up to a full `--timeout` window against the same closed limit. Sequant now classifies rate limits and billing failures from the SDK's structured signals (including ones that manifest as a hang): a limit whose reset lies more than a few minutes out (or an out-of-credits failure) **skips all phase retries and the MCP fallback** and halts the chain immediately, while a transient throttle is retried with short exponential backoff. The **`-Q` quality loop honors this halt too** — it will not spawn `/loop` or burn its remaining iterations on a closed window, so a billing/rate-limit stop surfaces its real cause instead of cascading into a downstream `QA completed without a parseable verdict`. When a chain halts this way, the run summary restates the cause and what to do next:

```
⚠️  Rate limited — resets at 14:30 — chain halted at #102.
    Re-run the same command to resume from #102 (no flag needed; completed links are skipped).
```

Resume is the standard chain resume: re-running the identical command skips the completed prefix and picks up at the halted link (see "Broken chain links" above and the checkpoint notes below). Failed runs also record a `failureCategory` (e.g. `rate_limit`, `billing`) in `.sequant/metrics.json` — see [analytics.md](./analytics.md).

#### Auto-wait for a rate-limit window

**Default: off.** Without `--auto-wait`, the halt described above is unchanged — a window whose reset is hours away stops the run immediately.

`--auto-wait <minutes>` says how long you are willing to wait *in total* for the window to reopen. When a phase fails on an exhausted rate-limit window whose reset fits the remaining budget, Sequant sleeps until the reset (plus a ~60 s buffer, since the reset is a floor) and retries the phase instead of halting:

```bash
npx sequant run 42 --auto-wait 360   # wait up to 6 hours total for a 5-hour window
```

Equivalent settings key and environment variable:

```json
{ "run": { "autoWaitMinutes": 360 } }
```

```bash
SEQUANT_AUTO_WAIT_MINUTES=360 npx sequant run 42
```

**What it will and won't wait for:**

| Failure | Waits? | Why |
|---------|--------|-----|
| Rate limit, reset within the remaining budget | ✅ | The window reopens on its own |
| Rate limit, reset beyond the budget | ❌ | You said you would not wait that long — halts as before |
| Rate limit with no reset time | ❌ | No timing signal; falls through to the existing short exponential backoff |
| **Out of credits (billing)** | ❌ **never** | Credits are purchased, not waited out. Note these failures *do* carry a reset timestamp, so the gate is the error type, not the presence of a timestamp |

**Bounds.** At most **2** waits per issue, and `--auto-wait` is a **total** budget across the whole issue, not a per-occurrence allowance. Two 20-minute waits spend 40 minutes of a 60-minute budget; a third window rejection halts with the usual labeled message. A window still closed on wake can therefore never produce an unbounded pause loop.

**The wait is visible and interruptible.** The live dashboard marks the phase `waiting` with its wake time, and `-s/--quiet` mode's heartbeat reports the remaining wait rather than firing its "no log activity" stall warning. Ctrl-C ends the wait promptly instead of blocking until the wake.

**Locks are held for the duration.** A waiting run keeps its worktree and issue locks. This is deliberate rather than an oversight: Claude rate limits are **account-wide**, so no other run could make progress during that window anyway — releasing the locks would only invite a second run to fail against the same closed window.

**In-process only.** The wait is a sleep inside the running process: it does **not** survive closing the terminal. For long waits, run under `tmux`/`screen` or leave the terminal open — or use the durable alternative: a run that halts on a waitable window writes a machine-readable `resumeAt` to issue state and releases its locks, and `sequant resume` (safe to schedule via cron/launchd) re-enters once the window reopens. See [halt-and-resume.md](halt-and-resume.md) (#892).

### Ready Gate (post-QA second look)

**Default: off.** `--ready-gate` opts a `sequant run` into the same post-QA gate as [`sequant ready`](ready-command.md), without the second manual command. It automates the maintainer's habitual any-gaps → fix-gaps → merge triple: after a fresh `/qa` accepts an issue, drive one more full-weight `qa → loop → qa` pass to catch what the first pass missed, then hand back to a human.

```bash
npx sequant run 42 --ready-gate      # phases, then the gate, then a PR — never merges
```

**When the gate runs.** Once an issue's standard phases succeed, and **before** the PR is created — so any fixes the gate makes are committed into the branch the PR opens on. Without the flag, nothing changes: a run still breaks to PR as before (an `AC_MET_BUT_NOT_A_PLUS` verdict is surfaced in the PR body per #749, not re-driven).

**It never merges.** The gate is the reusable engine behind `sequant ready`; its contract is unchanged here. The run terminates with the PR open and the issue persisted as `waiting_for_human_merge` (gate reached its threshold) or `blocked` (a guard — `MAX_ITERATIONS`, `TOKEN_BUDGET`, `LOOP_NO_DIFF`, or a failed loop — halted it first). The human merge gate is deliberate policy.

**No new knobs.** Everything the gate needs comes from the machinery you already configure:

| Behavior | Source |
|----------|--------|
| Gate policy (`ac` / `a-plus`) | `ready.policy` in `.sequant/settings.json` |
| Iteration cap | the run's `--max-iterations` / `run.maxIterations` |
| Token budget | disabled on the run path (the iteration cap bounds cost) |
| Stagnation guard, Non-Goals handling | internal to the gate engine (Non-Goals parsed from the issue body) |

Under the default `ac` policy an `AC_MET_BUT_NOT_A_PLUS` verdict is already at threshold, so the gate's value there is the **fresh second look** — a re-verification that can surface (and then loop-fix) an `AC_NOT_MET` the first pass accepted — not an automatic push to A+. Set `ready.policy` to `a-plus` to drive toward `READY_FOR_MERGE`.

The gate outcome (threshold reached vs guard halt) is surfaced in both the end-of-run summary and the PR body, the same way `sequant ready` reports it.

**Checkpoint Commits:**

After each issue passes QA, a checkpoint commit is automatically created. This serves as a recovery point if later issues in the chain fail.

**Resuming a partially-completed chain:**

If a chain stops part-way (a failed link, a broken rebase, or a rate-limit halt), just **re-run the identical command** — no extra flag needed. Sequant skips the contiguous prefix of links that are already `ready_for_merge`/`merged` and resumes at the first incomplete link, provisioning it from (and rebasing it onto) the last completed link's committed tip rather than `main`. Skipped links are listed explicitly in the run output with their resume commit.

- A `merged` prefix resumes from the base branch (its work is already in `origin/main`).
- If a completed link's branch and checkpoint are both gone and its tip cannot be reconstructed, resume **fails fast** with a clear message instead of silently building the successor on the wrong base.
- `--force` bypasses resume entirely and redoes the whole chain from scratch.

The checkpoint stages **only the files touched by the current issue's commits** (computed via `git diff --name-only baseBranch...HEAD`). Files dirty outside that scope — for example, `.claude/memory.md` or `.sequant-manifest.json` modified by `sequant sync` or mid-run Claude Code memory writes — are **not** swept into the checkpoint.

If unrelated dirty files are detected, the checkpoint is skipped with a warning:

```
⚠  Skipping checkpoint for #42: 1 unrelated dirty file(s) in worktree:
       - .claude/memory.md
```

**What to do when you see this warning:**

- Inspect the dirty files with `git status` in the worktree
- Either commit them intentionally (if they belong to the issue), discard them (`git checkout -- <path>`), or stash them (`git stash`)
- The chain continues, but this issue will not have a recovery point until the next successful checkpoint

Paths containing unicode or special characters are handled correctly (the scope detection uses git's NUL-terminated output internally).

**Requirements:**

- `--chain` implies `--sequential` (issues must run in order)
- Cannot be combined with `--batch` mode

**Performance Warning:**

Chain mode has a significantly lower whole-chain success rate (~29%, n=7) compared to parallel multi-issue mode (~53%, n=38). Failure compounding is the main mechanism — if any issue in the chain fails, all subsequent issues are skipped, so a single first-issue failure marks the whole chain as failed. Success drops sharply with chain length: length-2 succeeded 1/1, length-3 succeeded 1/4, length-4 succeeded 0/2. Use chain mode only when issues have genuine dependencies and prefer 2-issue chains. See [chain-mode-analysis-2026-05.md](./chain-mode-analysis-2026-05.md) for the failure-mode breakdown.

**Warnings:**

A warning is shown for chains longer than 5 issues. Long chains:
- Increase merge complexity
- Make code review more difficult
- Are harder to recover from if failures occur

Consider breaking long chains into smaller batches.

**Use Cases:**

- Implementing features that build on each other
- Multi-part refactoring where each step depends on the previous
- Building a feature incrementally (auth → login → logout)

**Merging Chain PRs:**

Option A: Sequential merge to main (recommended)
```bash
# Merge each PR in order, rebasing as needed
gh pr merge 1 --squash
# Update PR 2's base after 1 is merged
gh pr merge 2 --squash
gh pr merge 3 --squash
# Worktrees and branches are cleaned up automatically by the post-tool hook
```

Option B: Single combined review
- Review the final branch which contains all changes

### Per-Phase Model & Effort

**Default: off** — with nothing configured, every phase inherits the CLI's default model and effort exactly as before (#914). Opt in per phase when you want to run planning with a stronger model and delegate implementation to a cheaper/faster one, or dial reasoning effort up or down for a specific phase.

**Settings** (`.sequant/settings.json`):

```json
{
  "run": {
    "phases": {
      "spec": { "model": "fable" },
      "exec": { "model": "sonnet", "effort": "medium" },
      "qa": { "effort": "high" }
    }
  }
}
```

Unrecognized phase names (e.g. a typo) are reported as a non-fatal settings warning, not a crash.

**CLI flags** (`sequant run` and `sequant ready`), highest precedence:

```bash
npx sequant run 42 --models sonnet                      # applies to every phase
npx sequant run 42 --models spec=fable,exec=sonnet       # per-phase, comma-separated
npx sequant run 42 --efforts exec=medium,qa=high
npx sequant ready 42 --models qa=sonnet
```

A malformed spec (empty value, mixing a bare value with `phase=value` pairs, or an unrecognized phase name) fails fast with a usage error — it never silently resolves to "nothing configured".

**Precedence:** CLI flag > `.sequant/settings.json` > absent (SDK/CLI default). This is resolved by one shared function (`resolvePhasePolicies`) that both the `run` and `ready` execution-config builders call, so the two paths cannot drift apart on how a value resolves.

**Validation:** model values pass through to the Agent SDK unvalidated — model aliases/IDs churn independently of sequant releases, and the SDK errors clearly on a bad one. Effort values validate against the closed set `low | medium | high | xhigh | max` both when read from settings and at the `--efforts` CLI boundary (e.g. `--efforts exec=turbo` fails fast with a usage error instead of only surfacing once the value reaches the SDK); `--models` has no equivalent CLI-side check, matching its settings-side pass-through.

**Subagent inheritance:** because of an upstream limitation ([anthropics/claude-code#43869](https://github.com/anthropics/claude-code/issues/43869), tracked internally as #632), a subagent spawned during a phase inherits the *parent session's* model rather than its own `model:` frontmatter declaration. In practice this means setting a phase's model also governs every sub-agent that phase spawns (e.g. `sequant-implementer`, `sequant-qa-checker`) — one knob controls the whole phase tree, not just the top-level agent.

### Effort Escalation on Retries

**Default: off** (#915) — raising effort raises token spend, which is a cost decision the user should opt into explicitly, not one sequant makes on your behalf.

The quality risk in effort tuning lives entirely in *speculative* downgrades — guessing a task is easy from weak proxies and lowering effort before any evidence exists. The inverse carries essentially no such risk: escalating effort only after the workflow has *observed* a retry can only trade cost for quality, never the reverse. That is what this flag does — nothing more. It does **not** predict difficulty from `/spec`'s scope verdict or any other signal ahead of time; that predictive form is explicitly out of scope until dogfood metrics from #914 justify it.

**What counts as a retry:** the outer quality-loop re-entering a phase (`sequant run --quality-loop`/`-Q`, loop iteration ≥ 2) and a `sequant ready` QA-pass re-run (pass ≥ 2). A cold-start or MCP-fallback retry inside a single phase attempt does **not** count — those recover transient infrastructure failures, not task difficulty, and escalating there would spend tokens for no quality signal.

**Settings** (`.sequant/settings.json`):

```json
{
  "run": {
    "effortEscalation": true
  }
}
```

**CLI flag** (`sequant run` and `sequant ready`), highest precedence:

```bash
npx sequant run 42 --quality-loop --escalate-effort
npx sequant ready 42 --escalate-effort
```

**The ladder:** `low → medium → high → xhigh → max`. On a retried execution, the phase's resolved effort (its configured `run.phases.<phase>.effort`/`--efforts` value, or the SDK default if unconfigured) moves up exactly **one** tier — never more, regardless of how many retries have already happened. A phase whose base is already `high` on the 3rd loop iteration escalates to `xhigh`, not `max`: escalation is always computed from the phase's *configured* base, not from a previously escalated value. A phase already at `max` stays at `max`.

**Scope:** escalation applies only to the phase executions dispatched during a retried pass — never baked into a static config, so it cannot leak into a later, unrelated phase in the chain. Because the outer quality loop re-runs its whole phase list on every iteration (it does not resume from the specific phase that failed), every phase dispatched during a retried iteration escalates, including one that already succeeded on the first pass.

**Observability:** an escalated execution prints `effort: <base> → <escalated> (...)` under `--verbose`, and run metrics (`.sequant/metrics.json`) record an `effortEscalations` entry (`phase`, `base`, `escalated`) for every execution that escalated — a sibling array to the per-phase `phasePolicies` metrics field, since escalation is a per-execution value while `phasePolicies` is a flat per-run map.

### Chain Pre-flight

Every `--chain` run of 2+ issues starts with a content pre-flight. It reads each
issue once and points out cheap, high-cost-to-miss problems **before the first
worktree is provisioned** — an unready or mis-ordered chain is much cheaper to
fix at the front door than after three worktrees exist.

It warns on four things:

| Warning | Fires when |
|---------|------------|
| Missing AC | An issue has no Acceptance Criteria section, or the section has no checklist items |
| Dependency order | An issue declares `Blocked by #N` / `Depends on: #N` and #N runs *after* it in your CLI order |
| File-overlap order | Two issues are predicted to modify the same file, and your CLI order contradicts the ascending land order (the same prediction `/assess` shows) |
| Closed issue | An issue is already CLOSED on GitHub |

**Warnings never block by default.** They are advice, not a gate — a warning
usually means "look at this", not "you are wrong". Order that looks odd to the
pre-flight is often deliberate.

```text
  ⚠ #39 declares it is blocked by / depends on #38, but #38 runs AFTER #39 in
    the chain order — reorder so #38 comes first.
```

The checks run against the order **you typed**, not the dependency-sorted order,
so `sequant run 39 38 --chain` still warns even though the sorter would have
reordered it anyway. The point is to tell you the declared order and your order
disagree.

Only line-leading markers count as declarations, so prose that merely mentions
`blocked by #N` mid-sentence — or shows it inside a code fence — is ignored.

**Making warnings fatal:**

Add `--strict-preflight` to turn any warning into a hard stop, exiting `1`
before provisioning anything. Useful in CI, where an unready chain should fail
loudly rather than burn a runner:

```bash
npx sequant run 38 39 40 --chain --strict-preflight
```

If `gh` cannot fetch an issue, that issue's checks are skipped with a note — the
pre-flight never fails a run on its own.

### Stacked PRs

`--stacked` builds on `--chain` and changes only one thing: each non-first PR
targets its **predecessor branch** as the base instead of `main`. This means
reviewers see the incremental diff for each issue, not the cumulative diff of
the whole chain.

```bash
npx sequant run 100 101 102 --stacked
```

**What happens:**

| Issue | Branch | PR base |
|-------|--------|---------|
| #100 (first) | `feature/100-...` | `main` |
| #101 | `feature/101-...` | `feature/100-...` |
| #102 (last) | `feature/102-...` | `main` |

The last PR keeps `main` as its base so the stack can land partially — you don't
have to merge the whole chain atomically. (To make the last PR target its
predecessor instead, do not use `--stacked` for that final issue.)

Each PR body includes a manifest line:

```
Part of stack: #100 → #101 (this) → #102
```

**Requirements:**

- `--stacked` implies `--chain` (and therefore `--sequential`)
- Cannot be combined with `--no-chain` (errors at startup)

**Performance Warning:**

`--stacked` inherits chain-mode's reliability profile (~29% whole-chain success
rate; see [chain-mode-analysis-2026-05.md](./chain-mode-analysis-2026-05.md)).
Use it only for chains you would already run with `--chain`.

**Merge Order Matters:**

Stacked PRs **must merge in order** (predecessor first, then dependents).
GitHub auto-updates a dependent PR's base when its predecessor merges, so
landing in order works without manual rebasing. Merging out of order will
re-base the dependent PR's diff against an unexpected commit.

The `/merger` skill warns when it detects stacked PRs being processed out of
order; see [merger skill docs](../../.claude/skills/merger/SKILL.md).

**Caveats:**

- **2-issue stacks are manifest-only.** With `run 100 101 --stacked`, both PRs target `main` (#100 is first, #101 is last; there is no middle PR to gain an incremental-diff benefit). The stack manifest still renders, but the base-branch behavior is identical to plain `--chain`. Use `--stacked` for chains of 3+ issues.
- **The final PR shows the cumulative diff.** Because the last branch still rebases onto `main` before its PR is created (preserving existing `--chain` behavior and the partial-landing default for AC-3), reviewers see the entire stack's diff on the final PR — not its incremental change vs. its predecessor. Only the middle PRs show incremental diffs.

### QA Gate Mode (deprecated)

> **`--qa-gate` is deprecated as of #795 and does nothing.**
>
> It is still accepted — passing it will not error, so existing scripts keep
> working — but it prints a deprecation notice on **stderr** and has no effect
> on execution. It will be removed in a future major release.
>
> The notice is not silenced by `--quiet`, which suppresses progress and
> version output rather than warnings. Because it goes to stderr, it never
> reaches a script that pipes `sequant run`'s stdout.

**Why it was removed.** The flag promised to "wait for QA pass before starting
the next issue in a chain." `--chain` already does that, and more strictly: the
chain loop halts on **any** failed issue, whether the failure came from `qa` or
from any other phase. The `--qa-gate` branch in the chain loop re-checked for a
QA failure immediately before an unconditional break, so it could never change
the outcome. Everything this section previously documented — a `⏸️ QA Gate`
pause banner, a `waiting_for_qa_gate` status written during a run, distinct
recovery steps — described behavior no runtime path ever produced.

**What to use instead.** Nothing: drop the flag. `--chain` alone gives you the
gating behavior, since a failed link stops the chain before any successor is
started.

```bash
# Before
npx sequant run 1 2 3 --sequential --chain --qa-gate

# After — identical behavior
npx sequant run 1 2 3 --sequential --chain
```

Combine `--chain` with `--quality-loop` if you want failures auto-retried
before the chain gives up:

```bash
npx sequant run 1 2 3 --sequential --chain --quality-loop
```

**Note on `waiting_for_qa_gate`.** The status value itself is retained in the
state schema and is still handled by `sequant status`, reconciliation, and
state cleanup. Legacy `.sequant/state.json` files written by older versions can
contain it, and those entries must still reconcile correctly (see #606).

### CI/Scripting Mode

Run without colors for CI environments:

```bash
npx sequant run 42 --no-color
```

**Exit codes.** A job can gate on the exit code instead of parsing output:

- `0` — the run completed successfully.
- `1` — the run failed, a numeric flag was malformed (`--timeout 30m` is
  rejected, not read as `30` — #833/#845), or a pre-flight rejected the
  invocation (uninitialized project, missing prerequisites). Pre-flight
  rejections exit non-zero across `run`/`update`/`state`/`status`/`init`
  (#848).
- `128 + signum` — the run was terminated by a signal (e.g. `143` = SIGTERM,
  `130` = SIGINT). Externally-killed runs surface as aborts rather than
  exiting `0` (#856).
- `sync --dry-run` / `update --dry-run` exit non-zero when work is pending.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PHASE_TIMEOUT` | Override default timeout (seconds) | `1800` |
| `PHASES` | Override default phases | `spec,exec,qa` |
| `SEQUANT_QUALITY_LOOP` | Enable quality loop | `false` |
| `SEQUANT_MAX_ITERATIONS` | Max quality loop iterations | `3` |
| `SEQUANT_SMART_TESTS` | Enable smart test detection | `true` |
| `SEQUANT_TESTGEN` | Enable testgen phase | `false` |

Example:
```bash
PHASE_TIMEOUT=3600 npx sequant run 42  # 1 hour timeout
SEQUANT_QUALITY_LOOP=true npx sequant run 42  # Enable quality loop
```

## MCP Server Support

`sequant run` supports MCP (Model Context Protocol) servers for enhanced functionality in headless mode. When enabled, each phase agent gets the sequant MCP server plus any servers declared in the project's own `.mcp.json` — **not** a passthrough of your Claude Desktop config.

Phase agents are unattended and run with `bypassPermissions`, so they get an allowlist rather than everything the interactive Claude Desktop app happens to have configured. This also matters for secrets: Claude Desktop configs can't use `${VAR}` references, so any credential-bearing server there holds a literal value — one the Agent SDK would otherwise serialize into the phase process's argv. `.mcp.json` is committed to git and expected to be secret-free by convention (#936).

### How It Works

1. **Reads the project's `.mcp.json`** (the same file Claude Code itself uses) from the phase's working directory

2. **Always includes the sequant MCP server**, regardless of what `.mcp.json` declares

3. **Passes the merged `mcpServers`** to the SDK `query()` call for each phase

4. **Graceful degradation**: If `.mcp.json` doesn't exist or is invalid, runs with just the sequant server

### Configuration

| Option | Setting | Default | Description |
|--------|---------|---------|-------------|
| `--no-mcp` | - | - | Disable MCPs for faster/cheaper runs |
| - | `run.mcp` | `true` | Enable MCP servers by default |
| - | `run.mcpAllowlist` | — | Explicit per-server opt-in to pass specific Claude Desktop servers through anyway (#936) — see [Allowlisting a Desktop-Only Server](#allowlisting-a-desktop-only-server) |

**Priority:** CLI flag (`--no-mcp`) → Settings (`run.mcp`) → Default (`true`)

### Usage Examples

```bash
# Default: MCPs enabled (sequant server + project .mcp.json)
npx sequant run 42

# Disable MCPs for faster execution
npx sequant run 42 --no-mcp

# Disable MCPs via settings
# In .sequant/settings.json: { "run": { "mcp": false } }
```

### Checking MCP Availability

Run `sequant doctor` to see what's configured:

```bash
sequant doctor
```

Look for the "MCP Servers (headless)" check — it reports the same set a phase will actually receive (sequant + `.mcp.json` entries + any `mcpAllowlist` names), not your Claude Desktop config.

### Supported MCPs

MCPs that enhance Sequant skills in headless mode:

| MCP | Skills Enhanced | Purpose |
|-----|-----------------|---------|
| Context7 | `/exec`, `/fullsolve` | External library documentation lookup |
| Sequential Thinking | `/fullsolve` | Complex multi-step reasoning |
| Chrome DevTools | `/test`, `/testgen`, `/loop` | Browser automation for UI testing |

### Adding MCPs for Headless Mode

To add MCP servers for use with `sequant run`, add them to the project's `.mcp.json` — **not** your Claude Desktop config, which phase agents no longer read (#936).

**1. Locate (or create) `.mcp.json` at the project root** — `sequant init` already creates it with a `sequant` entry.

**2. Add MCPs to the `mcpServers` object:**

```json
{
  "mcpServers": {
    "sequant": {
      "command": "npx",
      "args": ["-y", "sequant@<version>", "serve"]
    },
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "sequential-thinking": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    }
  }
}
```

**3. Config format:**

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "npx",           // Command to run
      "args": ["-y", "<package>"], // Arguments (use -y for auto-install)
      "env": {                     // Optional: environment variables
        "API_KEY": "..."
      }
    }
  }
}
```

**`.mcp.json` is committed to git** — do not put literal secrets in `env`. If an MCP needs a credential, it's not a good fit for this file; keep it in Claude Desktop for interactive use only.

**4. Changes take effect immediately** for the next `sequant run` — no restart needed, since each phase reads `.mcp.json` fresh from the worktree.

### Allowlisting a Desktop-Only Server

`.mcp.json` is the right home for most MCPs, but sometimes a server genuinely only exists in your Claude Desktop config — e.g. one you're still evaluating, or one you deliberately keep out of a committed file. `settings.run.mcpAllowlist` is the explicit, per-server escape hatch (#936):

```json
{
  "run": {
    "mcpAllowlist": ["stripe"]
  }
}
```

A name listed here that's present in your Claude Desktop config's `mcpServers` is passed through to phase execution; a name not present there is silently ignored. Project `.mcp.json` entries and the sequant server always win over an allowlisted desktop entry of the same name.

**⚠️ This is a deliberate secret-exposure decision, not a convenience toggle.** Claude Desktop configs can't use `${VAR}` references, so a server's config there may carry a literal credential — one the Agent SDK serializes into the phase process's `--mcp-config` argv, visible to any local process via `ps` and captured into agent transcripts. Only allowlist a server whose config has no credential, or whose credential you accept exposing to autonomous phase agents. When in doubt, add the server to `.mcp.json` instead (never with a literal secret in `env`), or don't allowlist it at all.

### When to Disable MCPs

Use `--no-mcp` when:
- Running on a system without Claude Desktop installed
- Optimizing for cost (MCPs add token overhead)
- Running simple issues that don't need external documentation
- Debugging to isolate MCP-related issues

## Settings File

You can configure defaults in `.sequant/settings.json`:

```json
{
  "version": "1.0",
  "run": {
    "logJson": true,
    "logPath": ".sequant/logs",
    "autoDetectPhases": true,
    "timeout": 1800,
    "sequential": false,
    "qualityLoop": false,
    "maxIterations": 3,
    "smartTests": true,
    "mcp": true,
    "autoWaitMinutes": 0,
    "phases": {
      "exec": { "model": "sonnet", "effort": "medium" }
    }
  }
}
```

Settings hierarchy (highest priority wins):
1. CLI flags (`--quality-loop`)
2. Environment variables (`SEQUANT_QUALITY_LOOP`)
3. Project settings (`.sequant/settings.json`)
4. Package defaults

## Output

### Success Output

```
🚀 Sequant Workflow Execution

  Stack: nextjs
  Phases: spec → exec → qa
  Mode: continue-on-failure
  Issues: #42

  Issue #42
    ⏳ spec...
    ✓ spec (2m 30s)
    ⏳ exec...
    ✓ exec (15m 45s)
    ⏳ qa...
    ✓ qa (1m 20s)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Results: 1 passed, 0 failed
  ✓ #42: spec → exec → qa (19m 35s)
```

### Failure Output

```
  Issue #42
    ⏳ spec...
    ✓ spec (2m 30s)
    ⏳ exec...
    ✗ exec: Exit code 1

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Results: 0 passed, 1 failed
  ✗ #42: spec → exec (2m 30s)
```

## Worktree Isolation

By default, `sequant run` creates isolated git worktrees for each issue. This ensures:

- **Clean separation**: Each issue's changes are isolated from others
- **Parallel safety**: Multiple issues can be worked on simultaneously
- **Easy cleanup**: Worktrees can be removed without affecting other work

### Fresh Baseline

When creating a new worktree, Sequant:

1. **Fetches latest main**: Runs `git fetch origin main`
2. **Branches from origin/main**: Creates the branch from `origin/main`

This guarantees every new issue starts from the latest remote state.

### Worktree Location

Worktrees are created in a `worktrees/` directory alongside your repository:

```text
parent-directory/
├── your-repo/           # Main repository
└── worktrees/
    ├── feature/123-add-login/
    └── feature/124-fix-bug/
```

### Reusing Worktrees

If a worktree already exists for an issue's branch, Sequant reuses it.
This preserves any in-progress work.

In **chain mode**, existing worktrees are automatically rebased onto the previous chain link. If a rebase conflict occurs, the rebase is aborted and the worktree continues in its original state with a warning.

### Phase Isolation

Not all phases run in the worktree:

| Phase  | Location  | Reason                           |
| ------ | --------- | -------------------------------- |
| `spec` | Main repo | Planning only, no code changes   |
| `exec` | Worktree  | Implementation happens here      |
| `test` | Worktree  | Tests run against implementation |
| `qa`   | Worktree  | Review happens in context        |

## Troubleshooting

### "Sequant is not initialized"

**Symptoms:** Error message says Sequant is not initialized

**Solution:** Run `sequant init` in your project root first:
```bash
sequant init
```

### Phase timeout

**Symptoms:** Phase fails with "Timeout after 1800s"

**Solution:** Increase the timeout:
```bash
npx sequant run 42 --timeout 3600  # 1 hour
```

### Claude CLI not found

**Symptoms:** Error about `claude` command not found

**Solution:** Install and configure Claude CLI:
```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

### GitHub authentication

**Symptoms:** Issues can't be fetched or commented on

**Solution:** Authenticate GitHub CLI:
```bash
gh auth login
gh auth status
```

## See Also

- [Customization Guide](../guides/customization.md) - Configure phases and timeouts
- [Troubleshooting](../troubleshooting.md) - Common issues and solutions
- [Testing Guide](../internal/testing.md) - Cross-platform testing matrix

---

*Generated for Issue #1 on 2026-01-06*
