/**
 * `sequant locks` — inspect and clear per-issue concurrency locks (#625) and
 * the checkout-scoped lock (#901).
 */

import chalk from "chalk";
import {
  CheckoutLock,
  LockManager,
  describeCheckoutHolderIssue,
  formatCheckoutLockedMessage,
  formatLockedMessage,
  type LockFile,
  type SignalOtherResult,
} from "../lib/locks/index.js";

/** Human-readable line for the `--signal-other` log output (#637). */
function formatSignalLine(
  issue: number,
  pid: number,
  result: SignalOtherResult,
): string {
  switch (result.reason) {
    case "sent":
      return `Signaled PID ${pid} (SIGTERM) for #${issue}`;
    case "cross-host":
      return `Could not signal PID ${pid} for #${issue} (cross-host holder)`;
    case "self-or-parent":
      return `Refused to signal PID ${pid} for #${issue} (matches this process or its parent)`;
    case "pid-dead":
      return `Could not signal PID ${pid} for #${issue} (already exited)`;
    case "stale-pid-untrusted":
      return `Refused to signal PID ${pid} for #${issue} (lock is past the age ceiling; that PID has likely been recycled onto an unrelated process)`;
    case "kill-failed":
      return `Could not signal PID ${pid} for #${issue} (kill syscall failed)`;
    case "orchestrator":
      return `Skipped signal for #${issue} (orchestrator mode)`;
  }
}

export interface LocksListOptions {
  json?: boolean;
}

export interface LocksClearOptions {
  force?: boolean;
  json?: boolean;
}

export interface LocksAcquireOptions {
  command?: string;
  skipPidCheck?: boolean;
  force?: boolean;
  signalOther?: boolean;
  json?: boolean;
}

export interface LocksReleaseOptions {
  json?: boolean;
}

export interface LocksCheckOptions {
  json?: boolean;
}

export interface LocksCheckBatchOptions {
  json?: boolean;
}

function parseIssue(arg: string): number | null {
  const issue = Number.parseInt(arg, 10);
  if (!Number.isInteger(issue) || issue <= 0) {
    console.error(chalk.red(`Invalid issue number: ${arg}`));
    process.exitCode = 1;
    return null;
  }
  return issue;
}

/** `sequant locks list` — print every active lock with staleness metadata. */
export async function locksListCommand(
  options: LocksListOptions = {},
): Promise<void> {
  const manager = new LockManager();
  if (manager.isNoop) {
    if (options.json) {
      console.log(JSON.stringify({ locks: [], orchestratorMode: true }));
    } else {
      console.log(
        chalk.gray("Lock operations are disabled (SEQUANT_ORCHESTRATOR set)."),
      );
    }
    return;
  }

  const listings = manager.list();
  // The checkout lock lives in the same directory but is deliberately not a
  // numeric filename, so `manager.list()` skips it (#901). Query it separately
  // rather than widening the numeric key everywhere.
  const checkout = new CheckoutLock().listing();

  if (options.json) {
    console.log(JSON.stringify({ locks: listings, checkout }, null, 2));
    return;
  }

  if (listings.length === 0 && !checkout) {
    console.log(chalk.gray("No active locks."));
    return;
  }

  if (checkout) {
    const ageMinutes = Math.floor(checkout.ageMs / 60_000);
    const staleTag = checkout.stale
      ? chalk.yellow(`  (stale: ${checkout.staleReason})`)
      : "";
    console.log(chalk.bold("Checkout lock (whole working tree):"));
    console.log(
      `  issue=${describeCheckoutHolderIssue(checkout.holder.issue)}  ` +
        `pid=${checkout.holder.pid}  ` +
        `host=${checkout.holder.hostname}  age=${ageMinutes}m  ` +
        `started=${checkout.holder.startedAt}${staleTag}`,
    );
    console.log(`    command: ${checkout.holder.command}`);
    console.log("");
  }

  if (listings.length === 0) {
    console.log(chalk.gray("No active per-issue locks."));
    return;
  }

  console.log(chalk.bold(`Active locks (${listings.length}):`));
  console.log("");
  for (const l of listings) {
    const ageMinutes = Math.floor(l.ageMs / 60_000);
    const staleTag = l.stale ? chalk.yellow(`  (stale: ${l.staleReason})`) : "";
    console.log(
      `  #${l.issue}  pid=${l.holder.pid}  host=${l.holder.hostname}  ` +
        `age=${ageMinutes}m  started=${l.holder.startedAt}${staleTag}`,
    );
    console.log(`    command: ${l.holder.command}`);
  }
}

export interface LocksCheckoutOptions {
  issue?: string;
  command?: string;
  sessionId?: string;
  skipPidCheck?: boolean;
  force?: boolean;
  json?: boolean;
}

