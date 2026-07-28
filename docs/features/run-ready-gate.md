# Run Ready Gate (`--ready-gate`)

**Quick Start:** `sequant run <issue> --ready-gate` runs the post-QA ready gate inside a normal `run`. Once the issue's standard phases pass, it drives one more full-weight `qa → loop → qa` gate (the same engine as `sequant ready`) to the configured policy **before** opening the PR — automating the habitual any-gaps → fix-gaps second look — then stops at the human merge gate. It **never merges**. Off by default.

## Why

Session-log analysis showed that after essentially every `/qa`, the maintainer manually typed the same triple: a gap probe ("any gaps?"), a fix command ("fix all gaps"), then "merge". That probe reliably surfaced real defects the first `/qa` accepted (consistent with the recorded ~44%-of-second-looks defect rate). `sequant ready` (#683) already automates exactly that loop — but on the `run` path it required a second, manually-invoked command. `--ready-gate` makes it reachable in-line, while keeping the human merge gate deliberate.

It also gives the #749 `AC_MET_BUT_NOT_A_PLUS` break-to-PR outcome an automatic escalation path: with the flag, that verdict is re-driven through the gate per policy instead of dead-ending at the PR.

## How It Works

When `--ready-gate` is set and an issue's standard phases succeed, `sequant run` invokes the existing `runReadyGate` engine against the issue's worktree — **before** the rebase/PR step, so any commits the gate's fix loop makes are included in the PR that opens. The run then terminates with the PR open and the issue persisted in a `ready`-terminal state; it does not merge.

| Without `--ready-gate` | With `--ready-gate` |
|------------------------|---------------------|
| Phases pass → (optional rebase) → PR opens; `AC_MET_BUT_NOT_A_PLUS` is surfaced in the PR body and breaks to PR (#749) | Phases pass → **ready gate** (`qa → loop → qa` to `ready.policy`) → (optional rebase) → PR opens with the gate's fixes and report |
| Issue status: `ready_for_merge` | Issue status: `waiting_for_human_merge` (threshold reached) or `blocked` (guard halt) |

The gate reuses **all** of `sequant ready`'s bounds — no new configuration is introduced:

| Behavior | Source |
|----------|--------|
| Gate policy (`ac` / `a-plus`) | `ready.policy` in `.sequant/settings.json` |
| Iteration cap | the run's `--max-iterations` / `run.maxIterations` |
| Token budget | disabled on the run path (the iteration cap bounds cost) |
| Stagnation guard (`LOOP_NO_DIFF`), Non-Goals handling | internal to the gate engine (Non-Goals parsed from the issue body) |

Under the default `ac` policy, `AC_MET_BUT_NOT_A_PLUS` is already at threshold, so the gate's value there is the **fresh second look** — a re-verification that can surface (and then loop-fix) an `AC_NOT_MET` the first pass missed — rather than an automatic push to A+. Set `ready.policy` to `a-plus` to drive toward `READY_FOR_MERGE`.

## Usage

```bash
# Run an issue, then the ready gate, then open a PR — never merges
sequant run 42 --ready-gate

# Combine with the quality loop as usual
sequant run 42 -Q --ready-gate
```

The gate outcome (threshold reached vs guard halt) is surfaced in both the end-of-run summary and the PR body, the same way `sequant ready` reports it.

## Options & Settings

| Option | Description | Default |
|--------|-------------|---------|
| `--ready-gate` | Run the post-QA ready gate after phases succeed, before the PR. Never merges. | `false` (off) |

No settings accompany the flag — the gate sources its policy and bounds from the existing `ready` and `run` settings. See the [run command reference](../reference/run-command.md#ready-gate-post-qa-second-look) and the [`sequant ready` reference](../reference/ready-command.md).

## Out of Scope

Auto-merge (the human merge gate is deliberate policy), adding `merger` to the default phases, MCP exposure of the gate, and changing `-Q` semantics. The gate runs per-issue after that issue's phases; chain-level coordination beyond that is out of scope.

---

*Generated for Issue #817 on 2026-07-27*
