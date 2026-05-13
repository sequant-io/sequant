/**
 * `sequant watch <issue>` — tail the relay outbox for replies from a running
 * headless session (#383). Uses `fs.watch()` when available, falls back to
 * polling on platforms where `fs.watch` is unreliable (NFS, some WSL setups).
 */

import { existsSync, statSync, createReadStream, watch } from "fs";
import { Readable } from "stream";
import chalk from "chalk";
import { outboxPathFor } from "../lib/relay/paths.js";
import { StateManager } from "../lib/workflow/state-manager.js";
import { RelayResponseSchema, type RelayResponse } from "../lib/relay/types.js";

export interface WatchCommandOptions {
  json?: boolean;
  /** Poll interval (ms); used when fs.watch is unavailable. Default: 200. */
  pollIntervalMs?: number;
  /** Abort signal for clean shutdown (tests). */
  signal?: AbortSignal;
}

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return iso;
  }
}

function formatLine(reply: RelayResponse, json: boolean): string {
  if (json) return JSON.stringify(reply);
  return chalk.gray(`[${formatTimestamp(reply.timestamp)}] `) + reply.message;
}

interface TailState {
  offset: number;
  partial: string;
}

function readNewLines(
  path: string,
  state: TailState,
): Promise<RelayResponse[]> {
  return new Promise((resolve, reject) => {
    if (!existsSync(path)) {
      resolve([]);
      return;
    }
    const stat = statSync(path);
    if (stat.size <= state.offset) {
      // File was truncated/rotated — reset offset.
      if (stat.size < state.offset) state.offset = 0;
      resolve([]);
      return;
    }
    const stream = createReadStream(path, {
      start: state.offset,
      end: stat.size - 1,
      encoding: "utf-8",
    }) as Readable;
    let buf = state.partial;
    stream.on("data", (chunk) => {
      buf += chunk;
    });
    stream.on("error", (err) => reject(err));
    stream.on("end", () => {
      state.offset = stat.size;
      const lines = buf.split("\n");
      state.partial = lines.pop() ?? "";
      const replies: RelayResponse[] = [];
      for (const line of lines) {
        if (line.trim() === "") continue;
        try {
          const parsed = RelayResponseSchema.safeParse(JSON.parse(line));
          if (parsed.success) replies.push(parsed.data);
        } catch {
          /* skip malformed */
        }
      }
      resolve(replies);
    });
  });
}

export async function watchCommand(argsAndOptions: {
  args: string[];
  options: WatchCommandOptions;
}): Promise<void> {
  const { args, options } = argsAndOptions;
  const issueArg = args[0];
  if (!issueArg) {
    throw new Error("Usage: sequant watch <issue>");
  }
  const issueNumber = Number.parseInt(issueArg, 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issue number: '${issueArg}'`);
  }

  const stateManager = new StateManager();
  const issueState = await stateManager.getIssueState(issueNumber);
  const outboxPath = outboxPathFor(issueNumber, {
    worktreePath: issueState?.worktree,
  });

  const pollIntervalMs = options.pollIntervalMs ?? 200;
  const tail: TailState = { offset: 0, partial: "" };

  // Seed tail offset at current EOF so we only show NEW replies.
  if (existsSync(outboxPath)) {
    tail.offset = statSync(outboxPath).size;
  }

  if (!options.json) {
    console.log(chalk.gray(`Watching #${issueNumber} outbox — Ctrl+C to stop`));
  }

  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  options.signal?.addEventListener("abort", stop);
  process.on("SIGINT", () => {
    stop();
    if (!options.json) console.log(chalk.gray("\nStopped watching."));
    process.exit(0);
  });

  let useWatcher = false;
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    if (existsSync(outboxPath)) {
      watcher = watch(outboxPath, { persistent: true }, () => {
        // fs.watch fires on any modification; we still poll readNewLines.
      });
      useWatcher = true;
    }
  } catch {
    useWatcher = false;
  }

  const emit = (replies: RelayResponse[]): void => {
    for (const r of replies) {
      console.log(formatLine(r, options.json === true));
    }
  };

  // Polling loop — also used as a heartbeat when fs.watch is active so we
  // don't miss events on filesystems where watch is unreliable.
  while (!stopped) {
    try {
      const replies = await readNewLines(outboxPath, tail);
      emit(replies);
    } catch {
      /* transient — try again next tick */
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* swallow */
    }
  }
  void useWatcher; // currently unused beyond best-effort init
}