/**
 * Validate `--issue` for the checkout commands. Shared by `acquire` (where the
 * flag is required) and `release` (where it is optional) so the two cannot
 * drift on what counts as a valid issue.
 *
 * `Number.parseInt` + `Number.isInteger`, never a bare `Number(x)`:
 * `Number(undefined)` is `NaN`, and `NaN !== undefined`, so a `NaN` would sail
 * through the `issue !== undefined` guard in `isCheckoutOwner` and silently
 * refuse every release instead of erroring here (#906).
 */
function parseCheckoutIssue(
  raw: string,
): { ok: true; issue: number } | { ok: false } {
  const issue = Number.parseInt(raw, 10);
  if (!Number.isInteger(issue) || issue <= 0) {
    console.error(chalk.red(`Invalid issue number: ${raw}`));
    process.exitCode = 2;
    return { ok: false };
  }
  return { ok: true, issue };
}

/**
 * `sequant locks checkout <acquire|release|check|clear>` — the working-tree
 * lock (#901).
 *
 * Exit codes mirror the per-issue commands:
 *   0 — success (acquired / released / free / cleared / nothing to release)
 *   1 — held by another session, or refused
 *   2 — invalid arguments
 */
export async function locksCheckoutCommand(
  action: string,
  options: LocksCheckoutOptions = {},
): Promise<void> {
  const lock = new CheckoutLock();

  if (lock.isNoop) {
    // AC-5: orchestrator/MCP mode is a no-op across the whole surface.
    if (options.json) {
      console.log(JSON.stringify({ action, orchestratorMode: true, ok: true }));
    } else {
      console.log(
        chalk.gray("Lock operations are disabled (SEQUANT_ORCHESTRATOR set)."),
      );
    }
    return;
  }

  switch (action) {
    case "acquire": {
      if (options.issue === undefined) {
        console.error(chalk.red("`locks checkout acquire` requires --issue"));
        process.exitCode = 2;
        return;
      }
      const parsed = parseCheckoutIssue(options.issue);
      if (!parsed.ok) return;
      const issue = parsed.issue;

      const result = lock.acquire(issue, options.command ?? "unknown", {
        sessionId: options.sessionId,
        skipPidCheck: options.skipPidCheck,
      });

      if (result.acquired) {
        if (options.json) {
          console.log(
            JSON.stringify({
              acquired: true,
              reentrant: result.reentrant,
              lockPath: result.lockPath,
            }),
          );
        } else {
          console.log(
            chalk.green(
              result.reentrant
                ? `✓ Checkout already held by this session (#${issue})`
                : `✓ Acquired checkout lock for #${issue}`,
            ),
          );
        }
        return;
      }

      process.exitCode = 1;
      if (options.json) {
        console.log(
          JSON.stringify({
            acquired: false,
            holder: result.holder,
            lockPath: result.lockPath,
          }),
        );
      } else {
        console.error(
          chalk.yellow(formatCheckoutLockedMessage(result.holder, { issue })),
        );
      }
      return;
    }

    case "release": {
      // `--issue` is optional here, unlike `acquire`: a live process releasing
      // its own lock is identified by PID. It is required in practice for
      // skill shells, whose PID is already gone — see `isCheckoutOwner`.
      let issue: number | undefined;
      if (options.issue !== undefined) {
        const parsed = parseCheckoutIssue(options.issue);
        if (!parsed.ok) return;
        issue = parsed.issue;
      }

      // Read the holder *before* releasing, so a refusal can name it.
      const holder = lock.check();
      const released = lock.release({
        sessionId: options.sessionId,
        ...lock.selfIdentity,
        issue,
      });

      // Three outcomes, not two (#906). Before ownership was enforced,
      // "released nothing" could only mean "nothing was held". It now also
      // means "held, but not by you" — a real refusal, which must not print
      // the same gray no-op line or exit 0.
      if (options.json) {
        console.log(
          JSON.stringify({
            released,
            refused: !released && holder !== null,
            ...(holder ? { holder } : {}),
          }),
        );
        if (!released && holder) process.exitCode = 1;
        return;
      }

      if (released) {
        console.log(chalk.green("✓ Released checkout lock"));
        return;
      }

      if (holder) {
        process.exitCode = 1;
        console.error(
          chalk.yellow(
            `Refusing to release the checkout lock — it belongs to the session working ${describeCheckoutHolderIssue(holder.issue)} ` +
              `(PID ${holder.pid} on ${holder.hostname}, started ${holder.startedAt}).\n` +
              (issue === undefined
                ? `You passed no --issue, so nothing identified you as the holder.\n` +
                  `  • If you are that session: sequant locks checkout release --issue=${holder.issue}\n`
                : `You passed --issue=${issue}.\n`) +
              `  • If that session is gone: sequant locks checkout clear --force`,
          ),
        );
        return;
      }

      console.log(chalk.gray("No releasable checkout lock"));
      return;
    }

    case "check": {
      const holder = lock.check();
      if (!holder) {
        if (options.json) {
          console.log(JSON.stringify({ locked: false }));
        } else {
          console.log(chalk.gray("Checkout is not locked"));
        }
        return;
      }
      process.exitCode = 1;
      if (options.json) {
        console.log(JSON.stringify({ locked: true, holder }));
      } else {
        console.log(chalk.yellow(formatCheckoutLockedMessage(holder)));
      }
      return;
    }

    case "clear": {
      const result = lock.clear({ safetyCheck: !options.force });
      if (options.json) {
        console.log(JSON.stringify(result));
        if (!result.cleared) process.exitCode = 1;
        return;
      }
      if (result.cleared) {
        console.log(chalk.green("✓ Cleared checkout lock"));
        return;
      }
      process.exitCode = 1;
      if (result.reason === "no-lock") {
        console.log(chalk.gray("No checkout lock to clear"));
        process.exitCode = 0;
        return;
      }
      console.log(
        chalk.yellow(
          "Refusing to clear a fresh checkout lock. " +
            "Re-run with `sequant locks checkout clear --force` if you are sure the holder is gone.",
        ),
      );
      return;
    }

    default:
      console.error(
        chalk.red(
          `Unknown action: ${action}. Expected acquire|release|check|clear.`,
        ),
      );
      process.exitCode = 2;
  }
}

