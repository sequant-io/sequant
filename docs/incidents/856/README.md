# #856 — `sequant run` killed at ~106s by an external signal

**Status:** ⚠️ **cause NOT settled.** An earlier revision of this doc called the
bg-pty watchdog "high confidence" — that was overstated. Runtime inspection on
2026-07-30 found a stronger candidate the original sweep never reached. See
[Runtime findings](#runtime-findings-2026-07-30--the-daemon-and-the-auth-window).
**Date of incident:** 2026-07-29 (three deaths, 01:21:57 / 01:36:05 / 01:39:36 local).
**Verdict:** upstream, not a sequant bug — sequant is the victim, not the killer.
Which upstream component is still open.

This directory exists because the investigation lived only in GitHub issue comments,
and `.sequant/` — where the raw evidence sat — is gitignored and rotates at 100 files.

---

## Summary

A nested phase `claude` that **hangs after finishing its turn** is terminated at
~106s (±1s) from spawn, and the termination takes down the entire process tree,
including the parent `sequant run`. A nested `claude` that exits cleanly is never
killed, at any lifetime (specimens survived 316s, 131.7s, 26m54s, 22m49s).

The killer is something that issues a **process-group** signal: the whole tree
dies together, and the run's own stdout records `Received SIGTERM` followed by a
truncated cleanup — a SIGTERM the process caught, then an escalation it did not
survive.

Two candidates, neither confirmed:

1. **The `[bg-pty]` host-dead watchdog** (below). Matches the discriminator
   exactly, but rests on binary strings rather than observed behaviour.
2. **The background daemon during its unauthenticated window** (see
   [Runtime findings](#runtime-findings-2026-07-30--the-daemon-and-the-auth-window)).
   Weaker mechanism detail, but it is the only condition separating all three
   victims from every survivor, and it is inducible on demand.

## Candidate 1 — the bg-pty watchdog

Background Bash tasks run under a detached helper
(`claude --bg-pty-host <sock> <cols> <rows> -- <cmd>`); a claude session is the
_client_ that connects to that socket. Extracted from the 2.1.220 binary
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
  killed at any lifetime. No other mechanism found _in the binary's strings_ keys
  on that state — but the sweep that concluded this never inspected the daemon,
  so "no other mechanism" was never established.
- **Simultaneous teardown + parent death.** It is a _process-group_ kill. Verified
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

| PID                   | lifetime | outcome                          |
| --------------------- | -------- | -------------------------------- |
| 21762                 | 107.08s  | KILLED (parent died 01:21:57)    |
| 33738                 | 106.23s  | KILLED (parent died 01:36:05)    |
| 40181                 | 105.41s  | KILLED (parent died 01:39:36)    |
| 17241                 | 316s     | exited normally — no blanket cap |
| outside-session phase | 131.7s   | clean exit, survived past 106s   |

Spread across the three deaths: **1.7s**.

Victims identified by transcript — all three, to the second:

| session    | project dir             | first entry   | last entry    | wall   | `run_in_background` calls |
| ---------- | ----------------------- | ------------- | ------------- | ------ | ------------------------- |
| `2b7de5d9` | worktrees/feature-848   | 06:20:10.848Z | 06:21:57.075Z | 106.2s | 1                         |
| `78565ed5` | Projects/sequant (main) | 06:34:20.059Z | 06:36:05.464Z | 105.4s | 0                         |
| `a5d0bda3` | Projects/sequant (main) | 06:37:52.232Z | 06:39:36.828Z | 104.6s | 0                         |

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
  outside-session run began 6 minutes _after_ the last death; no overlap.
- **Stale PID / lock reuse**, and the MCP group-kill at `src/mcp/tools/run.ts`
  (`detached: true` is set, so `kill(-pid)` targets a genuine group leader).

## AC-3 result — MCP shutdown does **not** cause the hang (measured)

Run 2026-07-30. Flipped exactly the variable `--no-mcp` flips — the Agent SDK's
`mcpServers` option (`drivers/claude-code.ts:118`, sourced from
`getMcpServersConfig()`) — holding prompt, cwd, settings and permission mode
constant. 3 reps per arm, alternating. Teardown measured as **last `TurnEnd` →
`SessionEnd`** per session from `.entire/logs/entire.log`.

| Arm     | MCP servers | Teardown gap        | Mean      | Wall clock |
| ------- | ----------- | ------------------- | --------- | ---------- |
| MCP ON  | 15          | 1.69s, 0.82s, 1.17s | **1.23s** | 25.0s      |
| MCP OFF | 0           | 1.23s, 1.52s, 1.54s | **1.43s** | 19.9s      |

**Conclusion:** MCP presence does not lengthen teardown — the MCP-off arm was
marginally _slower_, well inside noise. Both arms sit ~50× below the victim band
(58–96s) and within the same order as the 0.36s healthy baseline. MCP costs
~5s of **startup**, not teardown. This confirms AC-2's redirect by measurement
rather than by argument: the ~12 live MCP servers seen at each death were a
symptom of never reaching teardown, not its cause.

**Limits of this result, stated plainly:**

- n=3 per arm on a trivial prompt; no hang occurred in any run. It establishes
  that MCP presence alone does not produce a 58–96s gap. It cannot prove MCP is
  irrelevant _during_ a hang, because no hang was reproduced.
- These were direct SDK queries, not full `sequant run` phases. Same driver
  mechanism and same `mcpServers` option, but not the same surrounding process
  tree.

### Method validation

The measurement reproduces the original investigation's numbers from the same
log, which is why it can be trusted:

| Published gap | Reproduced | At death timestamp     |
| ------------- | ---------- | ---------------------- |
| 92.7s         | **92.71s** | 2026-07-29T01:39:36 ✅ |
| 58.0s         | **57.99s** | 2026-07-29T01:36:05 ✅ |

Note the metric is `TurnEnd → SessionEnd`, **not** `SessionStop → SessionEnd`.
`entire` records `SessionStop` as a session phase transition (`idle`/`active` →
`ended`), which pairs with `SessionEnd` for only 10 of 555 sessions and yields
nonsense multi-day gaps. The Claude Code Stop hook fires at end-of-assistant-turn,
which `entire` logs as `TurnEnd`.

### A long teardown alone does not get you killed

On 2026-07-29 there were **8** sessions with a 30–120s teardown gap. Two are
known victims (the 92.71s and 57.99s rows above). The other **6 survived**. So
the post-turn hang is necessary but not sufficient for the kill — consistent
with the bg-pty trigger depending on contended socket/adoption state rather than
on hang duration.

## Runtime findings 2026-07-30 — the daemon, and the auth window

The original sweep read the binary's strings and inferred a mechanism. Actually
watching the runtime changes the picture.

### Background tasks run under a transient daemon, not a bare bg-pty host

`CLAUDE_BG_BACKEND` is `"daemon"`. `~/.claude/daemon.log` shows the daemon
spawning bg-pty hosts as a **spare pool**:

```
[bg] bg: control socket bound at /tmp/cc-daemon-502/022955cc/control.sock
[bg] bg spare spawned host pid=33010
[bg] bg claimed-spare faf32d80 (spare)
```

So bg-pty hosts are real — but they exist only while the daemon does, and the
daemon is `origin=transient`:

```
[supervisor] idle 5s with no clients — exiting
[supervisor] shutting down (cause=idle_exit, uptime=64996s, leases=0, live_workers=0)
```

**This is why a naive check finds nothing.** Backgrounding a task with no daemon
running produces a plain child of the interactive `claude` in its own pgid — no
host, no socket. Any experiment that assumes a host is present will report a
false negative. Start the daemon first, then locate the spare host.

Note the pgid detail: the backgrounded task's shell is its **own** group leader,
separate from the interactive session's group. A group kill of that tree takes
out `sequant run` and its children while leaving the interactive session alive —
exactly the observed pattern (the spawning session, pid 70335, is still running).

### The daemon lost its auth token 17 minutes before the first death

The last daemon state change before the incident:

```
[2026-07-29T06:04:22.520Z] [supervisor] auth: proactive refresh starting
[2026-07-29T06:04:22.601Z] [supervisor] auth: proactive refresh failed, signalling re-auth required
[2026-07-29T06:04:22.628Z] [supervisor] auth: headless daemon cannot complete OAuth — run `claude auth login` to refresh
[2026-07-29T06:04:22.632Z] [supervisor] auth: no token found, will re-check keychain every 30s
```

| Event                   | UTC                 | Relative to auth loss |
| ----------------------- | ------------------- | --------------------- |
| daemon auth lost        | 06:04:22            | —                     |
| victim 1 started / died | 06:20:10 / 06:21:57 | +15.8 / +17.6 min     |
| victim 2 started / died | 06:34:20 / 06:36:05 | +30.0 / +31.7 min     |
| victim 3 started / died | 06:37:52 / 06:39:36 | +33.5 / +35.2 min     |

**All three victims started after the daemon lost its token, and no run has died
outside that window.** A phase `claude` whose supervising daemon cannot
authenticate is a plausible cause of both halves at once: an agent that finishes
its turn and then blocks on an auth-dependent teardown step, and a supervisor
that eventually tears the tree down.

This is a **correlation across three samples**, not a proven cause. It is stated
here because it is the strongest untested lead and — unlike the intermittent
hang — it is directly inducible.

Caveat: the daemon log contains no entry at any of the three death timestamps.
Whatever killed them did not log it there.

### Sharpened 2026-07-30: every death falls inside the daemon's auth-broken window

`~/.claude/daemon-auth-status.json` still reads, 33 hours later:

```json
{ "status": "auth_required", "since": 1785305062628 }
```

`since` = **2026-07-29T06:04:22.628Z** — the same instant as the daemon.log auth
failure, to the millisecond. Placing that against the rest of the timeline:

| Event                                         | UTC          |
| --------------------------------------------- | ------------ |
| daemon enters `auth_required`                 | **06:04:22** |
| death 1                                       | 06:21:57     |
| death 2                                       | 06:36:05     |
| death 3                                       | 06:39:36     |
| daemon idle-exits (`idle 5s with no clients`) | **09:48:23** |

**All three deaths fall inside `[auth lost … daemon exit]`, and none has occurred
in the 33 hours since the daemon went down.** That window is ~3.7 hours out of a
multi-day record — the three deaths landing inside it, and nothing outside it,
is a much tighter fit than "backgrounded launch" alone, which describes many
surviving runs too.

The candidate necessary conditions are therefore **both**:

1. the background daemon is **alive**, and
2. it is in **`auth_required`** state.

That also explains the intermittency without appeal to luck: the vulnerable
window opens when auth fails and closes when the daemon idle-exits. Outside it,
backgrounded tasks bypass the daemon entirely.

**Confirmed by direct observation**: with the daemon down (its current state), a
backgrounded task is a plain child of the interactive `claude` in its own pgid —
no daemon spawns, no bg-pty host exists, and no socket appears under
`/tmp/cc-daemon-502/`. Reproducing either candidate mechanism therefore requires
first getting the daemon back up, which the `auth_required` cooldown
(`~/.claude/daemon-auth-cooldown`) currently prevents.

**Falsifiable prediction:** restore auth, get the daemon running, then break its
auth again while it stays alive — deaths should resume. If a backgrounded run
dies with the daemon healthy, or survives indefinitely with the daemon alive and
unauthenticated, this hypothesis is wrong.

## What is still unproven (AC-1, AC-2)

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

### Step 0 — verify the capture rig, before anything else

`tools/verify-capture.sh`. The event is one-shot: it is rare, it destroys its
own process tree, and you do not get to ask it to happen again. A broken rig
produces an empty capture file, and an empty file is indistinguishable from
"nothing killed anything" — which is read as exoneration. **Every negative
result below is worthless until the instrument has been shown to fire on a
known positive.**

The script stages a sacrificial process group shaped like the real victim,
group-kills it with the same TERM→KILL escalation the incident showed, and
asserts the rig caught it — including that dtrace records **signal 9 as well
as 15**, that its fields are not blanked by SIP, and that **the rig outlives
the kill it is watching** (a watcher inside the victim's process group dies
with it and loses exactly the tail you needed).

Without `sudo` it reports **PARTIALLY verified**: the poller half is proven,
the sender-identification half is not.

### How to test this — three tiers, cheapest first

Ordered by cost, and each is worth running even if the next is skipped. Every
one produces a usable answer including when it comes back negative.

**Tier 1 — induce the auth window (cheapest, best lead, no sudo).**
The only condition that distinguishes every victim from every survivor is that
the daemon had no token. That is reproducible on demand:

1. Get the daemon running (start any backgrounded task) and confirm in
   `~/.claude/daemon.log`.
2. Invalidate its token — let a session sit until proactive refresh fails, or
   remove the keychain entry so the refresh path errors the same way. Confirm
   the `auth: no token found` line appears.
3. Launch `sequant run <issue>` **backgrounded from inside an interactive
   session**, with `tools/watch-signals.sh --no-dtrace` recording.
4. Watch for death at ~106s.

Positive → AC-1 and AC-2 both collapse to "unauthenticated daemon tears down its
background tree", and the fix is upstream plus a sequant-side pre-flight auth
check. Negative → the auth correlation is coincidence across three samples, which
is worth knowing before anyone builds on it.

**Tier 2 — induce the wedged host (deterministic, tests the bg-pty theory).**
`tools/induce-bgpty-hang.sh`. The watchdog's condition is "host pid alive but
socket won't accept", and `kill -STOP` produces exactly that — so the mechanism
can be tested without waiting for the intermittent trigger. **Requires the
daemon to be running first**, or there is no host to stop.

**Tier 3 — name the sender. Use the canary; dtrace is unavailable here.**

dtrace was the intended instrument and it is **confirmed dead on this machine**:

```
$ sudo dtrace -l -n 'proc:::signal-send'
dtrace: failed to match proc:::signal-send: System Integrity Protection is on
```

Not "restricted" — withheld. No D script can reach the probe, and disabling SIP
to debug this would be a bad trade.

Use `tools/signal-canary.c` instead. A handler installed with `SA_SIGINFO`
receives `siginfo_t.si_pid` — **the sending process** — and reading your own
signal's metadata needs no privileges at all. The canary execs the real command
as a child in the same process group, so a group-directed signal hits both, and
logs the sender before passing the signal through unchanged.

```sh
cc -O2 -Wall -o signal-canary signal-canary.c
./signal-canary /tmp/856-canary.log -- npx sequant run 123
```

Verified against both a direct and a **group-directed** SIGTERM; it names the
sender correctly in each. `verify-capture.sh` exercises this layer, so the rig
now reaches 5/5 with no sudo.

This works **because the incident's first signal is catchable** — the recovered
stdout shows `Received SIGTERM` before the truncated cleanup. The SIGKILL that
follows remains unobservable by any in-process means, but it comes from the same
actor, so identifying the TERM sender identifies the killer.

Resolve the logged PID promptly (`ps -p <pid> -o pid,ppid,pgid,command`) — the
sender may exit shortly after.

Two things make this cheaper than it was. First, the run's own stdout at
`tasks/b6byn5iih.output` shows `Received SIGTERM` — the first signal is
**catchable**, so it is observable without kernel tracing. Second, the sequence
recorded there ends after `✓ Aborted 1 active phase` with no cleanup task
reported, which is the SIGTERM→SIGKILL escalation caught in the act.

### Remaining repro matrix

With MCP eliminated (AC-3 above), the remaining axes are:

{daemon authed vs unauthed} × {backgrounded vs foreground launch} × {concurrent same-cwd session vs none}

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
_misreporting_ the aftermath, and recover from the debris:

| Change                                                                              | File                                 |
| ----------------------------------------------------------------------------------- | ------------------------------------ |
| Terminated run exits `128+signum`, prints the cause, and names this doc for SIGTERM | `src/lib/shutdown.ts`                |
| In-flight issues are logged as aborted with their cause instead of `success`        | `src/lib/workflow/log-writer.ts`     |
| Zero completed phases is a `failure`, not a pass                                    | `src/lib/workflow/run-log-schema.ts` |
| `sequant logs` renders an aborted run as `ABORTED` with the signal                  | `src/commands/logs.ts`               |
| Locks leaked by a SIGKILLed run self-clear after 24h instead of blocking forever    | `src/lib/locks/lock-manager.ts`      |
