# Draft upstream report — Claude Code group-kills a backgrounded process tree at ~106s

> Status: **draft, not yet filed.** File against `anthropics/claude-code` once a
> maintainer-facing repro is captured, or file as-is citing the evidence below —
> the correlation is strong even without the live capture. Version observed:
> **2.1.220** (macOS, arm64).

## Summary

A process tree containing a backgrounded task inside an interactive Claude Code
session was terminated three times at **105–107s (±1s) from spawn** by an
external, group-directed signal sequence (catchable SIGTERM, then an escalation
the tree did not survive). The tree included a nested SDK-spawned `claude`, its
MCP servers, and the user's own CLI process (`sequant run`) — all sharing one
process group. Sessions that exit cleanly are never killed at any lifetime
(specimens: 131.7s, 316s, 26m54s clean runs).

## Timeline (2026-07-29, UTC)

| Event                                                                | Time                         |
| -------------------------------------------------------------------- | ---------------------------- |
| Background daemon `auth: proactive refresh failed` → `auth_required` | 06:04:22.6                   |
| Victim 1 spawn → death                                               | 06:20:10 → 06:21:57 (106.2s) |
| Victim 2 spawn → death                                               | 06:34:20 → 06:36:05 (105.4s) |
| Victim 3 spawn → death                                               | 06:37:52 → 06:39:36 (104.6s) |
| Daemon idle-exits (`idle 5s with no clients`)                        | 09:48:23                     |

**All three deaths fall inside the daemon's unauthenticated window; none have
occurred in the 30+ hours since the daemon exited.** No deaths before the auth
failure either, across a multi-day record.

## Evidence

- Victim lifetimes from `mDNSResponder` per-PID stamps: 107.08s / 106.23s /
  105.41s — spread 1.7s across three deaths, consistent with a fixed timer or
  retry ladder anchored at spawn.
- The killed run's own captured stdout survives:

  ```
  [01:34:18] ▸ #846 spec

  !  Received SIGTERM, shutting down gracefully...
  ✓ Aborted 1 active phase
  ```

  …then nothing — cleanup truncated mid-sequence. So the first signal is
  **catchable SIGTERM**, followed by a kill the handler did not survive.

- All MCP servers in the tree exited within a **60ms window** at each death —
  a single group-directed signal, not a cascade.
- The interactive session that spawned the backgrounded task **survived** each
  time (it is in a different process group).

## Candidate mechanisms (both in Claude Code, neither confirmed)

1. **`[bg-pty]` host-dead watchdog.** Extracted from the 2.1.220 binary: after
   `xhp = 30` failed socket connects to a bg-pty host whose PID is still alive,
   the client runs `process.kill(-t, "SIGKILL")` — a process-group kill.
   Backoff ladder `[50,100,250,500,1000,2000]ms`. Telemetry names:
   `tengu_bg_ptyhost_crash`, `tengu_bg_adopt_sock_unlinked`,
   `tengu_bg_revival_guard`. Matches the "alive but not accepting"
   discriminator exactly; the ladder alone sums to 51.9s, so ~105s implies
   ~1.8s extra per attempt (unconfirmed).
2. **The background daemon during its `auth_required` window.**
   `CLAUDE_BG_BACKEND="daemon"`; bg-pty hosts are spawned by a transient
   daemon as a spare pool. The daemon logged
   `auth: headless daemon cannot complete OAuth` 17 minutes before the first
   death, and `~/.claude/daemon-auth-status.json` recorded `auth_required` at
   the same millisecond. Every death falls inside that window.

These may be one mechanism (an unauthenticated daemon wedging its bg-pty hosts,
whose clients then declare them dead and group-kill). The victims' post-turn
hang (Stop-hook→SessionEnd gaps of 58–96s vs a 0.36s baseline) appears to be
the same defect, not a separate one.

## Why this is a bug and not policy

The group it kills **contains the user's own ancestor processes** — the
backgrounded command the user launched, not just Claude-internal helpers. A
watchdog for a wedged PTY host should not be able to SIGKILL the user's build,
test run, or (here) a 30-minute orchestration process as collateral.

## Ruled out by direct measurement

Idle-output timeouts, lifetime caps, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`, shell
`TMOUT`/ulimit, launchd jobs, jetsam/memory pressure, third-party tooling
(`entire` CLI), and the victim application signalling itself (its only
cross-process kill path is CLI-gated and self/parent-guarded). Full matrix in
`docs/incidents/856/README.md` of `sequant-io/sequant`.

## Repro status

Not reproducible on demand yet: the vulnerable window requires a **live daemon
in `auth_required` state**, and the daemon is transient (exits 5s after last
client) while auth failures are spontaneous. Prepared instrumentation, verified
by positive control against group-directed signals, is committed in
`sequant-io/sequant` under `docs/incidents/856/tools/`:

- `signal-canary.c` — SA_SIGINFO handler capturing `siginfo_t.si_pid` (the
  sender) for the catchable SIGTERM. Used because on a SIP-enabled machine the
  dtrace `proc:::signal-send` provider is withheld entirely.
- `verify-capture.sh` — positive-control test of the whole rig (5/5, no sudo).
- `induce-bgpty-hang.sh` — SIGSTOPs a bg-pty host to induce the exact
  "alive but not accepting" state the watchdog keys on.

Negative control: with the daemon down, a canary-instrumented backgrounded task
ran 200s (≈2× the threshold) untouched — backgrounding alone is not sufficient.

## Ask

1. Confirm whether the bg-pty host-dead watchdog can group-kill a tree
   containing the client's own ancestors, and bound its blast radius.
2. Confirm what the daemon does to live bg sessions when it enters
   `auth_required` — the observed window correlation is exact.
3. If a fixed ~105s timer exists in either path, name it so field reports can
   match on it.