/**
 * `sequant locks clear <issue>` — remove a lock manually.
 * By default refuses to clear a fresh same-host lock whose PID is alive;
 * pass `--force` to override.
 */
export async function locksClearCommand(
  issueArg: string,
  options: LocksClearOptions = {},
): Promise<void> {
  const issue = Number.parseInt(issueArg, 10);
  if (!Number.isInteger(issue) || issue <= 0) {
    console.error(chalk.red(`Invalid issue number: ${issueArg}`));
    process.exitCode = 1;
    return;
  }

  const manager = new LockManager();
  if (manager.isNoop) {
    console.log(
      chalk.gray("Lock operations are disabled (SEQUANT_ORCHESTRATOR set)."),
    );
    return;
  }

  const result = manager.clearLock(issue, { safetyCheck: !options.force });
  if (options.json) {
    console.log(JSON.stringify({ issue, ...result }));
    return;
  }

  if (result.cleared) {
    console.log(chalk.green(`✓ Cleared lock for #${issue}`));
    return;
  }

  switch (result.reason) {
    case "no-lock":
      console.log(chalk.gray(`No lock found for #${issue}`));
      return;
    case "fresh-same-host-alive": {
      const holder = manager.check(issue);
      console.log(
        chalk.yellow(
          `Refusing to clear fresh lock on #${issue}` +
            (holder ? ` (PID ${holder.pid} appears alive on this host)` : "") +
            `. Re-run with --force if you really want to clear it.`,
        ),
      );
      process.exitCode = 1;
      return;
    }
    default:
      console.log(chalk.gray(`No-op (${result.reason})`));
  }
}

/**
 * `sequant locks acquire <issue>` — claim the lock from a shell context
 * (e.g. a skill SKILL.md). Use `--skip-pid-check` for skill shells whose
 * Node PID dies between acquire and release; stale recovery then falls back
 * to age-only (2h).
 *
 * Exit codes:
 *   0 — acquired
 *   1 — locked by another holder (printed to stderr unless --json)
 *   2 — invalid arguments
 */
export async function locksAcquireCommand(
  issueArg: string,
  options: LocksAcquireOptions = {},
): Promise<void> {
  const issue = parseIssue(issueArg);
  if (issue === null) return;

  const command = options.command ?? "unknown";
  const manager = new LockManager();
  if (manager.isNoop) {
    if (options.json) {
      console.log(JSON.stringify({ acquired: true, orchestratorMode: true }));
    } else {
      console.log(
        chalk.gray("Lock operations are disabled (SEQUANT_ORCHESTRATOR set)."),
      );
    }
    return;
  }

  if (options.force) {
    const { previous } = manager.forceAcquire(issue, command, {
      skipPidCheck: options.skipPidCheck,
    });
    if (previous && options.signalOther) {
      const result = manager.signalOther(previous);
      if (!options.json) {
        console.log(chalk.gray(formatSignalLine(issue, previous.pid, result)));
      }
    }
    if (options.json) {
      console.log(
        JSON.stringify({
          acquired: true,
          forced: true,
          previousHolder: previous,
        }),
      );
    } else {
      console.log(chalk.green(`✓ Acquired lock for #${issue} (forced)`));
    }
    return;
  }

  const result = manager.acquire(issue, command, {
    skipPidCheck: options.skipPidCheck,
  });
  if (result.acquired) {
    if (options.json) {
      console.log(
        JSON.stringify({ acquired: true, lockPath: result.lockPath }),
      );
    } else {
      console.log(chalk.green(`✓ Acquired lock for #${issue}`));
    }
    return;
  }

  // Blocked.
  process.exitCode = 1;
  if (options.json) {
    console.log(
      JSON.stringify({
        acquired: false,
        holder: result.holder,
        lockPath: result.lockPath,
      }),
    );
  } else {
    console.error(chalk.yellow(formatLockedMessage(issue, result.holder)));
  }
}

