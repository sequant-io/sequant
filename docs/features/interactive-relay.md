# Interactive Relay

Send messages into a running `sequant run` session and receive replies, without killing the run. Use it when a phase is taking longer than expected, when you want to nudge the agent toward a different approach, or when you want to abort gracefully.

## Prerequisites

1. **A running `sequant run` session** — relay only attaches to active runs. Verify with `npx sequant status`.
2. **Relay enabled on that run** — relay is on by default. It is only off if the run was started with `--no-relay` or if `settings.run.relay` is `false`.

## Setup

No setup required. Every `sequant run` starts the relay automatically unless you opt out:

```bash
# Default — relay is on
npx sequant run 368

# Opt out at run start
npx sequant run 368 --no-relay
```

To turn relay off project-wide, set `run.relay: false` in `.sequant/config.json`. To turn it off for a single run, pass `--no-relay`.

## What You Can Do

Open a second terminal alongside your `sequant run`. The two commands below operate on the relay files inside the run's worktree.

### Ask for a status update

```bash
npx sequant prompt 368 "what's taking so long?"
```

The agent receives the message after its next tool call, replies in the outbox, and continues its current work. Use this when a phase looks idle and you want a quick read-out.

### Suggest a course adjustment

```bash
npx sequant prompt 368 --type directive "skip the migration tests for now"
```

`directive` messages tell the agent to consider adjusting its approach. The agent may or may not act on the suggestion — directives cannot override acceptance criteria, change the phase, or abandon the current objective. They are nudges, not commands.

### Stop the run gracefully

```bash
npx sequant prompt 368 --type abort
```

The agent finishes its current tool call, commits any in-progress work, and exits the phase. Use this instead of `Ctrl+C` when you want a clean shutdown that preserves progress.

### Watch replies stream in

```bash
npx sequant watch 368
```

Tails the outbox and prints each new reply as it arrives. `Ctrl+C` stops watching without affecting the run.

### Omit the issue number when only one run is active

```bash
# Equivalent to `prompt 368 "..."` if #368 is the only active run
npx sequant prompt "ping?"
```

If two or more runs are active, `prompt` will list them and ask you to specify which.

## What to Expect

- **Reply latency is per-tool-call, not real-time.** The relay surfaces your message after the agent's next tool call. During a fast loop (file edits, small commands) that's seconds. Inside a single long-running command (a 5-minute test suite, a long compile), nothing fires until that command returns.
- **Replies are brief by design.** The framing wrapper tells the agent to acknowledge and continue — not to start a conversation. Treat replies as status pings, not chat.
- **Directives are advisory.** The agent may decline directives that conflict with acceptance criteria. This is intentional — relay cannot move the goalposts.
- **Output location:** live replies go to your terminal via `sequant watch`. After the phase ends, full inbox/outbox transcripts are archived to `.sequant/logs/relay/<issue>-<phase>-<timestamp>/` for post-run review.

## Command Reference

### `sequant prompt`

```
sequant prompt [<issue>] "<message>" [--type <type>] [--json]
```

| Argument / Flag | Required | Default | Description |
|-----------------|----------|---------|-------------|
| `<issue>` | No (auto-resolves single active run) | — | Issue number of a running session |
| `<message>` | Yes | — | The message to send (quote it to avoid shell parsing) |
| `--type` | No | `query` | One of `query`, `directive`, `abort` |
| `--json` | No | `false` | Emit confirmation as JSON |

### `sequant watch`

```
sequant watch <issue> [--json]
```

| Argument / Flag | Required | Default | Description |
|-----------------|----------|---------|-------------|
| `<issue>` | Yes | — | Issue number to tail replies for |
| `--json` | No | `false` | Emit each reply as a JSON line |

### `sequant run --no-relay`

Disables the relay for that run. The `prompt` and `watch` commands cannot reach a `--no-relay` session.

### `sequant status`

Includes a `Relay` column showing `✓` for runs with relay enabled and `-` otherwise.

## Message Types

| Type | Use when | Effect |
|------|----------|--------|
| `query` | You want a status update | Brief acknowledgment, no behavior change |
| `directive` | You want a course adjustment | Advisory — agent may adjust if compatible with the AC |
| `abort` | You want a clean stop | Graceful shutdown after current tool call, commits progress |

## Troubleshooting

### "Run for #N is no longer active (process exited)"

The session's process is gone (completed, crashed, or `Ctrl+C`'d). The stale pidfile is cleaned up automatically. Start a new `sequant run` to relay into it.

### "Multiple active runs: #A, #B. Specify an issue number."

Auto-resolve only works with a single active run. Pass the issue number explicitly: `sequant prompt 368 "..."`.

### My message was sent but the agent isn't responding

Three likely causes:

1. **The agent is inside a long-running tool call.** Wait for it to return — the relay hook fires on tool-call boundaries.
2. **The run uses `--no-relay`.** Check `sequant status` — the `Relay` column will show `-`. Restart without `--no-relay` to re-enable.
3. **The message conflicts with acceptance criteria.** The agent may acknowledge in the outbox but decline to act. Run `sequant watch <issue>` to see the reply.

### The relay didn't archive after the phase finished

Check `.sequant/logs/relay/` in the worktree (or main repo for `spec` phase). Each phase creates a `<issue>-<phase>-<timestamp>/` directory with `inbox.jsonl`, `outbox.jsonl`, and `meta.json`. If you don't see it, the phase may have been killed before teardown ran (`SIGKILL`, OOM); the live files in `.sequant/relay/` will still be there.

### Replies look truncated or out of order

The outbox is JSONL, one reply per line, append-only. `sequant watch` reads with `fs.watch` and falls back to polling on NFS / some WSL setups. If you suspect a watcher issue, `cat .sequant/relay/outbox.jsonl` to see the raw stream.

## Related

- Issue [#383](https://github.com/admarble/sequant/issues/383) — feature design and acceptance criteria
- `docs/features/concurrency-locks.md` — relay is per-issue, scoped to the same lock that prevents concurrent runs on one issue
- `docs/features/run-renderer.md` — the live renderer that displays the run you're prompting into

---

*Generated for Issue #383 on 2026-05-13*
