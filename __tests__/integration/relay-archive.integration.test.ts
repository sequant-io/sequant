// Integration tests for relay archive at phase end (#383):
// AC-6 (archive to .sequant/logs/relay/), AC-D2 (archive before worktree
// teardown), AC-D4 (meta.json).

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  archiveRelayDir,
  listArchives,
  tallyMessageCount,
} from "../../src/lib/relay/archive.js";
import {
  appendInboxMessage,
  appendOutboxReply,
} from "../../src/lib/relay/writer.js";
import {
  relayDirFor,
  inboxPathFor,
  outboxPathFor,
} from "../../src/lib/relay/paths.js";
import { RelayArchiveMetaSchema } from "../../src/lib/relay/types.js";

const TEST_ROOT = path.join(
  os.tmpdir(),
  `sequant-relay-archive-${process.pid}-${Date.now()}`,
);

describe("Relay Archive — phase-end log preservation", () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  let worktree: string;
  let cwd: string;
  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(TEST_ROOT, "wt-"));
    cwd = fs.mkdtempSync(path.join(TEST_ROOT, "cwd-"));
  });
  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function seedRelay(): { startedAt: string } {
    fs.mkdirSync(relayDirFor(383, { worktreePath: worktree }), {
      recursive: true,
    });
    appendInboxMessage(
      383,
      { type: "query", message: "status?" },
      { worktreePath: worktree },
    );
    appendOutboxReply(
      383,
      { inReplyTo: "msg_deadbeef", message: "still working" },
      { worktreePath: worktree },
    );
    return { startedAt: "2026-05-13T10:00:00Z" };
  }

  describe("AC-6: Archive on phase completion", () => {
    it("copies inbox/outbox into .sequant/logs/relay/<issue>-<phase>-<ts>/", () => {
      const { startedAt } = seedRelay();
      const r = archiveRelayDir(383, {
        phase: "exec",
        startedAt,
        messageCount: 2,
        worktreePath: worktree,
        archiveCwd: cwd,
        endedAt: "2026-05-13T10:30:00Z",
      });
      expect(r.archived).toBe(true);
      expect(r.archivePath).not.toBeNull();
      expect(r.archivePath!).toMatch(/383-exec-/);
      expect(fs.existsSync(path.join(r.archivePath!, "inbox.jsonl"))).toBe(
        true,
      );
      expect(fs.existsSync(path.join(r.archivePath!, "outbox.jsonl"))).toBe(
        true,
      );
    });

    it("clears the working inbox/outbox/cursor after archive", () => {
      const { startedAt } = seedRelay();
      archiveRelayDir(383, {
        phase: "exec",
        startedAt,
        messageCount: 2,
        worktreePath: worktree,
        archiveCwd: cwd,
      });
      expect(fs.existsSync(inboxPathFor(383, { worktreePath: worktree }))).toBe(
        false,
      );
      expect(
        fs.existsSync(outboxPathFor(383, { worktreePath: worktree })),
      ).toBe(false);
    });

    it("returns archived=false when relay dir does not exist (idempotent)", () => {
      const r = archiveRelayDir(383, {
        phase: "exec",
        startedAt: "2026-05-13T10:00:00Z",
        messageCount: 0,
        worktreePath: worktree,
        archiveCwd: cwd,
      });
      expect(r.archived).toBe(false);
      expect(r.error).toBeNull();
    });
  });

  describe("AC-D4: meta.json in archived directory", () => {
    it("writes a parseable meta.json with all required fields", () => {
      const { startedAt } = seedRelay();
      const r = archiveRelayDir(383, {
        phase: "exec",
        startedAt,
        messageCount: 2,
        worktreePath: worktree,
        archiveCwd: cwd,
        endedAt: "2026-05-13T10:30:00Z",
      });
      const raw = fs.readFileSync(
        path.join(r.archivePath!, "meta.json"),
        "utf-8",
      );
      const parsed = RelayArchiveMetaSchema.parse(JSON.parse(raw));
      expect(parsed.issue).toBe(383);
      expect(parsed.phase).toBe("exec");
      expect(parsed.startedAt).toBe(startedAt);
      expect(parsed.endedAt).toBe("2026-05-13T10:30:00Z");
      expect(parsed.messageCount).toBe(2);
    });
  });

  describe("collisions and recovery", () => {
    it("appends a suffix if archive dir already exists at the same timestamp", () => {
      const { startedAt } = seedRelay();
      const endedAt = "2026-05-13T10:30:00Z";
      const r1 = archiveRelayDir(383, {
        phase: "exec",
        startedAt,
        messageCount: 1,
        worktreePath: worktree,
        archiveCwd: cwd,
        endedAt,
      });
      // Re-seed and archive again to the same timestamp.
      seedRelay();
      const r2 = archiveRelayDir(383, {
        phase: "exec",
        startedAt,
        messageCount: 1,
        worktreePath: worktree,
        archiveCwd: cwd,
        endedAt,
      });
      expect(r1.archivePath).not.toBe(r2.archivePath);
      expect(r2.archivePath).toMatch(/\.2$/);
    });
  });

  describe("listArchives", () => {
    it("returns archives newest first for the given issue", () => {
      const startedAt = "2026-05-13T10:00:00Z";
      seedRelay();
      archiveRelayDir(383, {
        phase: "exec",
        startedAt,
        messageCount: 1,
        worktreePath: worktree,
        archiveCwd: cwd,
        endedAt: "2026-05-13T10:30:00Z",
      });
      seedRelay();
      archiveRelayDir(383, {
        phase: "qa",
        startedAt,
        messageCount: 1,
        worktreePath: worktree,
        archiveCwd: cwd,
        endedAt: "2026-05-13T11:00:00Z",
      });
      const list = listArchives(383, cwd);
      expect(list).toHaveLength(2);
      // 11:00 should be first (reverse-sorted).
      expect(list[0]).toMatch(/11-00-00/);
    });
  });

  describe("tallyMessageCount", () => {
    it("returns the sum of inbox + outbox line counts", () => {
      seedRelay();
      expect(tallyMessageCount(383, { worktreePath: worktree })).toBe(2);
    });

    it("returns 0 when relay dir is missing", () => {
      expect(tallyMessageCount(383, { worktreePath: worktree })).toBe(0);
    });
  });
});