/**
 * `sequant locks release <issue>` — release a lock previously acquired by
 * a skill shell on this host. Refuses to release locks held by a foreign
 * host or by a different process (use `locks clear --force` for that).
 */
export async function locksReleaseCommand(
  issueArg: string,
  options: LocksReleaseOptions = {},
): Promise<void> {
  const issue = parseIssue(issueArg);
  if (issue === null) return;

  const manager = new LockManager();
  if (manager.isNoop) {
    if (options.json) {
      console.log(
        JSON.stringify({ issue, released: false, orchestratorMode: true }),
      );
    } else {
      console.log(
        chalk.gray("Lock operations are disabled (SEQUANT_ORCHESTRATOR set)."),
      );
    }
    return;
  }

  const released = manager.releaseExternal(issue);
  if (options.json) {
    console.log(JSON.stringify({ issue, released }));
    return;
  }
  if (released) {
    console.log(chalk.green(`✓ Released lock for #${issue}`));
  } else {
    console.log(chalk.gray(`No releasable lock for #${issue}`));
  }
}

/**
 * `sequant locks check <issue>` — read-only lock probe for `/assess`-style
 * skills. Prints holder info if any, exit code 0 when free, 1 when held.
 */
export async function locksCheckCommand(
  issueArg: string,
  options: LocksCheckOptions = {},
): Promise<void> {
  const issue = parseIssue(issueArg);
  if (issue === null) return;

  const manager = new LockManager();
  if (manager.isNoop) {
    if (options.json) {
      console.log(JSON.stringify({ locked: false, orchestratorMode: true }));
    } else {
      console.log(
        chalk.gray("Lock operations are disabled (SEQUANT_ORCHESTRATOR set)."),
      );
    }
    return;
  }

  const holder = manager.check(issue);
  if (!holder) {
    if (options.json) {
      console.log(JSON.stringify({ issue, locked: false }));
    } else {
      console.log(chalk.gray(`#${issue} is not locked`));
    }
    return;
  }

  process.exitCode = 1;
  if (options.json) {
    console.log(JSON.stringify({ issue, locked: true, holder }));
  } else {
    console.log(chalk.yellow(formatLockedMessage(issue, holder)));
  }
}

/**
 * `sequant locks check-batch <issue1> <issue2> ...` — read-only batch probe
 * used by `/assess`. Text mode emits one canonical warning line per held
 * issue (nothing for unheld), so the skill can paste the output directly
 * above its dashboard. JSON mode emits a structured `{ warnings: [...] }`.
 *
 * Exit code is always 0 — `/assess` is read-only and should never abort
 * on locked issues; the warning is informational.
 */
export async function locksCheckBatchCommand(
  issueArgs: string[],
  options: LocksCheckBatchOptions = {},
): Promise<void> {
  const issues: number[] = [];
  for (const arg of issueArgs) {
    const issue = Number.parseInt(arg, 10);
    if (!Number.isInteger(issue) || issue <= 0) {
      console.error(chalk.red(`Invalid issue number: ${arg}`));
      process.exitCode = 2;
      return;
    }
    issues.push(issue);
  }

  const manager = new LockManager();
  if (manager.isNoop) {
    if (options.json) {
      console.log(
        JSON.stringify({ warnings: [], orchestratorMode: true, checked: 0 }),
      );
    }
    // Non-JSON: silent in orchestrator mode (matches `acquire`/`release`
    // semantics — no spurious output for /assess in MCP-driven runs).
    return;
  }

  const warnings: Array<{ issue: number; holder: LockFile }> = [];
  for (const issue of issues) {
    const holder = manager.check(issue);
    if (holder) warnings.push({ issue, holder });
  }

  if (options.json) {
    console.log(JSON.stringify({ warnings, checked: issues.length }, null, 2));
    return;
  }

  // Text mode: one line per held issue (canonical `⚠` format that /assess
  // pastes verbatim into its dashboard). Empty output when nothing is held.
  for (const { issue, holder } of warnings) {
    console.log(
      `⚠ #${issue} held by PID ${holder.pid} on ${holder.hostname} ` +
        `since ${holder.startedAt} (${holder.command})`,
    );
  }
}
