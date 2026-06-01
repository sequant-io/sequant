# Concurrency & Per-Issue Locks

Sequant prevents two sessions from working on the same GitHub issue at the
same time. When `sequant run` starts, each issue claims a per-issue lock at
`.sequant/locks/<issue>.lock` containing the holder's PID, hostname, start
time, and command. A second session attempting the same issue is skipped
with a clear error and the rest of the batch continues.

## Stale recovery

Locks are auto-cleared in three situations:

1. Same host, PID no longer alive → cleared immediately (covers SIGKILL and
   crashes).
2. Cross-host, lock older than 2 hours → cleared by age.
3. Manual: `sequant locks clear <issue>` (with safety check by default).

## Taking over an active session

`sequant run --force <issue>` writes a new lock claiming the issue. Add
`--signal-other` to also SIGTERM the prior PID (same host, alive only). Plain
`--force` does not signal — use it when you already know the other session is
dead.

## Inspecting locks

```bash
npx sequant locks list                # Show every active lock
npx sequant locks clear 123           # Clear lock for #123 (refuses fresh)
npx sequant locks clear 123 --force   # Clear unconditionally
```

## Skill wiring (`/fullsolve`, `/assess`)

The `/fullsolve` skill claims the lock at Phase 0.3, releases it at Phase 5.5,
AND releases on every halt branch (spec failure, exec exhausted, etc.) so an
aborted run frees the lock immediately. `/assess` probes it read-only and
surfaces a dashboard warning when any issue is in use. Both use these
subcommands directly from bash:

```bash
npx sequant locks acquire 123 --command="/fullsolve 123" --skip-pid-check
npx sequant locks release 123                    # idempotent; safe on every error path
npx sequant locks check   123 --json             # exit 1 when held, prints holder JSON
npx sequant locks check-batch 100 101 102        # /assess: emits ⚠ lines for held issues only
```

`--skip-pid-check` is required for skill shells: the Node process that runs
`locks acquire` exits immediately, so its PID is dead before the lock is
released. With the flag set, stale detection falls back to age-only on the
holder's own host. The default skill-lock TTL is **6h** (separate from the
2h cross-host TTL) — long enough to cover virtually every `/fullsolve` run
including multi-iteration QA loops. Override per-process via
`SEQUANT_SKILL_LOCK_TTL_MS=<milliseconds>`.

A skill that crashes mid-run leaves at most a 6h orphan; clear it manually
with `sequant locks clear <issue>` to recover sooner. The skill's explicit
release calls on every halt branch (see `.claude/skills/fullsolve/SKILL.md`
Phase 0.3 release contract) mean this corner case should be rare in practice.

## Read-only commands

`status`, `merge`, and `/assess` warn when an issue is locked but do not
block.

## MCP / orchestrator mode

When the `SEQUANT_ORCHESTRATOR` env var is set (in-process or remote
MCP-driven runs), all lock operations are no-ops — the orchestrator caller is
responsible for any coordination.

## Caveats

The lock relies on `open(O_CREAT | O_EXCL)` and is reliable on local
filesystems. NFS and other network filesystems may not honor those semantics;
users on networked repos may see false positives. The `SEQUANT_LOCKS_DIR` env
var overrides the lock directory (used in tests and unusual layouts).
