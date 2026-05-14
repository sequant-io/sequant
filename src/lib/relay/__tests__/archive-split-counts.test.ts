/**
 * Verifies that archived `meta.json` splits message counts into `inboxCount`
 * and `outboxCount` so post-hoc inspection can spot unanswered queries
 * (#645, Gap 5).
 */

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveRelayDir, listArchives } from "../archive.ts";
import { RelayArchiveMetaSchema } from "../types.ts";

describe("archiveRelayDir splits inbox/outbox counts (#645)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "relay-archive-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes inboxCount + outboxCount and preserves messageCount as the sum", () => {
    const issue = 645;
    const relayDir = join(tmp, ".sequant", "relay");
    mkdirSync(relayDir, { recursive: true });

    // 3 inbox messages, 1 outbox reply.
    const inboxLines = [
      '{"id":"msg_a","timestamp":"2026-05-14T00:00:00.000Z","type":"query","message":"a"}',
      '{"id":"msg_b","timestamp":"2026-05-14T00:00:01.000Z","type":"query","message":"b"}',
      '{"id":"msg_c","timestamp":"2026-05-14T00:00:02.000Z","type":"directive","message":"c"}',
    ];
    const outboxLines = [
      '{"id":"reply_1","inReplyTo":"msg_a","timestamp":"2026-05-14T00:00:00.500Z","message":"hi"}',
    ];
    writeFileSync(join(relayDir, "inbox.jsonl"), inboxLines.join("\n") + "\n");
    writeFileSync(
      join(relayDir, "outbox.jsonl"),
      outboxLines.join("\n") + "\n",
    );

    const result = archiveRelayDir(issue, {
      worktreePath: tmp,
      archiveCwd: tmp,
      phase: "qa",
      startedAt: "2026-05-14T00:00:00.000Z",
      endedAt: "2026-05-14T00:00:05.000Z",
      messageCount: 4,
    });

    expect(result.archived).toBe(true);
    expect(result.archivePath).toBeTruthy();

    const metaPath = join(result.archivePath!, "meta.json");
    const meta = RelayArchiveMetaSchema.parse(
      JSON.parse(readFileSync(metaPath, "utf-8")),
    );

    expect(meta.inboxCount).toBe(3);
    expect(meta.outboxCount).toBe(1);
    expect(meta.messageCount).toBe(4);
    expect(meta.inboxCount! + meta.outboxCount!).toBe(meta.messageCount);
  });

  it("schema accepts archives without the split fields (back-compat)", () => {
    // Simulate an archive written before the split — `meta.json` would lack
    // `inboxCount` / `outboxCount`. Schema must still parse it.
    const legacyMeta = {
      issue: 100,
      phase: "exec",
      startedAt: "2026-05-14T00:00:00.000Z",
      endedAt: "2026-05-14T00:00:05.000Z",
      messageCount: 2,
    };
    expect(() => RelayArchiveMetaSchema.parse(legacyMeta)).not.toThrow();
  });

  it("listArchives finds the freshly-written archive", () => {
    const issue = 999;
    const relayDir = join(tmp, ".sequant", "relay");
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      join(relayDir, "inbox.jsonl"),
      '{"id":"msg_x","timestamp":"2026-05-14T00:00:00.000Z","type":"query","message":"x"}\n',
    );

    archiveRelayDir(issue, {
      worktreePath: tmp,
      archiveCwd: tmp,
      phase: "exec",
      startedAt: "2026-05-14T00:00:00.000Z",
      messageCount: 1,
    });

    const archives = listArchives(issue, tmp);
    expect(archives.length).toBe(1);
    expect(archives[0]).toContain(`${issue}-exec-`);
  });
});
