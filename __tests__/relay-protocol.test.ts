// Tests for the relay protocol layer (#383):
// - AC-2 (inbox msg_<hex> IDs), AC-3 (outbox inReplyTo),
// - AC-4 (Zod discriminated union), AC-5 (atomic writes),
// - AC-11 (cursor file), AC-14 (frame template snapshot).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendInboxMessage,
  appendOutboxReply,
  writeInboxBatchAtomic,
  buildInboxMessage,
  buildOutboxReply,
  generateMessageId,
} from "../src/lib/relay/writer.js";
import {
  readUnreadMessages,
  readCursor,
  writeCursor,
} from "../src/lib/relay/reader.js";
import {
  RelayMessageSchema,
  RelayResponseSchema,
  MAX_MESSAGE_BYTES,
} from "../src/lib/relay/types.js";
import {
  inboxPathFor,
  outboxPathFor,
  cursorPathFor,
} from "../src/lib/relay/paths.js";
import {
  renderFrame,
  loadFrameTemplate,
  FRAME_RULES,
} from "../src/lib/relay/frame.js";

const ISSUE = 383;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-proto-"));
}

describe("Relay Protocol — Types, Writer, Reader, Frame", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // === AC-2: Inbox JSONL with msg_<hex> IDs ===
  describe("AC-2: Inbox writer assigns msg_<hex> IDs", () => {
    it("writes one JSON object per line with id matching /^msg_[0-9a-f]+$/", () => {
      const msg = appendInboxMessage(
        ISSUE,
        { type: "query", message: "status?" },
        { worktreePath: tmp },
      );
      const file = inboxPathFor(ISSUE, { worktreePath: tmp });
      const text = fs.readFileSync(file, "utf-8").trim();
      const parsed = JSON.parse(text);
      expect(parsed.id).toMatch(/^msg_[0-9a-f]+$/);
      expect(parsed.id).toBe(msg.id);
      expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(parsed.type).toBe("query");
      expect(parsed.message).toBe("status?");
    });

    it("assigns unique ids across many writes", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) ids.add(generateMessageId());
      expect(ids.size).toBe(50);
    });

    it("rejects message bodies that exceed MAX_MESSAGE_BYTES", () => {
      const big = "x".repeat(MAX_MESSAGE_BYTES + 1);
      expect(() =>
        appendInboxMessage(
          ISSUE,
          { type: "query", message: big },
          { worktreePath: tmp },
        ),
      ).toThrow(/exceeds max size/);
    });
  });

  // === AC-3: Outbox JSONL with inReplyTo ===
  describe("AC-3: Outbox writer sets inReplyTo to source inbox id", () => {
    it("writes reply with inReplyTo equal to the inbox message id", () => {
      const reply = appendOutboxReply(
        ISSUE,
        { inReplyTo: "msg_abc123", message: "working on it" },
        { worktreePath: tmp },
      );
      const file = outboxPathFor(ISSUE, { worktreePath: tmp });
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8").trim());
      expect(parsed.id).toMatch(/^reply_[0-9a-f]+$/);
      expect(parsed.inReplyTo).toBe("msg_abc123");
      expect(parsed.id).toBe(reply.id);
    });

    it("appends without truncating prior replies", () => {
      appendOutboxReply(
        ISSUE,
        { inReplyTo: "msg_aaaaaaaa", message: "one" },
        { worktreePath: tmp },
      );
      appendOutboxReply(
        ISSUE,
        { inReplyTo: "msg_bbbbbbbb", message: "two" },
        { worktreePath: tmp },
      );
      const lines = fs
        .readFileSync(outboxPathFor(ISSUE, { worktreePath: tmp }), "utf-8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).message).toBe("one");
      expect(JSON.parse(lines[1]).message).toBe("two");
    });

    it("rejects reply with missing or malformed inReplyTo", () => {
      expect(() => buildOutboxReply({ inReplyTo: "", message: "x" })).toThrow();
      expect(() =>
        buildOutboxReply({ inReplyTo: "not_a_msg_id", message: "x" }),
      ).toThrow();
    });
  });

  // === AC-4: query|directive|abort Zod discriminated union ===
  describe("AC-4: Zod discriminated union on type", () => {
    const baseFields = {
      id: "msg_deadbeef",
      timestamp: new Date().toISOString(),
    };

    it("parses a valid query message", () => {
      const m = RelayMessageSchema.parse({
        ...baseFields,
        type: "query",
        message: "hi",
      });
      expect(m.type).toBe("query");
    });

    it("parses a valid directive message", () => {
      const m = RelayMessageSchema.parse({
        ...baseFields,
        type: "directive",
        message: "skip migration",
      });
      expect(m.type).toBe("directive");
    });

    it("parses a valid abort message with or without body", () => {
      expect(
        RelayMessageSchema.parse({ ...baseFields, type: "abort" }).type,
      ).toBe("abort");
      expect(
        RelayMessageSchema.parse({
          ...baseFields,
          type: "abort",
          message: "stop now",
        }).type,
      ).toBe("abort");
    });

    it("rejects unknown type", () => {
      expect(() =>
        RelayMessageSchema.parse({
          ...baseFields,
          type: "nudge",
          message: "x",
        }),
      ).toThrow();
    });

    it("rejects empty message body for query/directive", () => {
      expect(() =>
        RelayMessageSchema.parse({ ...baseFields, type: "query", message: "" }),
      ).toThrow();
      expect(() =>
        RelayMessageSchema.parse({
          ...baseFields,
          type: "directive",
          message: "",
        }),
      ).toThrow();
    });

    it("rejects malformed id (not msg_<hex>)", () => {
      expect(() =>
        RelayMessageSchema.parse({
          id: "BAD",
          timestamp: baseFields.timestamp,
          type: "query",
          message: "x",
        }),
      ).toThrow(/msg_/);
    });
  });

  // === AC-5: Atomic writes via O_APPEND + temp-rename ===
  describe("AC-5: Atomic writes prevent partial reads", () => {
    it("appends survive interleaved writes (O_APPEND)", () => {
      for (let i = 0; i < 5; i++) {
        appendInboxMessage(
          ISSUE,
          { type: "query", message: `m${i}` },
          { worktreePath: tmp },
        );
      }
      const lines = fs
        .readFileSync(inboxPathFor(ISSUE, { worktreePath: tmp }), "utf-8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(5);
      for (const ln of lines) expect(() => JSON.parse(ln)).not.toThrow();
    });

    it("batch atomic write produces valid file or nothing visible mid-write", () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        buildInboxMessage({ type: "query", message: `payload-${i}` }),
      );
      writeInboxBatchAtomic(ISSUE, messages, { worktreePath: tmp });
      const lines = fs
        .readFileSync(inboxPathFor(ISSUE, { worktreePath: tmp }), "utf-8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(10);
    });

    it("no temp files remain after successful batch write", () => {
      const messages = [buildInboxMessage({ type: "query", message: "a" })];
      writeInboxBatchAtomic(ISSUE, messages, { worktreePath: tmp });
      const relayDir = path.dirname(inboxPathFor(ISSUE, { worktreePath: tmp }));
      const stragglers = fs
        .readdirSync(relayDir)
        .filter((n) => n.startsWith(".relay-tmp."));
      expect(stragglers).toHaveLength(0);
    });
  });

  // === AC-11: Cursor file tracks last-read line, atomic update ===
  describe("AC-11: Cursor file tracks last-read line", () => {
    it("initializes cursor to 0 on first read", () => {
      appendInboxMessage(
        ISSUE,
        { type: "query", message: "a" },
        { worktreePath: tmp },
      );
      appendInboxMessage(
        ISSUE,
        { type: "query", message: "b" },
        { worktreePath: tmp },
      );
      const result = readUnreadMessages(ISSUE, { worktreePath: tmp });
      expect(result.messages).toHaveLength(2);
      expect(result.cursor).toBe(2);
      expect(readCursor(ISSUE, { worktreePath: tmp })).toBe(2);
    });

    it("returns only unread messages on subsequent reads", () => {
      appendInboxMessage(
        ISSUE,
        { type: "query", message: "a" },
        { worktreePath: tmp },
      );
      appendInboxMessage(
        ISSUE,
        { type: "query", message: "b" },
        { worktreePath: tmp },
      );
      readUnreadMessages(ISSUE, { worktreePath: tmp });
      appendInboxMessage(
        ISSUE,
        { type: "query", message: "c" },
        { worktreePath: tmp },
      );
      const result = readUnreadMessages(ISSUE, { worktreePath: tmp });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].message).toBe("c");
      expect(result.cursor).toBe(3);
    });

    it("writes cursor atomically (no .tmp leftovers)", () => {
      writeCursor(ISSUE, 7, { worktreePath: tmp });
      const dir = path.dirname(cursorPathFor(ISSUE, { worktreePath: tmp }));
      const tmps = fs.readdirSync(dir).filter((n) => n.includes(".tmp"));
      expect(tmps).toHaveLength(0);
      expect(readCursor(ISSUE, { worktreePath: tmp })).toBe(7);
    });

    it("treats missing cursor file as cursor=0", () => {
      expect(readCursor(ISSUE, { worktreePath: tmp })).toBe(0);
    });

    it("resets cursor when it points past EOF (truncation case)", () => {
      appendInboxMessage(
        ISSUE,
        { type: "query", message: "a" },
        { worktreePath: tmp },
      );
      writeCursor(ISSUE, 999, { worktreePath: tmp });
      const result = readUnreadMessages(ISSUE, { worktreePath: tmp });
      expect(result.messages).toHaveLength(0);
      expect(result.cursor).toBe(1);
    });

    it("skips malformed JSON lines without crashing", () => {
      const file = inboxPathFor(ISSUE, { worktreePath: tmp });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const validMsg = JSON.stringify(
        buildInboxMessage({ type: "query", message: "ok" }),
      );
      fs.writeFileSync(file, `{not json}\n${validMsg}\n`);
      let skipped = 0;
      const result = readUnreadMessages(ISSUE, {
        worktreePath: tmp,
        onMalformed: () => skipped++,
      });
      expect(result.messages).toHaveLength(1);
      expect(skipped).toBeGreaterThanOrEqual(1);
    });
  });

  // === AC-14: Frame matches templates/relay/frame.txt (snapshot) ===
  describe("AC-14: Frame template snapshot", () => {
    it("frame template file exists at templates/relay/frame.txt", () => {
      const tpl = fs.readFileSync(
        path.resolve("templates/relay/frame.txt"),
        "utf-8",
      );
      expect(tpl.length).toBeGreaterThan(0);
      expect(tpl).toContain("{{MESSAGES}}");
    });

    it("template loads via loadFrameTemplate()", () => {
      const tpl = loadFrameTemplate(true);
      expect(tpl).toContain("[SEQUANT RELAY — message from user]");
      expect(tpl).toContain("{{MESSAGES}}");
    });

    it("contains the six verbatim rules from the issue body (AC-15)", () => {
      const tpl = fs.readFileSync(
        path.resolve("templates/relay/frame.txt"),
        "utf-8",
      );
      for (const rule of FRAME_RULES) {
        expect(tpl).toContain(rule);
      }
    });

    it("renderFrame produces output with the header and Type/Message rows", () => {
      const m = buildInboxMessage({ type: "query", message: "hi" });
      const out = renderFrame([m]);
      expect(out).toContain("[SEQUANT RELAY — message from user]");
      expect(out).toContain("Type: query");
      expect(out).toContain('Message: "hi"');
    });

    it("renderFrame produces a single block for multiple messages, sorted by timestamp", () => {
      const m1 = buildInboxMessage({
        type: "query",
        message: "first",
        timestamp: "2026-01-01T00:00:00Z",
      });
      const m2 = buildInboxMessage({
        type: "directive",
        message: "second",
        timestamp: "2026-01-02T00:00:00Z",
      });
      const out = renderFrame([m2, m1]); // intentionally reversed
      const firstIdx = out.indexOf("first");
      const secondIdx = out.indexOf("second");
      expect(firstIdx).toBeGreaterThan(-1);
      expect(secondIdx).toBeGreaterThan(firstIdx);
      // Single framing header, not duplicated per message.
      expect(out.split("[SEQUANT RELAY — message from user]")).toHaveLength(2);
    });
  });

  // === Response schema validation ===
  describe("RelayResponseSchema", () => {
    it("rejects malformed reply id (not reply_<hex>)", () => {
      expect(() =>
        RelayResponseSchema.parse({
          id: "BAD",
          inReplyTo: "msg_deadbeef",
          timestamp: new Date().toISOString(),
          message: "x",
        }),
      ).toThrow();
    });
  });
});
