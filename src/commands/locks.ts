/**
 * `sequant locks` — inspect and clear per-issue concurrency locks (#625).
 */

import chalk from "chalk";
import { LockManager } from "../lib/locks/index.js";

export interface LocksListOptions {
  json?: boolean;
}

export interface LocksClearOptions {
  force?: boolean;
  json?: boolean;
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
