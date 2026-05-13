# Per-Issue Concurrency Locks

Prevents two sequant sessions from working on the same GitHub issue at the same time. Lock files live at `.sequant/locks/<issue>.lock`; the lock is acquired automatically when you run `sequant run` (or `/fullsolve`, chain mode) and released when the run ends.

You don't normally see this feature — it just blocks the second session with a clear error. The commands below are for when something goes wrong (a crashed prior session left a stale lock, or you genuinely want to take over).

## Prerequisites

1. **sequant installed** — `sequant --version`
2. **Local filesystem repo** — locks use `open(O_CREAT | O_EXCL)` on `.sequant/locks/`; **not safe on NFS / networked filesystems** (false positives possible).

## What Triggers a Lock

| Command | Acquires lock | Notes |
|---|---|---|
| `sequant run <issue>` | yes | One lock per issue in the run |
| `sequant fullsolve <issue>` | yes | Inherited via the parent process |
| Chain mode | yes | Per-issue, as each issue starts |
| `sequant assess`, `sequant merge`, `sequant status` | no | Read-only; checks lock and warns, then proceeds |
| MCP / orchestrator runs (`SEQUANT_ORCHESTRATOR=1`) | no | Lock filesystem is bypassed entirely |
| Sub-skills (`/spec`, `/exec`, `/qa`, `/loop`, `/testgen`) | no | Inherit the parent's lock |

## What You See When Blocked

When you try to run an issue another session already holds:

```
Issue #604 is being worked on by PID 12345 since 2026-05-10T14:32:00Z
(npx sequant fullsolve 604). Use --force to take over, or wait for
the other session.
```

In a batch run, locked issues are skipped and the rest continue. The summary table shows the lock holder:

```
SUMMARY · 3 issues · 8m 12s · 2 passed · 1 locked

  #608     ✔ passed     spec → exec → qa · PR #623
  #614     ✔ passed     exec → qa · PR #615
  #604     ⚠ locked     by PID 12345 (npx sequant fullsolve 604)
```

The batch only fails (non-zero exit) when *every* issue is locked.

## Stale Lock Recovery

The lock detects abandoned holders automatically before blocking:

1. **Same host, dead PID** (`process.kill(pid, 0)` fails) → cleared immediately.
2. **Same host, alive PID** → genuine collision; you're blocked.
3. **Cross-host or unknown PID** → blocked until the lock is older than **2 hours**, then cleared.

So a `Ctrl+C` or `SIGTERM` on a sequant run normally releases the lock via `ShutdownManager`. A hard `SIGKILL` leaves the file behind, but the next run on the same host auto-clears it.

## Taking Over a Lock

When you know the other session is dead and you don't want to wait:

### Pass `--force` to `sequant run`

```bash
npx sequant run 604 --force
```

This writes a new lock claiming the issue. **It does not signal the prior process** — use only when you know the other session is dead. `--force` here serves double duty (state-guard bypass + lock takeover).

### `--force --signal-other` — SIGTERM the prior holder first

```bash
npx sequant run 604 --force --signal-other
```

When the prior holder is on the same host AND alive, SIGTERMs it before taking the lock. Cross-host or already-dead holders fall back to a plain force takeover.

### Manual clear via `sequant locks`

For inspection or surgical recovery without launching a run:

```bash
# See every active lock
npx sequant locks list

# Safety-checked clear (refuses if same-host alive)
npx sequant locks clear 604

# Force clear (bypass safety check)
npx sequant locks clear 604 --force
```

## What to Expect

- **Auto-acquired and auto-released.** You don't call the lock commands during normal use.
- **`Ctrl+C` releases.** `ShutdownManager` cleans the lock on SIGINT/SIGTERM. Crash recovery handles SIGKILL via PID check on the next run.
- **MCP runs are unaffected.** With `SEQUANT_ORCHESTRATOR=1` set, no `.sequant/locks/` files are created and no checks run. Orchestrator callers coordinate themselves.
- **NFS is unreliable.** If your repo lives on a network filesystem, `O_CREAT | O_EXCL` may report false collisions. Move the repo to local disk if you hit phantom locks.

## `sequant locks` Reference

| Subcommand | Use |
|---|---|
| `locks list` | Show all active locks with PID, host, age, and command. `--json` available. |
| `locks clear <issue>` | Manually clear a lock. Refuses to clear a same-host alive lock unless `--force`. |
| `locks acquire <issue>` | Claim a lock (used internally by skill shells). `--force` and `--signal-other` available. |
| `locks release <issue>` | Release a lock previously acquired by the current process. |
| `locks check <issue>` | Read-only: print holder if held, exit 1 when held. Used by `/assess`. |
| `locks check-batch <issues...>` | Read-only batch probe; emits canonical `⚠ locked by …` lines for held issues. |

Every subcommand accepts `--json` for scripting.

| Run-level flag | Effect |
|---|---|
| `sequant run … --force` | Take over the lock; also bypasses the completed-issue state guard. |
| `sequant run … --force --signal-other` | SIGTERM the prior same-host holder before taking over. |

## Environment

| Variable | Effect |
|---|---|
| `SEQUANT_ORCHESTRATOR=1` | All lock operations become no-ops. MCP-driven runs bypass the lock filesystem. |
| `SEQUANT_LOCKS_DIR=<path>` | Override `.sequant/locks/` location (used by tests; rarely useful elsewhere). |

## Troubleshooting

### "Issue #N is being worked on by PID …" but I closed that terminal

**Cause:** The prior session exited without releasing — usually a SIGKILL or crash.

**Fix:** Re-run; the same-host PID check auto-clears the stale lock on the next attempt. If it persists, run `npx sequant locks clear <issue>`.

### Lock won't clear even though the PID is gone

**Cause:** The lock was created on a different hostname, so the same-host PID check is skipped. The 2-hour age fallback applies.

**Fix:** `npx sequant locks clear <issue> --force`, or wait for the 2h age to expire.

### Two runs on different machines both think they hold the lock

**Cause:** Repo is on a network filesystem; `O_CREAT | O_EXCL` is not atomic on NFS.

**Fix:** Move the repo to a local disk. Networked filesystems are explicitly unsupported.

### I want `/assess` to refuse to run when an issue is locked

**Cause:** `/assess` is read-only by design and only warns. This is intentional — you can still inspect a locked issue.

**Fix:** Wrap the call: `npx sequant locks check <issue> && npx sequant assess <issue>`.

---

*Documents issue #625 (per-issue concurrency lock).*
