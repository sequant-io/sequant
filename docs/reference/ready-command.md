# Ready Command

**Quick Start:** After a resolve finishes, run `sequant ready <issue>` to reproduce the maintainer's manual fresh-session A+ QA pass deterministically. It drives the issue's worktree through a full-weight `qa → loop → qa` pipeline, surfaces every gap in a structured report, and **stops at the human merge gate — it never merges.**

## Access

- **Command:** `npx sequant ready <issue> [options]`
- **Requirements:**
  - The issue already has a worktree (i.e. `sequant run <issue>` ran first).
  - GitHub CLI authenticated (`gh auth login`) — used to read the issue's Non-Goals.
- **Relationship:** Runs AFTER a resolve (`sequant run` / `/fullsolve`), BEFORE a human merges.

```text
sequant run 712          # implement
sequant ready 712        # full-weight A+ gate (this command) — stops, never merges
gh pr merge 712          # human decides
```

## Why it exists

Empirical analysis of `.entire` logs (2026-05-30) found the QA pass that runs *inside* `sequant run` / `/fullsolve` systematically under-catches relative to the fresh standalone `/qa` the maintainer runs afterward — **44% of fresh-session passes caught a real shipping bug or unmet AC** that had already passed an in-orchestrator QA. Two structural gaps drive this:

1. **Orchestrated QA trusts the orchestrator's git state** and skips the branch-freshness / process-state pre-flight checks — exactly the no-implementation / divergent-branch class.
2. **The fullsolve QA loop stops at "good enough"** (`AC_MET_BUT_NOT_A_PLUS`) and never drives toward A+.

`sequant ready` closes both: it runs QA at **full standalone weight** (the pre-flight checks execute even under an orchestrator) and loops to a policy-selected threshold — while preserving the human merge decision.

## Gate policy (configurable rigor)

The loop's exit threshold is set by a **policy**, not hardcoded:

| Policy | Loops until | Quality / polish gaps | Audience |
|--------|-------------|-----------------------|----------|
| **`ac`** (default) | no `AC_NOT_MET` remains (ACs objectively met) | **documented in the report, NOT auto-fixed** | team engineer, fixed agenda, predictable diff |
| `a-plus` (opt-in) | `READY_FOR_MERGE` | auto-fixed in the loop | solo maintainer / max-quality |

- `ac` is the **default** deliberately: "ACs met" is an *objective* stop condition (the written checklist), whereas `a-plus` auto-loops everything and risks scope creep, an unpredictable stop condition, and noise. `ac` still runs the full-weight QA + adversarial re-read, so **every** gap is surfaced in the report — it just stops *fixing* at the AC boundary.
- In `ac` mode, any finding that touches the issue's **Non-Goals** is explicitly **report-only** (never fed to the fix loop).
- Resolution precedence: `--policy` flag **>** `ready.policy` in `.sequant/settings.json` **>** default `"ac"`.

## Usage

### Drive an issue to merge-readiness (default `ac` policy)

```bash
npx sequant ready 712
```

### Opt into the max-quality A+ loop

```bash
npx sequant ready 712 --policy a-plus
```

### Cap the loop and emit JSON

```bash
npx sequant ready 712 --max-iterations 4 --budget 300000 --json
```

## Options

| Flag | Description |
|------|-------------|
| `--policy <ac\|a-plus>` | Gate policy. Overrides `ready.policy` in settings. Invalid values fall back to settings/default. |
| `--max-iterations <n>` | Max QA passes before halting for human review (default: `run.maxIterations`). |
| `--budget <tokens>` | Token budget; on exhaustion the command halts cleanly with a "needs human" message rather than looping. |
| `--timeout <seconds>` | Per-phase timeout (default: `run.timeout`). |
| `--no-mcp` | Disable MCP server injection in headless mode. |
| `--json` | Emit a structured JSON result instead of the markdown report. |
| `-v, --verbose` | Verbose phase output. |

## Termination & guards

The loop terminates on the **first** of:

- **Policy threshold reached** — `ac`: no `AC_NOT_MET`; `a-plus`: `READY_FOR_MERGE`. → state `waiting_for_human_merge`, exit `0`.
- **`maxIterations`** — clean "needs human" halt. → state `blocked`, exit `1`.
- **Token budget** — clean halt on exhaustion. → state `blocked`, exit `1`.
- **`LOOP_NO_DIFF`** — the fix loop made no commit and no working-tree change (stagnation guard). → state `blocked`, exit `1`.
- **No implementation (#534 guard)** — a zero-diff worktree (empty branch, the #529/#570 class) or a null/unparseable QA verdict is **never** reported ready. → state `blocked`, exit `2`.

## Output

A structured gap report (markdown, or `--json`) containing:

- **Headline + stop reason** — ready vs. needs-human vs. no-implementation.
- **Final verdict** and **QA pass count**.
- **Auto-fixed** — gaps the fix loop addressed across iterations.
- **Remaining / accepted gaps** — quality gaps (under `ac`) and **Non-Goal** items, tagged report-only.
- **Final state** — `waiting_for_human_merge` or `blocked`. Reflected by `sequant status`.

> The human merge gate is intentional and permanent: `sequant ready` never merges. Review the gaps, then merge manually when satisfied.

## Non-goals

- `--from-pr <N>` (reverse PR→issue resolution) — a follow-up, not yet supported.
- `sequant run --ready-gate` flag integration — a follow-up; reuses this engine (`runReadyGate`).
- Auto-merge of any kind — the human merge gate is deliberate.

## See also

- `ready.policy` in `.sequant/settings.json` — configure the default policy (`sequant init` documents it inline).
- [Ready-gate backtest](../investigations/ready-gate-backtest.md) — recall/noise measurement methodology.
- Motivation: `.entire` log study (2026-05-30); related #448, #582, #608/#609, #534.
