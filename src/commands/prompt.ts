/**
 * `sequant prompt <issue> "<message>"` — send a message into a running
 * headless `sequant run` session via the interactive relay (#383).
 */

import chalk from "chalk";
import {
  RelayMessageTypeSchema,
  type RelayMessageType,
} from "../lib/relay/types.js";
import { appendInboxMessage } from "../lib/relay/writer.js";
import { cleanupStalePid, readPidFile } from "../lib/relay/pid.js";
import { StateManager } from "../lib/workflow/state-manager.js";
import type { IssueState } from "../lib/workflow/state-schema.js";

export interface PromptCommandOptions {
  type?: string;
  json?: boolean;
}

export interface ParsedPromptArgs {
  issue: number | null;
  message: string;
  type: RelayMessageType;
}

/** Validate raw CLI args. Throws on invalid type or empty message. */
export function parseRelayPromptArgs(
  args: string[],
  options: { type?: string } = {},
): ParsedPromptArgs {
  // Allowed shapes:
  //   ["<message>"]           — single arg, auto-resolve issue
  //   ["<issue>", "<message>"] — both positional
  let issueArg: string | undefined;
  let messageArg: string;
  if (args.length === 1) {
    messageArg = args[0];
  } else if (args.length >= 2) {
    issueArg = args[0];
    messageArg = args.slice(1).join(" ");
  } else {
    throw new Error('Usage: sequant prompt [issue] "<message>" [--type TYPE]');
  }

  if (!messageArg || messageArg.trim() === "") {
    throw new Error("Message cannot be empty");
  }

  let issue: number | null = null;
  if (issueArg !== undefined) {
    const n = Number.parseInt(issueArg, 10);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`Invalid issue number: '${issueArg}'`);
    }
    issue = n;
  }

  const rawType = options.type ?? "query";
  const parsedType = RelayMessageTypeSchema.safeParse(rawType);
  if (!parsedType.success) {
    throw new Error(
      `Invalid --type '${rawType}'. Valid values: query, directive, abort.`,
    );
  }

  return { issue, message: messageArg, type: parsedType.data };
}

/** Identify candidate active runs for auto-resolution (AC-17b). */
export function findActiveIssues(
  issues: IssueState[],
  isAlive: (pid: number) => boolean,
  cwd: string = process.cwd(),
): number[] {
  const active: number[] = [];
  for (const issue of issues) {
    if (issue.status !== "in_progress") continue;
    const pid = readPidFile(issue.number, cwd);
    if (pid !== null && isAlive(pid)) {
      active.push(issue.number);
    }
  }
  return active;
}

/**
 * Resolve which issue to target.
 * - Explicit `issue` arg: use as-is.
 * - Single active run: auto-resolve.
 * - Zero active runs: error.
 * - Multiple active runs: error with usage hint.
 */
export function resolveTargetIssue(args: {
  explicit: number | null;
  activeIssues: number[];
}): { issue: number; reason: "explicit" | "single-active" } {
  if (args.explicit !== null) {
    return { issue: args.explicit, reason: "explicit" };
  }
  if (args.activeIssues.length === 0) {
    throw new Error(
      "No active sequant runs found. Start one with `sequant run <issue>` first.",
    );
  }
  if (args.activeIssues.length > 1) {
    const list = args.activeIssues.map((n) => `#${n}`).join(", ");
    throw new Error(
      `Multiple active runs: ${list}. Specify an issue number.\n` +
        `Usage: sequant prompt ${args.activeIssues[0]} "your message"`,
    );
  }
  return { issue: args.activeIssues[0], reason: "single-active" };
}

export async function promptCommand(argsAndOptions: {
  args: string[];
  options: PromptCommandOptions;
}): Promise<void> {
  const { args, options } = argsAndOptions;
  const parsed = parseRelayPromptArgs(args, { type: options.type });

  // Resolve target issue.
  const stateManager = new StateManager();
  let issueState: IssueState | null;
  let issueNumber: number;

  if (parsed.issue !== null) {
    issueNumber = parsed.issue;
    issueState = await stateManager.getIssueState(issueNumber);
  } else {
    const all = stateManager.stateExists()
      ? Object.values(await stateManager.getAllIssueStates())
      : [];
    const { defaultIsPidAlive } = await import("../lib/locks/lock-manager.js");
    const active = findActiveIssues(all, defaultIsPidAlive);
    const target = resolveTargetIssue({
      explicit: null,
      activeIssues: active,
    });
    issueNumber = target.issue;
    issueState = await stateManager.getIssueState(issueNumber);
  }

  // Liveness check — refuse to write to a dead session.
  const cleanup = cleanupStalePid(issueNumber);
  if (cleanup.warning) {
    // Also reflect deactivation in state.
    if (issueState?.relay) {
      try {
        await stateManager.setRelayState(issueNumber, null);
      } catch {
        /* swallow */
      }
    }
    if (options.json) {
      console.log(
        JSON.stringify({
          ok: false,
          issue: issueNumber,
          error: cleanup.warning,
        }),
      );
    } else {
      console.error(chalk.yellow(cleanup.warning));
    }
    process.exitCode = 1;
    return;
  }
  if (!cleanup.alive) {
    const msg = `No relay PID found for #${issueNumber}. Is the run active?`;
    if (options.json) {
      console.log(
        JSON.stringify({ ok: false, issue: issueNumber, error: msg }),
      );
    } else {
      console.error(chalk.yellow(msg));
    }
    process.exitCode = 1;
    return;
  }

  // Write to inbox (the worktree path is recorded in IssueState).
  const message = appendInboxMessage(
    issueNumber,
    {
      type: parsed.type,
      ...(parsed.type === "abort" && parsed.message.trim() === ""
        ? {}
        : { message: parsed.message }),
    },
    { worktreePath: issueState?.worktree },
  );

  // Increment relay messageCount in state.
  try {
    await stateManager.incrementRelayMessageCount(issueNumber, 1);
  } catch {
    /* swallow */
  }

  // Build confirmation with current phase + elapsed time.
  const phase = issueState?.currentPhase ?? "unknown";
  let elapsedSegment = "";
  if (issueState?.relay?.startedAt) {
    const ms = Date.now() - new Date(issueState.relay.startedAt).getTime();
    elapsedSegment = `, ${formatElapsed(ms)} elapsed`;
  }
  const confirmation = `Message sent to #${issueNumber} (${phase} phase${elapsedSegment})`;

  if (options.json) {
    console.log(
      JSON.stringify({
        ok: true,
        issue: issueNumber,
        messageId: message.id,
        type: parsed.type,
        phase,
      }),
    );
  } else {
    console.log(chalk.green(confirmation));
  }
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m ${seconds}s`;
}
