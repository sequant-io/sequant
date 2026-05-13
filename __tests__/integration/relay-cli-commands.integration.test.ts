// Integration tests for relay CLI commands (#383):
// AC-17 (sequant prompt writes inbox + confirms),
// AC-18 (sequant watch tails outbox), AC-19 (sequant status).
//
// We exercise the in-process command functions (promptCommand, watchCommand)
// rather than spawning the CLI subprocess, to keep tests fast and deterministic.

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promptCommand } from "../../src/commands/prompt.js";
import { watchCommand } from "../../src/commands/watch.js";
import { StateManager } from "../../src/lib/workflow/state-manager.js";
import { activateRelay } from "../../src/lib/relay/activation.js";
import { appendOutboxReply } from "../../src/lib/relay/writer.js";
import { inboxPathFor } from "../../src/lib/relay/paths.js";

const TEST_ROOT = path.join(
  os.tmpdir(),
  `sequant-relay-cli-${process.pid}-${Date.now()}`,
);

// Capture repo root before any test changes process.cwd().
const REPO_ROOT = process.cwd();

describe("Relay CLI Commands — end-to-end (in-process)", () => {
  let worktree: string;
  let cwd: string;
  let prevCwd: string;
  let sm: StateManager;

  beforeAll(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  beforeEach(() => {
    worktree = fs.mkdtempSync(path.join(TEST_ROOT, "wt-"));
    cwd = fs.mkdtempSync(path.join(TEST_ROOT, "cwd-"));
    prevCwd = process.cwd();
    process.chdir(cwd);
    sm = new StateManager({
      statePath: path.join(cwd, ".sequant", "state.json"),
    });
  });
  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('AC-17: `sequant prompt <issue> "<msg>"` writes inbox and confirms', () => {
    it("appends a JSONL line to <worktree>/.sequant/relay/inbox.jsonl", async () => {
      await sm.initializeIssue(383, "issue-a", { worktree });
      // We override the StateManager singleton path via env so the prompt
      // command picks up our fixture state file. Easier: write a fake state.
      const statePath = path.join(cwd, ".sequant", "state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      // Activate relay so the PID liveness check passes against our process.
      await activateRelay(383, {
        worktreePath: worktree,
        cwd,
        stateManager: sm,
      });

      const logged: string[] = [];
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation((m: string) => {
          logged.push(m);
        });
      try {
        await promptCommand({
          args: ["383", "status?"],
          options: { type: "query" },
        });
      } finally {
        logSpy.mockRestore();
      }

      const inboxFile = inboxPathFor(383, { worktreePath: worktree });
      expect(fs.existsSync(inboxFile)).toBe(true);
      const lines = fs.readFileSync(inboxFile, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const msg = JSON.parse(lines[0]);
      expect(msg.message).toBe("status?");
      expect(msg.type).toBe("query");
      // Confirmation
      const combined = logged.join("\n");
      expect(combined).toMatch(/Message sent to #383/);
      void state;
    });

    it("refuses to send when the target run PID is dead", async () => {
      await sm.initializeIssue(383, "issue-a", { worktree });
      // Activate with a dead PID.
      await activateRelay(383, {
        worktreePath: worktree,
        cwd,
        stateManager: sm,
        pid: 0x7fffffff,
      });
      const errs: string[] = [];
      const errSpy = vi
        .spyOn(console, "error")
        .mockImplementation((m: string) => {
          errs.push(m);
        });
      try {
        await promptCommand({
          args: ["383", "status?"],
          options: { type: "query" },
        });
      } finally {
        errSpy.mockRestore();
      }
      expect(errs.join("\n")).toMatch(/no longer active/);
      expect(process.exitCode).toBe(1);
      // Reset to avoid bleeding into other tests.
      process.exitCode = 0;
      // Inbox should be empty (no write to dead session).
      const inboxFile = inboxPathFor(383, { worktreePath: worktree });
      expect(fs.existsSync(inboxFile)).toBe(false);
    });

    it("emits JSON when --json is set", async () => {
      await sm.initializeIssue(383, "issue-a", { worktree });
      await activateRelay(383, {
        worktreePath: worktree,
        cwd,
        stateManager: sm,
      });
      const logged: string[] = [];
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation((m: string) => {
          logged.push(m);
        });
      try {
        await promptCommand({
          args: ["383", "hi"],
          options: { type: "query", json: true },
        });
      } finally {
        logSpy.mockRestore();
      }
      const out = JSON.parse(logged.join(""));
      expect(out.ok).toBe(true);
      expect(out.issue).toBe(383);
      expect(out.type).toBe("query");
      expect(out.messageId).toMatch(/^msg_/);
    });
  });

  describe("AC-18: `sequant watch <issue>` tails the outbox", () => {
    it("streams new outbox entries to stdout", async () => {
      await sm.initializeIssue(383, "issue-a", { worktree });
      await activateRelay(383, {
        worktreePath: worktree,
        cwd,
        stateManager: sm,
      });

      const lines: string[] = [];
      const logSpy = vi
        .spyOn(console, "log")
        .mockImplementation((m: string) => {
          lines.push(m);
        });
      const controller = new AbortController();
      const runP = watchCommand({
        args: ["383"],
        options: { signal: controller.signal, pollIntervalMs: 30, json: true },
      });
      // Wait one tick so watch seeds the offset, then append.
      await new Promise((r) => setTimeout(r, 80));
      appendOutboxReply(
        383,
        { inReplyTo: "msg_deadbeef", message: "live reply" },
        { worktreePath: worktree },
      );
      await new Promise((r) => setTimeout(r, 200));
      controller.abort();
      await runP;
      logSpy.mockRestore();
      const found = lines.find((l) => l.includes("live reply"));
      expect(found).toBeDefined();
    });
  });

  describe("AC-19: `sequant status` includes relay column (smoke)", () => {
    it("status.ts module declares a Relay column", () => {
      const text = fs.readFileSync(
        path.join(REPO_ROOT, "src/commands/status.ts"),
        "utf-8",
      );
      expect(text).toMatch(/Relay/);
      expect(text).toMatch(/relay\?\.enabled/);
    });
  });
});
