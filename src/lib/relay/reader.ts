/**
 * Reader for the relay inbox. Tracks the last-read line via a `.cursor` file
 * so each PostToolUse hook invocation only sees new messages (AC-11).
 *
 * Atomic cursor update: write to a temp file in the same directory, then
 * rename. A crash mid-write never leaves a half-written cursor.
 */

import { randomBytes } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { dirname, join } from "path";
import { RelayMessageSchema, type RelayMessage } from "./types.js";
import { cursorPathFor, inboxPathFor, type RelayPathOptions } from "./paths.js";

export interface ReadResult {
  /** Newly read inbox messages, ordered by file appearance (timestamp). */
  messages: RelayMessage[];
  /** Cursor value after this read. */
  cursor: number;
  /** Total line count of inbox.jsonl after the read. */
  inboxLineCount: number;
  /** Malformed lines that were skipped (for logging). */
  skipped: number;
}

/** Read the persisted cursor; missing/unparseable → 0 (AC-11 edge case). */
export function readCursor(
  issue: number,
  options: RelayPathOptions = {},
): number {
  const path = cursorPathFor(issue, options);
  if (!existsSync(path)) return 0;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0) return 0;
    return n;
  } catch {
    return 0;
  }
}

/** Write the cursor atomically (temp file + rename). */
export function writeCursor(
  issue: number,
  value: number,
  options: RelayPathOptions = {},
): void {
  const path = cursorPathFor(issue, options);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.cursor.${process.pid}.${Date.now()}.${randomBytes(2).toString("hex")}.tmp`,
  );
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, String(value));
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        /* swallow */
      }
    }
    throw err;
  }
}

/**
 * Read unread inbox messages and advance the cursor.
 *
 * - Missing or empty inbox → empty result (fast path).
 * - Malformed JSON lines are logged via the `onMalformed` callback (if any)
 *   and skipped; the cursor still advances past them so we don't loop.
 * - If the cursor points past EOF (inbox was truncated/rotated), reset to the
 *   current line count and return no messages.
 */
export function readUnreadMessages(
  issue: number,
  options: RelayPathOptions & {
    onMalformed?: (line: string, index: number) => void;
  } = {},
): ReadResult {
  const inboxPath = inboxPathFor(issue, options);
  if (!existsSync(inboxPath)) {
    return { messages: [], cursor: 0, inboxLineCount: 0, skipped: 0 };
  }

  const st = statSync(inboxPath);
  if (st.size === 0) {
    return { messages: [], cursor: 0, inboxLineCount: 0, skipped: 0 };
  }

  const text = readFileSync(inboxPath, "utf-8");
  const lines = text.split("\n").filter((l, idx, arr) => {
    // Keep all but the final empty element from a trailing newline.
    return !(idx === arr.length - 1 && l === "");
  });

  const totalLines = lines.length;
  let cursor = readCursor(issue, options);

  // If cursor is past EOF (file was rotated/truncated), reset to current end.
  if (cursor > totalLines) {
    writeCursor(issue, totalLines, options);
    return {
      messages: [],
      cursor: totalLines,
      inboxLineCount: totalLines,
      skipped: 0,
    };
  }

  const messages: RelayMessage[] = [];
  let skipped = 0;
  for (let i = cursor; i < totalLines; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    try {
      const obj: unknown = JSON.parse(raw);
      const parsed = RelayMessageSchema.safeParse(obj);
      if (!parsed.success) {
        skipped++;
        options.onMalformed?.(raw, i);
        continue;
      }
      messages.push(parsed.data);
    } catch {
      skipped++;
      options.onMalformed?.(raw, i);
    }
  }

  cursor = totalLines;
  writeCursor(issue, cursor, options);
  return { messages, cursor, inboxLineCount: totalLines, skipped };
}
