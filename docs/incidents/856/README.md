# #856 — `sequant run` killed at ~106s by an external signal

**Status:** cause identified with high confidence; **not** confirmed by live capture.
**Date of incident:** 2026-07-29 (three deaths, 01:21:57 / 01:36:05 / 01:39:36 local).
**Verdict:** upstream defect in Claude Code 2.1.220, not a sequant bug.

This directory exists because the investigation lived only in GitHub issue comments,
and `.sequant/` — where the raw evidence sat — is gitignored and rotates at 100 files.

---

## Summary

A nested phase `claude` that **hangs after finishing its turn** is terminated at
~106s (±1s) from spawn, and the termination takes down the entire process tree,
including the parent `sequant run`. A nested `claude` that exits cleanly is never
killed, at any lifetime (specimens survived 316s, 131.7s, 26m54s, 22m49s).

The killer is Claude Code's `[bg-pty]` host-dead watchdog issuing a **process-group
SIGKILL**.

## The mechanism

Background Bash tasks run under a detached helper
(`claude --bg-pty-host <sock> <cols> <rows> -- <cmd>`); a claude session is the
*client* that connects to that socket. Extracted from the 2.1.220 binary
(minified, reformatted):

```js
// client-side poll loop:
try { process.kill(t, 0) }          // is host pid t alive?
catch { /* dead → graceful cleanup: read tail, unlink sock, emit */ }
...
if (g >= xhp) {                     // xhp = 30 failed connect attempts
  w(`[bg-pty] ${e}: ${g} connect attempts failed; treating host as dead`,
    { level: "warn" });
  try { process.kill(-t, "SIGKILL") }          // GROUP kill
  catch { try { process.kill(t, "SIGKILL") } catch {} }
}
```

Constants: `xhp = 30` attempts; connect backoff ladder `[50, 100, 250, 500, 1000, 2000]ms`.
Telemetry names for upstream searchability: `tengu_bg_ptyhost_crash`,
`tengu_bg_adopt_sock_unlinked`, `tengu_bg_revival_guard`.

### Why this explains every measurement

- **The discriminator.** The kill fires only when the host **pid is alive but its
  socket won't accept** — precisely "hangs after finishing its turn". A clean exit
  makes `process.kill(t, 0)` throw, taking the graceful branch, so it is never
  killed at any lifetime. No other mechanism found on the machine keys on that state.
- **Simultaneous teardown + parent death.** It is a *process-group* kill. Verified
  live: an SDK-spawned phase `claude`, all its MCP servers, and the parent
  `sequant run` share one pgid. One group signal produces the entire observed
  pattern, including all ~12 MCP servers quitting inside a 60ms window.
- **Spawn-anchored constant timing.** 30 attempts on a fixed retry schedule from
  monitor start ≈ constant wall time.

### Open arithmetic gap

The backoff ladder alone sums to 51.9s; the observed ~105s implies ~1.8s of
additional per-attempt cost (e.g. a connect that must time out against a
wedged-but-alive listener). **Unresolved — needs the live capture.**

## Evidence

`mDNSResponder` stamps every `claude` process by PID, giving exact lifetimes:

```sh
# NOTE: `log` is shadowed by a zsh function on the affected machine
# (`(eval):log:1: too many arguments`). Use the absolute path.
/usr/bin/log show --predicate 'process == "mDNSResponder" AND eventMessage CONTAINS "claude"'
```

| PID | lifetime | outcome |
|---|---|---|
| 21762 | 107.08s | KILLED (parent died 01:21:57) |
| 33738 | 106.23s | KILLED (parent died 01:36:05) |
| 40181 | 105.41s | KILLED (parent died 01:39:36) |
| 17241 | 316s | exited normally — no blanket cap |
| outside-session phase | 131.7s | clean exit, survived past 106s |

Spread across the three deaths: **1.7s**.

Victims identified by transcript — all three, to the second:

| session | project dir | first entry | last entry | wall | `run_in_background` calls |
|---|---|---|---|---|---|
| `2b7de5d9` | worktrees/feature-848 | 06:20:10.848Z | 06:21:57.075Z | 106.2s | 1 |
| `78565ed5` | Projects/sequant (main) | 06:34:20.059Z | 06:36:05.464Z | 105.4s | 0 |
| `a5d0bda3` | Projects/sequant (main) | 06:37:52.232Z | 06:39:36.828Z | 104.6s | 0 |

Last-entry timestamps equal the three parent-death times exactly.

Stop-hook → SessionEnd gap, from `.entire/logs/entire.log`:

- healthy phase: **0.36s**
- the three killed phases: **96.3s / 58.0s / 92.7s**

