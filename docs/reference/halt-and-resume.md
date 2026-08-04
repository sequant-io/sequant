# Halt and resume (durable rate-limit recovery)

When a run fails on an exhausted subscription rate-limit window (`five_hour` /
`seven_day`, see #860), Sequant has two recovery shapes:

| | `--auto-wait` (#804) | Halt-and-resume (#892) |
|---|---|---|
| Mechanism | Live process sleeps until the window reopens | Process exits cleanly; `sequant resume` re-enters later |
| Per-issue lock | Held for the whole wait | **Released at halt** |
| Survives reboot / power loss | No — the run is lost | **Yes** — state carries `resumeAt` |
| Context | Preserved in memory | Re-derived on re-entry (completed phases/issues skipped) |
| Infrastructure | None | One cron/launchd entry (recipe below) |
| Best for | Attended / overnight-laptop runs | Unattended machines, schedulers |

Both use the same window classification and the same wake clock
(`resetsAt` + a ~60 s buffer). They compose: an exhausted `--auto-wait` budget
still writes the halt record, so a scheduler can pick up where the in-process
wait gave up.

## How it works

1. **Halt.** A phase fails on a waitable window. The run writes
   `windowHalt: { resumeAt, phase, reentries }` to `.sequant/state.json`,
   surfaces today's labeled failure (`Rate limited — resets at …`), and exits.
   The per-issue lock is released on exit, so nothing blocks the issue while
   the window is closed — a reboot between halt and re-entry loses nothing.
2. **Re-entry.** `sequant resume` reads state:
   - **Before `resumeAt`:** prints when the issue becomes resumable and exits
     `0`. Safe to invoke as often as you like.
   - **After `resumeAt`:** consumes one re-entry (bounded, see below) and
     re-runs the halted issues through the normal `sequant run` path with
     `--resume` semantics — completed phases (GitHub markers) and completed
     issues (#837) are skipped, and the per-issue lock is re-acquired normally.
3. **Clearing.** Any phase success — or a failure whose cause is *not* a
   waitable window — clears the record, so `resume` never re-enters on a stale
   or non-waitable halt.

`sequant status` shows halted issues as
`⏸ Halted: <phase> hit a rate-limit window — resumable at <time>`.

## Usage

```bash
npx sequant resume            # re-enter every halted issue that is due
npx sequant resume 42 57      # restrict to specific issues
npx sequant resume --dry-run  # show the plan without consuming a re-entry
```

Exit codes: `0` when there is nothing to do (nothing halted, not yet due, or
every due issue is locked by another session); the delegated run's exit code
once a re-entry starts; `1` when the only halted issues have exhausted their
re-entry bound.

A due issue whose per-issue lock is held by another session is skipped
**without consuming a re-entry** — someone is already working on it, and the
run path would skip it anyway. The next scheduler tick retries normally.

## Re-entry bound

Re-entries are bounded at **2 per halted issue** (mirroring `--auto-wait`'s
per-issue wait bound). A window that never reopens therefore cannot ping-pong
a scheduler: the third attempt halts with the labeled terminal message and
exit code `1`, and the issue waits for a human (`sequant run <issue> --resume`
re-enters manually). Progress resets the bound — any phase success clears the
halt record, counter included.

## Scheduler recipe

<!-- recipe:start -->
### cron

Every 15 minutes; before `resumeAt` each tick is a no-op:

```cron
*/15 * * * * cd /path/to/your/project && npx sequant resume >> .sequant/logs/resume-cron.log 2>&1
```

### launchd (macOS)

Save as `~/Library/LaunchAgents/io.sequant.resume.plist`, then load with
`launchctl load ~/Library/LaunchAgents/io.sequant.resume.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.sequant.resume</string>
  <key>WorkingDirectory</key><string>/path/to/your/project</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>npx sequant resume >> .sequant/logs/resume-launchd.log 2>&1</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
</dict>
</plist>
```

Unload with `launchctl unload ~/Library/LaunchAgents/io.sequant.resume.plist`
once the run completes. No daemon ships inside sequant — the scheduler entry
is the whole integration.
<!-- recipe:end -->

## References

- Decision record: [auto-wait-vs-halt-resume-860.md](../investigations/auto-wait-vs-halt-resume-860.md)
- [`--auto-wait`](run-command.md#auto-wait-for-a-rate-limit-window) — the
  in-process alternative
- #892 (this feature), #860 (window classification), #837 (completed-issue
  skipping), #856 (stale-lock hazard the halt removes), #799 (billing
  fail-fast)
