/**
 * Type definitions and Zod schemas for the interactive relay (#383).
 *
 * The relay is a file-based IPC channel that allows a user terminal to send
 * messages into a running headless Claude session. Messages flow through two
 * JSONL files in `<worktree>/.sequant/relay/`:
 *
 *  - `inbox.jsonl`: user → Claude (consumed by the PostToolUse hook)
 *  - `outbox.jsonl`: Claude → user (tailed by `sequant watch`)
 */

import { z } from "zod";

/** Maximum size (bytes) of a single relay message body. */
export const MAX_MESSAGE_BYTES = 16 * 1024; // 16 KB

/** Relay message types. `query` asks for status, `directive` nudges behavior, `abort` stops. */
export const RelayMessageTypeSchema = z.enum(["query", "directive", "abort"]);
export type RelayMessageType = z.infer<typeof RelayMessageTypeSchema>;

/** Inbox message id format: `msg_<hex>`. */
export const MESSAGE_ID_PATTERN = /^msg_[0-9a-f]+$/;

/** Outbox reply id format: `reply_<hex>`. */
export const REPLY_ID_PATTERN = /^reply_[0-9a-f]+$/;

const baseInboxFields = {
  id: z.string().regex(MESSAGE_ID_PATTERN, "id must match /^msg_[0-9a-f]+$/"),
  timestamp: z.string().datetime(),
};

/**
 * Discriminated union over `type`. `query` and `directive` require a non-empty
 * `message` body; `abort` allows an optional explanatory message but it is not
 * required.
 */
export const RelayMessageSchema = z.discriminatedUnion("type", [
  z.object({
    ...baseInboxFields,
    type: z.literal("query"),
    message: z
      .string()
      .min(1, "message is required for query")
      .max(MAX_MESSAGE_BYTES, `message exceeds ${MAX_MESSAGE_BYTES} bytes`),
  }),
  z.object({
    ...baseInboxFields,
    type: z.literal("directive"),
    message: z
      .string()
      .min(1, "message is required for directive")
      .max(MAX_MESSAGE_BYTES, `message exceeds ${MAX_MESSAGE_BYTES} bytes`),
  }),
  z.object({
    ...baseInboxFields,
    type: z.literal("abort"),
    message: z.string().max(MAX_MESSAGE_BYTES).optional(),
  }),
]);

export type RelayMessage = z.infer<typeof RelayMessageSchema>;

/** Outbox reply. `inReplyTo` is mandatory — every reply references an inbox id. */
export const RelayResponseSchema = z.object({
  id: z.string().regex(REPLY_ID_PATTERN, "id must match /^reply_[0-9a-f]+$/"),
  inReplyTo: z
    .string()
    .min(1, "inReplyTo is required")
    .regex(MESSAGE_ID_PATTERN, "inReplyTo must match /^msg_[0-9a-f]+$/"),
  timestamp: z.string().datetime(),
  message: z.string(),
});

export type RelayResponse = z.infer<typeof RelayResponseSchema>;

// `RelayState` is defined in `src/lib/workflow/state-schema.ts` (canonical
// location alongside `IssueState`). Re-exported here as a convenience.
export { RelayStateSchema, type RelayState } from "../workflow/state-schema.js";

/**
 * `meta.json` written alongside archived inbox/outbox in
 * `.sequant/logs/relay/<issue>-<phase>-<ts>/`. Captures the run boundary so
 * post-hoc inspection knows which phase/issue the messages belonged to.
 */
export const RelayArchiveMetaSchema = z.object({
  issue: z.number().int().positive(),
  phase: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  messageCount: z.number().int().nonnegative(),
});

export type RelayArchiveMeta = z.infer<typeof RelayArchiveMetaSchema>;