Two of three victims made **zero** background calls of their own but ran with cwd
in the same project directory as an interactive session. Their own bg tasks
cannot be the trigger; shared per-project bg-pty state (spare-pool claim, or sock
adoption contention between the nested claude and the interactive session that
owns the sock) is the leading trigger hypothesis. That also explains the
intermittency — it depends on what persisted bg-pty state was visible when the
phase claude started.

## Ruled out (each by direct measurement)

- **Idle-output timeout** — a background task that printed one line then stayed
  silent 300s completed normally. One victim survived a 107s intra-run silence
  and died after a 108s one; a threshold cannot sit in a 1s window crossed in
  both directions.
- **Lifetime cap** — runs survived 26m54s and 22m49s.
- **`CLAUDE_STREAM_IDLE_TIMEOUT_MS`** — governs the model API response stream;
  aborts/retries a request, does not SIGTERM a child.
- **sequant signalling itself** — five signal-capable sites; the only cross-process
  SIGTERM requires both `--force` and `--signal-other` (CLI-only, unreachable from
  settings or env) and is self/parent-guarded at the syscall. No timeout constant
  between 100–300s exists anywhere in the source.
- **Hooks** — zero `kill`/`pkill`/`killall`/`trap` across all four hook scripts and
  both mirrors; the hooks were verified to have fired inside the nested agent.
- **`entire` CLI** — logged "no files modified during session, skipping checkpoint"
  on every turn; `git reflog` empty at all three death timestamps.
- **launchd** — only `com.admarble.pm-orchestrator` can kill; wrong schedule, and it
  only signals the PID in its own lockfile.
- **jetsam / memory pressure / sandbox denials / TMOUT / ulimit** — all negative.
- **Concurrent process-group kill from the test suite** — the successful
  outside-session run began 6 minutes *after* the last death; no overlap.
- **Stale PID / lock reuse**, and the MCP group-kill at `src/mcp/tools/run.ts`
  (`detached: true` is set, so `kill(-pid)` targets a genuine group leader).

## What is still unproven (AC-1, AC-2, AC-3)

These acceptance criteria require catching the hang live. The issue body states
the hang is **not reproducible on demand** — a later run with identical `-Q` flags
cleared `spec` and ran 8m53s into `exec` before being stopped manually.

### Corrected dtrace predicate

The original AC-1 predicate is **wrong as written**:

```sh
# WRONG — captures only SIGTERM. The primary kill here is a group SIGKILL,
# so a 15-only capture may record nothing and falsely exonerate.
sudo dtrace -n 'proc:::signal-send /args[2] == 15/'

# CORRECT
sudo dtrace -n 'proc:::signal-send /args[2] == 15 || args[2] == 9/ { printf("%d -> %d sig %d", pid, args[1]->pr_pid, args[2]); }'
```

"External SIGTERM" in the original finding was **inferred, not captured**.

### Sharper repro matrix

AC-3's `--no-mcp` control is still worth running, but it now tests the wrong
variable: the post-turn hang and the kill are **one** upstream defect, and the ~12
live MCP servers are a downstream symptom of never reaching teardown, not the
cause. The informative matrix is instead:

{backgrounded vs foreground launch} × {concurrent same-cwd interactive session vs none}

Prediction: foreground launches from a plain shell never die (consistent with the
131.7s and 316s clean specimens and a terminal-launched run 771); backgrounded
launches with a same-project interactive session are the vulnerable configuration.

## Workaround (available today)

Launch long `sequant run`s from a **plain terminal**, or via the MCP `sequant_run`
tool — **never** as a backgrounded Bash task inside an interactive Claude Code
session. Every observed death was a backgrounded launch; no foreground launch has
ever died.

## Upstream

If a live capture confirms, file against Claude Code: the "treating host as dead"
heuristic group-SIGKILLs a process tree whose host is alive-but-busy, and the
process group it kills can contain the caller's own ancestors. Reference the
extracted strings and telemetry names above; version 2.1.220.

## What this repo changed in response

sequant cannot prevent an uncatchable `SIGKILL`. What it can do is stop
*misreporting* the aftermath, and recover from the debris:

| Change | File |
|---|---|
| Terminated run exits `128+signum`, prints the cause, and names this doc for SIGTERM | `src/lib/shutdown.ts` |
| In-flight issues are logged as aborted with their cause instead of `success` | `src/lib/workflow/log-writer.ts` |
| Zero completed phases is a `failure`, not a pass | `src/lib/workflow/run-log-schema.ts` |
| `sequant logs` renders an aborted run as `ABORTED` with the signal | `src/commands/logs.ts` |
| Locks leaked by a SIGKILLed run self-clear after 24h instead of blocking forever | `src/lib/locks/lock-manager.ts` |
