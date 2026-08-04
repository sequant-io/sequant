# #860 AC-7 — in-process wait vs halt-and-resume: the decision

**Decision: keep the in-process wait (#804) as the shipping mechanism, with
eyes open about its two real costs (lock-holding, reboot loss). Halt-and-resume
is the better long-term shape for unattended multi-hour pauses and is filed as
a follow-up rather than built here.**

## Context

#860's actual defect was classification: `isBillingFailure` turned every
subscription five-hour exhaustion into a terminal `BillingError`, so
`--auto-wait` could never fire on the only payload shape real runs produce.
With classification fixed, the question AC-7 asks is whether the wait
mechanism itself — a live process sleeping up to five hours — is the right
shape, versus halting cleanly with a machine-readable `resumeAt` and letting a
scheduler re-invoke.

## The comparison, argued

| Dimension | In-process wait (#804) | Halt-and-resume |
|---|---|---|
| Per-issue lock | **Held for the whole wait.** Nothing else can touch the issue; `sequant status` shows it in-progress. Post-#856, a stale lock with a recycled PID can read as fresh and block the issue indefinitely after a crash mid-wait. | Released at halt. No lock exposure. |
| Reboot / power loss | **Run is lost; stale lock remains.** The wait buys *resumption*, not continuity — the `claude` subprocess died at the failure, so on wake the phase restarts from scratch anyway. | Survives for free; state file names `resumeAt`. |
| Laptop sleep | Survives — `waitForWindowReset` is wall-clock tick-based (injectable `now()`, deadline check), so a resumed machine wakes on schedule. | Survives trivially. |
| Observability | Fixed by #860 AC-6: TTY heartbeat line, and now periodic non-TTY notices naming the wake time in both the quiet-mode heartbeat and the default-mode NonTTY renderer. Orchestrator/MCP runs get throttled `SEQUANT_PROGRESS` waiting lines (which also reset the MCP inactivity timeout) and the wait is persisted to issue state (`autoWait.wakeAt`), so `sequant status` reports the pause instead of an hours-stale in-progress phase. The MCP transport's 2-hour absolute ceiling still bounds how long an MCP-initiated wait can survive — a full five-hour wait needs a CLI run or the halt-and-resume follow-up (#892). | Trivial — the process exits and the state file says why and until when. |
| Runaway bounds | `AUTO_WAIT_MAX_WAITS = 2` + total minutes budget; Ctrl-C aborts via a registered `AbortController`. | Needs an equivalent re-entry bound to avoid a scheduler ping-ponging a still-closed window. |
| Chain/worktree context | **Preserved in memory across the pause** — no re-derivation, no cold start on wake. | Re-derived on re-entry. #837 makes resumed runs skip completed issues, so re-entry is cheap but not free (process start, context re-load, spec re-read). |
| Infrastructure required | None — works today with one flag. | A scheduler entry (`launchd`/cron) or a wrapper loop; plus `resumeAt` state schema and a `--resume-window` entry path. |

## Why in-process wins *now*

1. **It exists and is careful.** The #804 machinery is tick-based, sleep-safe,
   abortable, and double-bounded. The defect was upstream classification, not
   the wait. Discarding working, tested machinery to build a scheduler
   integration would be scope expansion inside a classification fix.
2. **The overnight scenario it serves is the common one.** A laptop that stays
   on overnight (lid open or on power) waits and finishes. The reboot case is
   real but is the *uncommon* failure of the uncommon case — and its blast
   radius is "the run halted anyway", i.e. exactly today's pre-#804 behavior
   plus a stale lock that `locks clear` (or 6h age-based recovery) resolves.
3. **Opt-in and bounded.** `--auto-wait` defaults off. A user who prefers
   halt-and-resume semantics simply doesn't enable it, and #799's fail-fast
   plus the recorded reset time in the error message already tell them when to
   re-run.

## What halt-and-resume needs to become the default (follow-up scope)

- A `resumeAt` field in issue state written at the billing/window halt.
- A `sequant run --resume` (or `--ready-gate`-style) entry that no-ops until
  `resumeAt` and then continues, leaning on #837's completed-issue skipping.
- Lock release at halt + re-acquisition on re-entry (removes the #856-adjacent
  stale-lock exposure entirely).
- A re-entry counter mirroring `AUTO_WAIT_MAX_WAITS` so a window that never
  reopens cannot ping-pong the scheduler.
- ~20 lines of documented `launchd`/cron recipe.

That is a coherent feature, not a patch — which is exactly why it is recorded
here and filed as a follow-up instead of being smuggled into #860.

**Update (#892):** the follow-up shipped — `windowHalt.resumeAt` in issue
state, the `sequant resume` re-entry command with its per-issue bound, and the
scheduler recipe. See
[docs/reference/halt-and-resume.md](../reference/halt-and-resume.md).
