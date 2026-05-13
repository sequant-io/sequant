// Integration tests for the PostToolUse relay hook (#383):
// AC-7 (relay-check.sh sourced), AC-8 (test -s fast path), AC-9 (one framing
// block per invocation, timestamp ordered).

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RELAY_CHECK = path.resolve("templates/hooks/relay-check.sh");
const POST_TOOL = path.resolve("templates/hooks/post-tool.sh");
const FRAME = path.resolve("templates/relay/frame.txt");

const TEST_ROOT = path.join(
  os.tmpdir(),
  `sequant-relay-hook-${process.pid}-${Date.now()}`,
);

function runHook(env: Record<string, string>): {
  stdout: string;
  status: number | null;
} {
  const r = spawnSync("bash", ["-c", `source ${JSON.stringify(RELAY_CHECK)}`], {
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
  return { stdout: r.stdout ?? "", status: r.status };
}

function writeInbox(dir: string, messages: object[]): void {
  fs.mkdirSync(dir, { recursive: true });
  const text = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
  fs.writeFileSync(path.join(dir, "inbox.jsonl"), text);
}

describe("Relay Hook — PostToolUse integration", () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  let worktree: string;
  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(TEST_ROOT, "wt-"));
  });
  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  describe("AC-7: relay-check.sh sourced from post-tool.sh", () => {
    it("renders frame when SEQUANT_RELAY=true and inbox non-empty", () => {
      writeInbox(path.join(worktree, ".sequant", "relay"), [
        {
          id: "msg_0000aaaa",
          timestamp: "2026-05-13T10:00:00Z",
          type: "query",
          message: "status?",
        },
      ]);
      const r = runHook({
        SEQUANT_RELAY: "true",
        SEQUANT_WORKTREE: worktree,
        SEQUANT_RELAY_FRAME: FRAME,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("[SEQUANT RELAY — message from user]");
    });

    it("does NOT render when SEQUANT_RELAY is unset", () => {
      writeInbox(path.join(worktree, ".sequant", "relay"), [
        {
          id: "msg_0000aaaa",
          timestamp: "2026-05-13T10:00:00Z",
          type: "query",
          message: "x",
        },
      ]);
      const r = runHook({ SEQUANT_WORKTREE: worktree });
      expect(r.stdout).toBe("");
    });

    it("post-tool.sh contains the relay-check sourcing guard", () => {
      const text = fs.readFileSync(POST_TOOL, "utf-8");
      expect(text).toContain("relay-check.sh");
      expect(text).toMatch(/SEQUANT_RELAY/);
    });
  });

  describe("AC-8: test -s fast path on empty inbox", () => {
    it("emits no frame when inbox.jsonl is zero bytes", () => {
      const dir = path.join(worktree, ".sequant", "relay");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "inbox.jsonl"), "");
      const r = runHook({
        SEQUANT_RELAY: "true",
        SEQUANT_WORKTREE: worktree,
        SEQUANT_RELAY_FRAME: FRAME,
      });
      expect(r.stdout).toBe("");
    });

    it("emits no frame when inbox.jsonl does not exist", () => {
      fs.mkdirSync(path.join(worktree, ".sequant", "relay"), {
        recursive: true,
      });
      const r = runHook({
        SEQUANT_RELAY: "true",
        SEQUANT_WORKTREE: worktree,
      });
      expect(r.stdout).toBe("");
    });

    it("relay-check.sh uses `test -s` to guard before parsing", () => {
      const text = fs.readFileSync(RELAY_CHECK, "utf-8");
      expect(text).toMatch(/\[\[ -s/);
    });
  });

  describe("AC-9: One framing block per invocation, timestamp-ordered", () => {
    it("renders a single [SEQUANT RELAY] block containing all unread messages", () => {
      const dir = path.join(worktree, ".sequant", "relay");
      writeInbox(dir, [
        {
          id: "msg_a1",
          timestamp: "2026-05-13T10:00:00Z",
          type: "query",
          message: "alpha",
        },
        {
          id: "msg_b2",
          timestamp: "2026-05-13T10:01:00Z",
          type: "directive",
          message: "bravo",
        },
        {
          id: "msg_c3",
          timestamp: "2026-05-13T10:02:00Z",
          type: "query",
          message: "charlie",
        },
      ]);
      const r = runHook({
        SEQUANT_RELAY: "true",
        SEQUANT_WORKTREE: worktree,
        SEQUANT_RELAY_FRAME: FRAME,
      });
      const headerCount = (
        r.stdout.match(/\[SEQUANT RELAY — message from user\]/g) ?? []
      ).length;
      expect(headerCount).toBe(1);
      expect(r.stdout).toContain("alpha");
      expect(r.stdout).toContain("bravo");
      expect(r.stdout).toContain("charlie");
    });

    it("advances the cursor past all messages included in the frame", () => {
      const dir = path.join(worktree, ".sequant", "relay");
      writeInbox(dir, [
        {
          id: "msg_a1",
          timestamp: "2026-05-13T10:00:00Z",
          type: "query",
          message: "alpha",
        },
        {
          id: "msg_b2",
          timestamp: "2026-05-13T10:01:00Z",
          type: "query",
          message: "bravo",
        },
      ]);
      runHook({
        SEQUANT_RELAY: "true",
        SEQUANT_WORKTREE: worktree,
        SEQUANT_RELAY_FRAME: FRAME,
      });
      const cursorPath = path.join(dir, ".cursor");
      expect(fs.existsSync(cursorPath)).toBe(true);
      const cursor = fs.readFileSync(cursorPath, "utf-8").trim();
      expect(Number.parseInt(cursor, 10)).toBe(2);
    });

    it("second invocation with no new messages emits nothing", () => {
      const dir = path.join(worktree, ".sequant", "relay");
      writeInbox(dir, [
        {
          id: "msg_a1",
          timestamp: "2026-05-13T10:00:00Z",
          type: "query",
          message: "first",
        },
      ]);
      const env = {
        SEQUANT_RELAY: "true",
        SEQUANT_WORKTREE: worktree,
        SEQUANT_RELAY_FRAME: FRAME,
      };
      runHook(env);
      const r2 = runHook(env);
      expect(r2.stdout).toBe("");
    });
  });
});
