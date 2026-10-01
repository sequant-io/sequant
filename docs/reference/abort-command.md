# Abort Command

`sequant abort` stops a running `sequant run` from another terminal. Use it when the run is headless (started from a script, cron, the MCP server, or a terminal you no longer have), or when it has stopped responding to `sequant prompt`.

```bash
sequant abort 42          # stop the run working on issue #42
sequant abort             # stop the only active run (fails if there are several)
```

## What it does

The command finds the run's process ID and signals it directly, escalating until the process exits:

1. **SIGINT**, then waits up to the grace period (10 seconds by default). This is the same as pressing Ctrl-C in the run's terminal: the run's normal shutdown cleanup runs.
2. **SIGTERM** if the run is still alive, then waits 3 seconds.
3. **SIGKILL** if it is still alive, then waits 2 seconds. SIGKILL skips all cleanup, so check `sequant status` afterwards.

On success it prints `Aborted #42 (PID 12345, SIGINT).`, naming the signal that stopped the run.

## Options

| Option | Effect |
|--------|--------|
| `[issue]` | Issue number to stop. Optional when exactly one run is active. |
| `--grace <seconds>` | How long to wait after SIGINT before escalating. Default `10`; `0` escalates at once. |
| `--force` | Skip SIGINT and start at SIGTERM. |
| `--json` | Print one JSON object: `{"ok": true, "issue": 42, "pid": 12345, "signal": "SIGINT"}`. |

## Exit codes and messages

| Message | Exit code | Meaning |
|---------|-----------|---------|
| `Aborted #42 (PID …, SIGINT).` | 0 | The run stopped. |
| `PID … for #42 is already dead.` | 0 | Nothing to stop; the run had already exited. |
| `No relay PID found for #42. Is the run active?` | 1 | No running process is recorded for that issue. See below. |
| `Failed to abort #42: PID … still alive after SIGKILL.` | 1 | The process survived every signal. Stop it with your OS tools. |

## When it can't find the run

`abort` reads the process ID that the run's relay records when an issue starts. The relay is on by default. If the run was started with `--no-relay`, or with `"run": { "relay": false }` in `.sequant/settings.json`, no ID is recorded and `abort` reports `No relay PID found`. In that case stop the run with Ctrl-C in its terminal, or find the process with `ps` and send it SIGINT yourself.

## After an abort

- `sequant status` shows where each issue stopped.
- The issue's branch is always kept. Its worktree is kept if it has uncommitted changes, commits not yet on the base branch, or a phase that was still running; otherwise the shutdown removes it and the branch is all that remains. The run logs which case applied (`Worktree for #42 preserved (…)` or `removed (clean)`).
- After SIGKILL no cleanup runs, so the worktree is left exactly as it was.
- To continue, run the issue again with `sequant run 42`. For runs that stopped on a rate limit rather than an abort, see [Halt and Resume](halt-and-resume.md).

## Related

- `sequant prompt <issue> --type abort` asks the running agent to stop by itself, through the relay inbox. Prefer it when the run is healthy; `abort` is for when it isn't.
- [Run Command](run-command.md)
- [State Command](state-command.md)
