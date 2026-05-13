// Integration tests for the relay activation/deactivation lifecycle (#383):
// AC-23 (multiple concurrent runs preserved),
// AC-25 (state updated on activate/deactivate),
// AC-D3 (SIGKILL'd run cleanup).

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
  activateRelay,
  deactivateRelay,
} from "../../src/lib/relay/activation.js";
import { StateManager } from "../../src/lib/workflow/state-manager.js";
import {
  appendInboxMessage,
  appendOutboxReply,
} from "../../src/lib/relay/writer.js";
import { readPidFile, cleanupStalePid } from "../../src/lib/relay/pid.js";
import { inboxPathFor, pidPathFor } from "../../src/lib/relay/paths.js";

const TEST_ROOT = path.join(
  os.tmpdir(),
  `sequant-relay-lifecycle-${process.pid}-${Date.now()}`,
);

describe("Relay Lifecycle — activation, deactivation, concurrent runs", () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  let worktreeA: string;
  let worktreeB: string;
  let cwd: string;
  let sm: StateManager;

  beforeEach(() => {
    worktreeA = fs.mkdtempSync(path.join(TEST_ROOT, "wt-a-"));
    worktreeB = fs.mkdtempSync(path.join(TEST_ROOT, "wt-b-"));
    cwd = fs.mkdtempSync(path.join(TEST_ROOT, "cwd-"));
    sm = new StateManager({
      statePath: path.join(cwd, ".sequant", "state.json"),
    });
  });
  afterEach(() => {
    for (const d of [worktreeA, worktreeB, cwd]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  describe("AC-23: Multiple concurrent runs preserved", () => {
    it("two runs activating relay get distinct dirs and pidfiles", async () => {
      await sm.initializeIssue(383, "issue-a", { worktree: worktreeA });
      await sm.initializeIssue(385, "issue-b", { worktree: worktreeB });
      const [a, b] = await Promise.all([
        activateRelay(383, {
          worktreePath: worktreeA,
          cwd,
          stateManager: sm,
          pid: 11111,
        }),
        activateRelay(385, {
          worktreePath: worktreeB,
          cwd,
          stateManager: sm,
          pid: 22222,
        }),
      ]);
      expect(a.relayDir).not.toBe(b.relayDir);
      expect(readPidFile(383, cwd)).toBe(11111);
      expect(readPidFile(385, cwd)).toBe(22222);
    });

    it("a message to #383 does not appear in the #385 inbox", () => {
      fs.mkdirSync(path.join(worktreeA, ".sequant", "relay"), {
        recursive: true,
      });
      fs.mkdirSync(path.join(worktreeB, ".sequant", "relay"), {
        recursive: true,
      });
      appendInboxMessage(
        383,
        { type: "query", message: "for 383" },
        { worktreePath: worktreeA },
      );
      const inboxB = inboxPathFor(385, { worktreePath: worktreeB });
      expect(fs.existsSync(inboxB)).toBe(false);
    });
  });

  describe("AC-25: State updated on activation/deactivation", () => {
    it("writes IssueState.relay on activate", async () => {
      await sm.initializeIssue(383, "issue-a", { worktree: worktreeA });
      const result = await activateRelay(383, {
        worktreePath: worktreeA,
        cwd,
        stateManager: sm,
        pid: 33333,
      });
      const issue = await sm.getIssueState(383);
      expect(issue?.relay).toBeDefined();
      expect(issue?.relay?.enabled).toBe(true);
      expect(issue?.relay?.pid).toBe(33333);
      expect(issue?.relay?.startedAt).toBe(result.startedAt);
      expect(issue?.relay?.messageCount).toBe(0);
    });

    it("clears IssueState.relay on deactivate", async () => {
      await sm.initializeIssue(383, "issue-a", { worktree: worktreeA });
      const a = await activateRelay(383, {
        worktreePath: worktreeA,
        cwd,
        stateManager: sm,
      });
      // Seed at least one message so the archive has content.
      appendInboxMessage(
        383,
        { type: "query", message: "hi" },
        { worktreePath: worktreeA },
      );
      await deactivateRelay(383, {
        phase: "exec",
        startedAt: a.startedAt,
        worktreePath: worktreeA,
        cwd,
        stateManager: sm,
      });
      const issue = await sm.getIssueState(383);
      expect(issue?.relay).toBeUndefined();
    });

    it("increments messageCount on incrementRelayMessageCount", async () => {
      await sm.initializeIssue(383, "issue-a", { worktree: worktreeA });
      await activateRelay(383, {
        worktreePath: worktreeA,
        cwd,
        stateManager: sm,
      });
      await sm.incrementRelayMessageCount(383, 1);
      await sm.incrementRelayMessageCount(383, 2);
      const issue = await sm.getIssueState(383);
      expect(issue?.relay?.messageCount).toBe(3);
    });
  });

  describe("AC-D3: SIGKILL'd run cleaned by next prompt", () => {
    it("cleanupStalePid removes pidfile when PID is dead", async () => {
      await sm.initializeIssue(383, "issue-a", { worktree: worktreeA });
      // Use an obviously dead PID.
      await activateRelay(383, {
        worktreePath: worktreeA,
        cwd,
        stateManager: sm,
        pid: 0x7fffffff,
      });
      expect(fs.existsSync(pidPathFor(383, cwd))).toBe(true);
      const r = cleanupStalePid(383, { cwd });
      expect(r.cleaned).toBe(true);
      expect(r.warning).toMatch(/no longer active/);
      expect(fs.existsSync(pidPathFor(383, cwd))).toBe(false);
    });
  });

  describe("error scenarios", () => {
    it("recovers when state has no relay field on read (legacy)", async () => {
      await sm.initializeIssue(383, "legacy-issue", { worktree: worktreeA });
      // Don't call activateRelay — relay field stays undefined.
      const issue = await sm.getIssueState(383);
      expect(issue?.relay).toBeUndefined();
      // Incrementing is a no-op (does not throw).
      await sm.incrementRelayMessageCount(383, 1);
      const after = await sm.getIssueState(383);
      expect(after?.relay).toBeUndefined();
    });
  });

  it("idempotent deactivation: second call is a no-op", async () => {
    await sm.initializeIssue(383, "issue-a", { worktree: worktreeA });
    const a = await activateRelay(383, {
      worktreePath: worktreeA,
      cwd,
      stateManager: sm,
    });
    await deactivateRelay(383, {
      phase: "exec",
      startedAt: a.startedAt,
      worktreePath: worktreeA,
      cwd,
      stateManager: sm,
    });
    // Second deactivation: relay dir gone, returns archived: false but no throw.
    const r = await deactivateRelay(383, {
      phase: "exec",
      startedAt: a.startedAt,
      worktreePath: worktreeA,
      cwd,
      stateManager: sm,
    });
    expect(r.archived).toBe(false);
  });
});
