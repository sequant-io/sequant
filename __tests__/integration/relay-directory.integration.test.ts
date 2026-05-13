// Integration tests for relay directory layout (#383):
// AC-1: per-issue relay directory at <worktree>/.sequant/relay/ (with spec-phase fallback).

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
import { relayDirFor, inboxPathFor } from "../../src/lib/relay/paths.js";
import { appendInboxMessage } from "../../src/lib/relay/writer.js";

const TEST_ROOT = path.join(
  os.tmpdir(),
  `sequant-relay-dir-${process.pid}-${Date.now()}`,
);

describe("Relay Directory — per-issue dir creation", () => {
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

  describe("AC-1: Per-issue relay directory", () => {
    it("creates <worktree>/.sequant/relay/ on relay activation", async () => {
      const result = await activateRelay(383, {
        worktreePath: worktree,
        cwd,
      });
      const expected = path.resolve(worktree, ".sequant", "relay");
      expect(result.relayDir).toBe(expected);
      expect(fs.existsSync(expected)).toBe(true);
      expect(fs.statSync(expected).isDirectory()).toBe(true);
    });

    it("falls back to <cwd>/.sequant/relay/<issue>/ when SEQUANT_WORKTREE unset", () => {
      const dir = relayDirFor(383, { worktreePath: "", cwd });
      expect(dir).toBe(path.resolve(cwd, ".sequant", "relay", "383"));
    });

    it("SEQUANT_WORKTREE env var drives path resolution when no override", () => {
      const prev = process.env.SEQUANT_WORKTREE;
      try {
        process.env.SEQUANT_WORKTREE = worktree;
        const dir = relayDirFor(383, { cwd });
        expect(dir).toBe(path.resolve(worktree, ".sequant", "relay"));
      } finally {
        if (prev === undefined) delete process.env.SEQUANT_WORKTREE;
        else process.env.SEQUANT_WORKTREE = prev;
      }
    });
  });

  describe("idempotent and concurrent activations", () => {
    it("reuses an existing relay dir on re-activation (idempotent)", async () => {
      await activateRelay(383, { worktreePath: worktree, cwd });
      appendInboxMessage(
        383,
        { type: "query", message: "first" },
        { worktreePath: worktree },
      );
      // Second activation should leave the inbox intact.
      await activateRelay(383, { worktreePath: worktree, cwd });
      const text = fs.readFileSync(
        inboxPathFor(383, { worktreePath: worktree }),
        "utf-8",
      );
      expect(text).toContain("first");
    });

    it("uses distinct relay dirs for concurrent issue activations", async () => {
      const wt1 = fs.mkdtempSync(path.join(TEST_ROOT, "wt-a-"));
      const wt2 = fs.mkdtempSync(path.join(TEST_ROOT, "wt-b-"));
      try {
        const [a, b] = await Promise.all([
          activateRelay(383, { worktreePath: wt1, cwd }),
          activateRelay(385, { worktreePath: wt2, cwd }),
        ]);
        expect(a.relayDir).not.toBe(b.relayDir);
        expect(fs.existsSync(a.relayDir)).toBe(true);
        expect(fs.existsSync(b.relayDir)).toBe(true);
        // Both pidfiles exist under the shared cwd.
        expect(
          fs.existsSync(path.join(cwd, ".sequant", "pids", "383.pid")),
        ).toBe(true);
        expect(
          fs.existsSync(path.join(cwd, ".sequant", "pids", "385.pid")),
        ).toBe(true);
        // Cleanup
        await deactivateRelay(383, {
          phase: "exec",
          startedAt: a.startedAt,
          worktreePath: wt1,
          cwd,
        });
        await deactivateRelay(385, {
          phase: "exec",
          startedAt: b.startedAt,
          worktreePath: wt2,
          cwd,
        });
      } finally {
        fs.rmSync(wt1, { recursive: true, force: true });
        fs.rmSync(wt2, { recursive: true, force: true });
      }
    });
  });
});
