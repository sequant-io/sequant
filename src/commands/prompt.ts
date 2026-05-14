/**
 * `sequant prompt <issue> "<message>"` — send a message into a running
 * headless `sequant run` session via the interactive relay (#383).
 */

import { existsSync, statSync, readFileSync } from "fs";
import chalk from "chalk";
import {
  RelayMessageTypeSchema,
  RelayResponseSchema,
  type RelayMessageType,
  type RelayResponse,
} from "../lib/relay/types.js";
import { appendInboxMessage } from "../lib/relay/writer.js";
import { cleanupStalePid, readPidFile } from "../lib/relay/pid.js";
import { outboxPathFor } from "../lib/relay/paths.js";
import { StateManager } from "../lib/workflow/state-manager.js";
import type { IssueState } from "../lib/workflow/state-schema.js";

export interface PromptCommandOptions {
  type?: string;
  json?: boolean;
  /**
   * If set, poll the outbox for a reply that matches the new message ID and
   * print it inline. Exits 0 on reply, 1 on timeout (#645, Gap 4).
   */
  waitSeconds?: number;
  /** Test seam: override the poll interval (ms). Default 250. */
  waitPollIntervalMs?: number;
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

  // Re-fetch state with a fresh manager to bypass any cached snapshot from
  // the start-of-command read. Without this, `currentPhase` shown in the
  // confirmation can be a phase-old (#645, Gap 6: user reported "exec phase"
  // while state.json had advanced to qa).
  let freshPhase: string | undefined;
  let freshStartedAt: string | undefined;
  try {
    const freshState = await new StateManager().getIssueState(issueNumber);
    freshPhase = freshState?.currentPhase;
    freshStartedAt = freshState?.relay?.startedAt;
  } catch {
    // Fall back to the issueState we already have.
    freshPhase = issueState?.currentPhase;
    freshStartedAt = issueState?.relay?.startedAt;
  }

  let elapsedSegment = "";
  if (freshStartedAt) {
    const ms = Date.now() - new Date(freshStartedAt).getTime();
    elapsedSegment = `, ${formatElapsed(ms)} elapsed`;
  }
  // Omit the phase label when we don't have a fresh reading (#645, Gap 6) —
  // a wrong phase is worse than no phase. Callers asking for JSON still get
  // an explicit `phase: null` for that case.
  const phaseSegment = freshPhase
    ? ` (${freshPhase} phase${elapsedSegment})`
    : "";
  const confirmation = `Message sent to #${issueNumber}${phaseSegment}`;

  if (options.json) {
    console.log(
      JSON.stringify({
        ok: true,
        issue: issueNumber,
        messageId: message.id,
        type: parsed.type,
        phase: freshPhase ?? null,
      }),
    );
  } else {
    console.log(chalk.green(confirmation));
  }

  // Optional --wait: poll outbox for a reply that references our message id.
  // Times out with exit 1 if no matching reply lands within the window.
  if (
    typeof options.waitSeconds === "number" &&
    options.waitSeconds > 0 &&
    parsed.type !== "abort"
  ) {
    const reply = await waitForReply({
      issueNumber,
      worktreePath: issueState?.worktree,
      inReplyTo: message.id,
      timeoutMs: options.waitSeconds * 1000,
      pollIntervalMs: options.waitPollIntervalMs ?? 250,
    });

    if (reply) {
      if (options.json) {
        console.log(JSON.stringify({ ok: true, reply }));
      } else {
        console.log(chalk.cyan(`Reply: ${reply.message}`));
      }
    } else {
      const msg = `No reply received within ${options.waitSeconds}s. Message may be archived without a response.`;
      if (options.json) {
        console.log(JSON.stringify({ ok: false, timeout: true, error: msg }));
      } else {
        console.error(chalk.yellow(msg));
      }
      process.exitCode = 1;
    }
  }
}

interface WaitForReplyOptions {
  issueNumber: number;
  worktreePath: string | undefined;
  inReplyTo: string;
  timeoutMs: number;
  pollIntervalMs: number;
}

async function waitForReply(
  options: WaitForReplyOptions,
): Promise<RelayResponse | null> {
  const outboxPath = outboxPathFor(options.issueNumber, {
    worktreePath: options.worktreePath,
  });

  // Seed offset at current EOF: only NEW replies count for this prompt's wait.
  let offset = existsSync(outboxPath) ? statSync(outboxPath).size : 0;
  let partial = "";

  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(outboxPath)) {
      try {
        const size = statSync(outboxPath).size;
        if (size > offset) {
          const chunk = readFileSync(outboxPath, "utf-8").slice(offset);
          offset = size;
          const lines = (partial + chunk).split("\n");
          partial = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim() === "") continue;
            try {
              const parsed = RelayResponseSchema.safeParse(JSON.parse(line));
              if (
                parsed.success &&
                parsed.data.inReplyTo === options.inReplyTo
              ) {
                return parsed.data;
              }
            } catch {
              /* skip malformed */
            }
          }
        }
      } catch {
        /* transient — try again */
      }
    }
    await new Promise((r) => setTimeout(r, options.pollIntervalMs));
  }
  return null;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m ${seconds}s`;
}
