# Concurrency & Per-Issue Locks

Sequant prevents two sessions from working on the same GitHub issue at the
same time. When `sequant run` starts, each issue claims a per-issue lock at
`.sequant/locks/<issue>.lock` containing the holder's PID, hostname, start
time, and command. A second session attempting the same issue is skipped
with a clear error and the rest of the batch continues.

## Stale recovery

Locks are auto-cleared in four situations:

1. **Any lock older than 24 hours** → cleared unconditionally (#856). This is
   checked first and does not care about host, PID liveness, or
   `--skip-pid-check`. Rule 2 treats a live PID as proof that the lock is
   held, but a PID is only stable identity while its process lives — once the
   OS recycles it, an abandoned lock points at an unrelated process and reads
   as held forever. (Observed: `505.lock` from 2026-05-14 blocked #505 for 76
   days.) It is also the only recovery path for a lock leaked by a SIGKILLed
   run, where no in-process release handler can fire. 24h is ~48× the
   30-minute phase timeout and 4× the skill-lock TTL, so no real run reaches
   it. Override with `SEQUANT_MAX_LOCK_AGE_MS=<milliseconds>`.
2. Same host, PID no longer alive → cleared immediately (covers SIGKILL and
   crashes).
3. Cross-host, lock older than 2 hours → cleared by age.
4. Manual: `sequant locks clear <issue>` (with safety check by default).

## Taking over an active session

`sequant run --force <issue>` writes a new lock claiming the issue. Add
`--signal-other` to also SIGTERM the prior PID (same host, alive only). Plain
`--force` does not signal — use it when you already know the other session is
dead.

`--signal-other` refuses to signal a holder past the 24h ceiling
(`stale-pid-untrusted`, #856). At that age the recorded PID is not reliable
identity, and the liveness probe cannot tell the difference: a recycled PID
_is_ alive — it just belongs to someone else's program. Signalling it would
SIGTERM an unrelated process on behalf of a lock nobody holds.

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

The 24h ceiling above bounds this too: even a skill lock whose PID is somehow
alive is released after 24h regardless.

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
