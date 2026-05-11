/**
 * `sequant locks` — inspect and clear per-issue concurrency locks (#625).
 */

import chalk from "chalk";
import {
  LockManager,
  formatLockedMessage,
  type LockFile,
} from "../lib/locks/index.js";

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
  if (options.json) {
    console.log(JSON.stringify({ locks: listings }, null, 2));
    return;
  }

  if (listings.length === 0) {
    console.log(chalk.gray("No active locks."));
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
      const sent = manager.signalOther(previous);
      if (!options.json) {
        console.log(
          chalk.gray(
            sent
              ? `Signaled PID ${previous.pid} (SIGTERM) for #${issue}`
              : `Could not signal PID ${previous.pid} for #${issue} (cross-host or already exited)`,
          ),
        );
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
