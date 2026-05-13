// Tests for relay hook env-var behavior (#383):
// AC-12 (opt-in SEQUANT_RELAY=true), AC-13 (back-compat when unset).
//
// These tests invoke the relay-check.sh script directly with controlled env
// vars and observe stdout. We avoid invoking post-tool.sh end-to-end because
// it depends on Claude Code stdin format — the relay slice is what we own.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RELAY_HOOK = path.resolve("templates/hooks/relay-check.sh");
const POST_TOOL = path.resolve("templates/hooks/post-tool.sh");

function makeTmpWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-hook-env-"));
}

function runRelayHook(env: Record<string, string>): {
  stdout: string;
  status: number | null;
} {
  // Source the script in a subshell so `return 0` paths exit cleanly.
  const result = spawnSync(
    "bash",
    ["-c", `source ${JSON.stringify(RELAY_HOOK)}`],
    {
      env: { ...process.env, ...env },
      encoding: "utf-8",
    },
  );
  return { stdout: result.stdout ?? "", status: result.status };
}

describe("Relay Hook — opt-in env var behavior", () => {
  let worktree: string;
  beforeEach(() => {
    worktree = makeTmpWorktree();
  });
  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  describe("AC-12: SEQUANT_RELAY controls activation", () => {
    it("exits silently when SEQUANT_RELAY is unset", () => {
      const r = runRelayHook({ SEQUANT_WORKTREE: worktree });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    });

    it("exits silently when SEQUANT_RELAY=false", () => {
      const r = runRelayHook({
        SEQUANT_RELAY: "false",
        SEQUANT_WORKTREE: worktree,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    });

    it("exits silently when SEQUANT_RELAY=true but no inbox exists", () => {
      const r = runRelayHook({
        SEQUANT_RELAY: "true",
        SEQUANT_WORKTREE: worktree,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    });

    it("emits a frame to stdout when SEQUANT_RELAY=true and inbox is non-empty", () => {
      const relayDir = path.join(worktree, ".sequant", "relay");
      fs.mkdirSync(relayDir, { recursive: true });
      const msg = {
        id: "msg_deadbeef",
        timestamp: "2026-05-13T10:00:00Z",
        type: "query",
        message: "status?",
      };
      fs.writeFileSync(
        path.join(relayDir, "inbox.jsonl"),
        JSON.stringify(msg) + "\n",
      );
      const r = runRelayHook({
        SEQUANT_RELAY: "true",
        SEQUANT_WORKTREE: worktree,
        SEQUANT_RELAY_FRAME: path.resolve("templates/relay/frame.txt"),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("[SEQUANT RELAY — message from user]");
      expect(r.stdout).toContain("Type: query");
    });

    it("respects the cursor and only emits new messages", () => {
      const relayDir = path.join(worktree, ".sequant", "relay");
      fs.mkdirSync(relayDir, { recursive: true });
      const msg = {
        id: "msg_deadbeef",
        timestamp: "2026-05-13T10:00:00Z",
        type: "query",
        message: "old",
      };
      fs.writeFileSync(
        path.join(relayDir, "inbox.jsonl"),
        JSON.stringify(msg) + "\n",
      );
      // Cursor already past the only line.
      fs.writeFileSync(path.join(relayDir, ".cursor"), "1");
      const r = runRelayHook({
        SEQUANT_RELAY: "true",
        SEQUANT_WORKTREE: worktree,
        SEQUANT_RELAY_FRAME: path.resolve("templates/relay/frame.txt"),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    });

    it("falls back to spec-phase path when SEQUANT_WORKTREE is unset but SEQUANT_ISSUE is set", () => {
      const cwd = makeTmpWorktree();
      try {
        const relayDir = path.join(cwd, ".sequant", "relay", "383");
        fs.mkdirSync(relayDir, { recursive: true });
        const msg = {
          id: "msg_aaaa1111",
          timestamp: "2026-05-13T10:00:00Z",
          type: "query",
          message: "spec phase",
        };
        fs.writeFileSync(
          path.join(relayDir, "inbox.jsonl"),
          JSON.stringify(msg) + "\n",
        );
        const result = spawnSync(
          "bash",
          [
            "-c",
            `cd ${JSON.stringify(cwd)} && source ${JSON.stringify(RELAY_HOOK)}`,
          ],
          {
            env: {
              ...process.env,
              SEQUANT_RELAY: "true",
              SEQUANT_ISSUE: "383",
              SEQUANT_WORKTREE: "",
              SEQUANT_RELAY_FRAME: path.resolve("templates/relay/frame.txt"),
            },
            encoding: "utf-8",
          },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("spec phase");
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe("AC-13: post-tool.sh remains correct with relay unset", () => {
    it("post-tool.sh sources relay-check.sh only when SEQUANT_RELAY=true", () => {
      // Static check: ensure the wrapper guards on the env var.
      const text = fs.readFileSync(POST_TOOL, "utf-8");
      expect(text).toMatch(/\$\{SEQUANT_RELAY:-\}.*==\s*"true"/);
      expect(text).toContain("source");
    });

    it("relay-check.sh starts with an early-exit when SEQUANT_RELAY is not 'true'", () => {
      const text = fs.readFileSync(RELAY_HOOK, "utf-8");
      // First non-comment, non-blank line of substance must early-exit.
      expect(text).toMatch(/SEQUANT_RELAY.*!= ?"true"/);
    });
  });
});
