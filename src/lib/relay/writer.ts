/**
 * Append-only writer for relay inbox/outbox JSONL files.
 *
 * Single-line appends use `O_APPEND` so concurrent writes interleave cleanly
 * at the line boundary (POSIX guarantees atomicity for `write()` calls smaller
 * than `PIPE_BUF`/4 KiB on local filesystems). Multi-line payloads use the
 * temp-file + `rename()` pattern so partial reads never observe a half-written
 * file (AC-5).
 */

import { randomBytes } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "fs";
import { dirname, join } from "path";
import {
  MAX_MESSAGE_BYTES,
  RelayMessageSchema,
  RelayResponseSchema,
  type RelayMessage,
  type RelayMessageType,
  type RelayResponse,
} from "./types.js";
import { inboxPathFor, outboxPathFor, type RelayPathOptions } from "./paths.js";

/** Generate a `msg_<hex>` id with enough entropy to stay unique within a run. */
export function generateMessageId(): string {
  return `msg_${randomBytes(8).toString("hex")}`;
}

/** Generate a `reply_<hex>` id. */
export function generateReplyId(): string {
  return `reply_${randomBytes(8).toString("hex")}`;
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/** Build an inbox message, validating against the schema. */
export function buildInboxMessage(input: {
  type: RelayMessageType;
  message?: string;
  id?: string;
  timestamp?: string;
}): RelayMessage {
  const candidate = {
    id: input.id ?? generateMessageId(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    type: input.type,
    ...(input.message !== undefined ? { message: input.message } : {}),
  };
  return RelayMessageSchema.parse(candidate);
}

/** Build an outbox reply, validating against the schema. */
export function buildOutboxReply(input: {
  inReplyTo: string;
  message: string;
  id?: string;
  timestamp?: string;
}): RelayResponse {
  return RelayResponseSchema.parse({
    id: input.id ?? generateReplyId(),
    inReplyTo: input.inReplyTo,
    timestamp: input.timestamp ?? new Date().toISOString(),
    message: input.message,
  });
}

/**
 * Append a single inbox message. Uses `O_APPEND` for crash-safe concurrent
 * writes (AC-5). Throws on body sizes that exceed `MAX_MESSAGE_BYTES`.
 */
export function appendInboxMessage(
  issue: number,
  input: {
    type: RelayMessageType;
    message?: string;
  },
  options: RelayPathOptions = {},
): RelayMessage {
  if (
    input.message &&
    Buffer.byteLength(input.message, "utf-8") > MAX_MESSAGE_BYTES
  ) {
    throw new Error(
      `relay: message body exceeds max size of ${MAX_MESSAGE_BYTES} bytes`,
    );
  }
  const message = buildInboxMessage(input);
  const path = inboxPathFor(issue, options);
  appendJsonLine(path, message);
  return message;
}

/** Append a single outbox reply via `O_APPEND`. */
export function appendOutboxReply(
  issue: number,
  input: {
    inReplyTo: string;
    message: string;
  },
  options: RelayPathOptions = {},
): RelayResponse {
  const reply = buildOutboxReply(input);
  const path = outboxPathFor(issue, options);
  appendJsonLine(path, reply);
  return reply;
}

/**
 * Write multiple inbox messages atomically (temp file + rename).
 * Useful when seeding a relay dir from a backup or replaying. Single-message
 * writes should use `appendInboxMessage` instead.
 */
export function writeInboxBatchAtomic(
  issue: number,
  messages: RelayMessage[],
  options: RelayPathOptions = {},
): void {
  const path = inboxPathFor(issue, options);
  writeJsonLinesAtomic(path, messages);
}

function appendJsonLine(path: string, payload: unknown): void {
  ensureDir(path);
  const line = JSON.stringify(payload) + "\n";
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

function writeJsonLinesAtomic(path: string, items: unknown[]): void {
  ensureDir(path);
  const body =
    items.map((it) => JSON.stringify(it)).join("\n") +
    (items.length ? "\n" : "");
  // Temp file must live on the SAME filesystem as `path` for rename() to be atomic.
  const tmp = join(
    dirname(path),
    `.relay-tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString("hex")}`,
  );
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, body);
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
