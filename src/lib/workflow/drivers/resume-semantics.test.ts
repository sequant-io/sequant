/**
 * Fixture tests for cwd-bound resume semantics (#674, AC-8).
 *
 * Per-behavior status is annotated as one of:
 *   - PRESERVED — assertion is the source of truth; failure means a behavior change.
 *   - ADVISORY  — behavior is correct now but not load-bearing for this PR.
 *   - SKIPPED   — gated on another issue (e.g. #497 CodexDriver landing).
 *
 * The annotations make harness drift visible: if a SKIPPED test is converted
 * to PRESERVED without #497 landing, that's a review signal.
 */

import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeDriver } from "./claude-code.js";
import { AiderDriver } from "./aider.js";
import type { ResumeHandle } from "./agent-driver.js";

// Mock the SDK so we can inspect the options passed to query() without
// actually invoking Claude. The mock is async-generator-shaped so the
// `for await` in ClaudeCodeDriver.executePhase iterates a single emit
// (a synthetic init message + a success result) and returns.
const queryCalls: Array<{ options: { resume?: string; cwd: string } }> = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn((args: { options: { resume?: string; cwd: string } }) => {
    queryCalls.push({ options: args.options });
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "system",
          subtype: "init",
          session_id: "synthetic-session-id",
        };
        yield {
          type: "result",
          subtype: "success",
        };
      },
    };
  }),
}));

const WORKTREE_A = "/tmp/fixture/worktree-a";
const WORKTREE_B = "/tmp/fixture/worktree-b";

function makeHandle(driver: string, originCwd: string): ResumeHandle {
  return { driver, token: "session-token-xyz", originCwd };
}

function makeConfig(cwd: string, resumeHandle?: ResumeHandle) {
  return {
    cwd,
    env: {},
    phaseTimeout: 60,
    verbose: false,
    mcp: false,
    resumeHandle,
  };
}

describe("Resume semantics fixture (#674, AC-8)", () => {
  describe("ClaudeCodeDriver.canResume", () => {
    // PRESERVED — same-cwd handle is accepted (AC-2, AC-4).
    it("accepts a handle whose originCwd === targetCwd", () => {
      const driver = new ClaudeCodeDriver();
      const handle = makeHandle("claude-code", WORKTREE_A);
      expect(driver.canResume(handle, WORKTREE_A)).toBe(true);
    });

    // PRESERVED — cross-worktree handle is rejected (AC-4, AC-8 core).
    it("rejects a handle whose originCwd !== targetCwd", () => {
      const driver = new ClaudeCodeDriver();
      const handle = makeHandle("claude-code", WORKTREE_A);
      expect(driver.canResume(handle, WORKTREE_B)).toBe(false);
    });

    // PRESERVED — cross-driver handle is rejected (AC-1 boundary).
    it("rejects a handle from a different driver", () => {
      const driver = new ClaudeCodeDriver();
      const handle = makeHandle("codex", WORKTREE_A);
      expect(driver.canResume(handle, WORKTREE_A)).toBe(false);
    });

    // ADVISORY — byte-equal comparison (not normalized). Keeps storage-key
    // parity with the SDK's `~/.claude/projects/<encoded-cwd>/` namespacing.
    it("uses byte-equal comparison, not normalized paths", () => {
      const driver = new ClaudeCodeDriver();
      const handle = makeHandle("claude-code", "/tmp/foo");
      // Trailing slash makes the strings different — must be rejected.
      expect(driver.canResume(handle, "/tmp/foo/")).toBe(false);
    });
  });

  describe("ClaudeCodeDriver.executePhase (resume gating)", () => {
    // PRESERVED — same-cwd resume passes the token through (AC-6).
    it("passes resume token when handle.originCwd === config.cwd", async () => {
      queryCalls.length = 0;
      const driver = new ClaudeCodeDriver();
      const handle = makeHandle("claude-code", WORKTREE_A);

      await driver.executePhase("prompt", makeConfig(WORKTREE_A, handle));

      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].options.resume).toBe(handle.token);
      expect(queryCalls[0].options.cwd).toBe(WORKTREE_A);
    });

    // PRESERVED — cross-cwd handle triggers transparent fallback (AC-4):
    // no `resume:` is passed, fresh session is started. The SDK's recoverable
    // `error_during_execution` ("No conversation found", verified #674) is
    // avoided by design.
    it("drops resume silently when handle.originCwd !== config.cwd", async () => {
      queryCalls.length = 0;
      const driver = new ClaudeCodeDriver();
      const handle = makeHandle("claude-code", WORKTREE_A);

      await driver.executePhase("prompt", makeConfig(WORKTREE_B, handle));

      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].options.resume).toBeUndefined();
      expect(queryCalls[0].options.cwd).toBe(WORKTREE_B);
    });

    // PRESERVED — legacy bare sessionId without a handle does NOT resume.
    // Fail-safe: cwd parity can't be proven, so we never attempt resume
    // (avoids the SDK's "No conversation found" failure mode).
    it("does not resume on legacy sessionId-only config", async () => {
      queryCalls.length = 0;
      const driver = new ClaudeCodeDriver();

      await driver.executePhase("prompt", {
        ...makeConfig(WORKTREE_A),
        sessionId: "legacy-token-without-origin",
      });

      expect(queryCalls).toHaveLength(1);
      expect(queryCalls[0].options.resume).toBeUndefined();
    });

    // PRESERVED — successful result carries a driver-tagged resume handle
    // (AC-1, AC-2): driver name, token, and config.cwd as originCwd.
    it("returns a resumeHandle bound to config.cwd on success", async () => {
      queryCalls.length = 0;
      const driver = new ClaudeCodeDriver();

      const result = await driver.executePhase(
        "prompt",
        makeConfig(WORKTREE_A),
      );

      expect(result.success).toBe(true);
      expect(result.resumeHandle).toBeDefined();
      expect(result.resumeHandle).toEqual({
        driver: "claude-code",
        token: "synthetic-session-id",
        originCwd: WORKTREE_A,
      });
      // sessionId mirror retained for one-release deprecation (#674).
      expect(result.sessionId).toBe("synthetic-session-id");
    });
  });

  describe("AiderDriver.canResume", () => {
    // PRESERVED — Aider has no session-resume concept; declines unconditionally.
    it("always returns false", () => {
      const driver = new AiderDriver();
      const handle = makeHandle("aider", WORKTREE_A);
      expect(driver.canResume(handle, WORKTREE_A)).toBe(false);
    });

    // PRESERVED — cross-driver handles are also rejected (defensive).
    it("returns false for foreign-driver handles", () => {
      const driver = new AiderDriver();
      const handle = makeHandle("claude-code", WORKTREE_A);
      expect(driver.canResume(handle, WORKTREE_A)).toBe(false);
    });
  });

  describe("CodexDriver (deferred to #497)", () => {
    // SKIPPED — CodexDriver does not exist yet. When #497 lands, drop `.skip`
    // and assert: cross-worktree resume is refused (Codex SDK is cwd-
    // independent so the driver must enforce); AGENTS.md parity is a
    // precondition for resume.
    it.skip("rejects cross-worktree resume (gated on #497)", () => {
      // Intentionally empty — see #497 for the implementation.
    });

    // SKIPPED — see #497.
    it.skip("requires AGENTS.md stack parity (gated on #497)", () => {
      // Intentionally empty — see #497 for the implementation.
    });
  });
});
