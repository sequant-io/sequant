/**
 * Fixture tests for cwd-bound resume semantics (#674, AC-8).
 *
 * Per-behavior status is annotated as one of:
 *   - PRESERVED — assertion is the source of truth; failure means a behavior change.
 *   - ADVISORY  — behavior is correct now but not load-bearing for this PR.
 *   - SKIPPED   — gated on another issue (none remain).
 *
 * The annotations make harness drift visible: if a SKIPPED test is converted
 * to PRESERVED without the issue it was gated on landing, that's a review
 * signal. The two CodexDriver placeholders were converted when #497's driver
 * node landed — legitimately, and only for the behaviour that node implements.
 * The second one had proposed AGENTS.md stack parity as a resume precondition;
 * #497's probe superseded that, so it became the ADVISORY below rather than an
 * assertion about code that does not exist.
 */

import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeDriver } from "./claude-code.js";
import { AiderDriver } from "./aider.js";
import { OpencodeDriver, buildOpencodeArgs } from "./opencode.js";
import { CodexDriver, buildCodexArgs } from "./codex.js";
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

  describe("opencode resume semantics (#862 AC-6)", () => {
    // PRESERVED — opencode sessions replay against a working directory, so a
    // handle from another cwd would run recorded state against the wrong tree.
    it("opencode accepts its own handle from the originating cwd", () => {
      const driver = new OpencodeDriver();
      expect(
        driver.canResume(makeHandle("opencode", WORKTREE_A), WORKTREE_A),
      ).toBe(true);
    });

    // PRESERVED — the #674 originCwd binding.
    it("opencode rejects its own handle from a different cwd", () => {
      const driver = new OpencodeDriver();
      expect(
        driver.canResume(makeHandle("opencode", WORKTREE_A), WORKTREE_B),
      ).toBe(false);
    });

    // PRESERVED — the #674 driver tag.
    it("opencode rejects a foreign-driver handle even from the same cwd", () => {
      const driver = new OpencodeDriver();
      expect(
        driver.canResume(makeHandle("claude-code", WORKTREE_A), WORKTREE_A),
      ).toBe(false);
      expect(
        driver.canResume(makeHandle("aider", WORKTREE_A), WORKTREE_A),
      ).toBe(false);
    });

    // PRESERVED — an eligible handle becomes `--session <token>` on the spawn.
    it("opencode turns an eligible handle into --session <token>", () => {
      const args = buildOpencodeArgs(
        "/qa 862",
        { cwd: WORKTREE_A, phase: "qa" },
        undefined,
        makeHandle("opencode", WORKTREE_A).token,
      );
      expect(args).toEqual(
        expect.arrayContaining(["--session", "session-token-xyz"]),
      );
    });

    // PRESERVED — an ineligible handle contributes no resume flag.
    it("opencode omits --session when no token is eligible", () => {
      const args = buildOpencodeArgs("/qa 862", {
        cwd: WORKTREE_A,
        phase: "qa",
      });
      expect(args).not.toContain("--session");
    });
  });

  describe("codex resume semantics (#497 AC-4)", () => {
    // PRESERVED — the #674 originCwd binding, and the only guard that exists.
    // `codex exec resume` accepts no `-C` and silently adopts the caller's cwd
    // (openai/codex#4791), so nothing upstream refuses a cross-worktree
    // resume; this check is the whole defence.
    it("codex rejects its own handle from a different cwd", () => {
      const driver = new CodexDriver();
      expect(
        driver.canResume(makeHandle("codex", WORKTREE_A), WORKTREE_B),
      ).toBe(false);
    });

    // PRESERVED — same-cwd handle is accepted.
    it("codex accepts its own handle from the originating cwd", () => {
      const driver = new CodexDriver();
      expect(
        driver.canResume(makeHandle("codex", WORKTREE_A), WORKTREE_A),
      ).toBe(true);
    });

    // PRESERVED — the #674 driver tag.
    it("codex rejects a foreign-driver handle even from the same cwd", () => {
      const driver = new CodexDriver();
      expect(
        driver.canResume(makeHandle("claude-code", WORKTREE_A), WORKTREE_A),
      ).toBe(false);
      expect(
        driver.canResume(makeHandle("opencode", WORKTREE_A), WORKTREE_A),
      ).toBe(false);
    });

    // PRESERVED — an eligible handle becomes `exec resume <token>` and,
    // critically, drops `-C`: `exec resume` does not accept it.
    it("codex turns an eligible handle into exec resume <token> with no -C", () => {
      const args = buildCodexArgs(
        "$qa 497",
        { cwd: WORKTREE_A, phase: "qa" },
        undefined,
        makeHandle("codex", WORKTREE_A).token,
      );
      expect(args.slice(0, 4)).toEqual([
        "exec",
        "resume",
        "session-token-xyz",
        "--json",
      ]);
      expect(args).toContain("--dangerously-bypass-hook-trust");
      expect(args).not.toContain("-C");
      expect(args).not.toContain(WORKTREE_A);
    });

    // PRESERVED — an ineligible handle contributes no resume subcommand.
    it("codex omits the resume subcommand when no token is eligible", () => {
      const args = buildCodexArgs("$qa 497", {
        cwd: WORKTREE_A,
        phase: "qa",
      });
      expect(args).not.toContain("resume");
      expect(args.slice(0, 4)).toEqual(["exec", "--json", "-C", WORKTREE_A]);
    });

    // PRESERVED — the round trip: a handle shaped as the driver emits one is
    // accepted back for the same cwd and dispatches as a resume. That the
    // driver really emits this shape off a live stream is asserted against the
    // recorded fixture in codex.test.ts ("surfaces the fixture's thread id as
    // a cwd-bound resumeHandle"); this file mocks only the Claude SDK, so
    // spawning a driver here would run the real codex binary.
    it("codex round-trips an emitted handle back into a resume dispatch", () => {
      const driver = new CodexDriver();
      const emitted: ResumeHandle = {
        driver: driver.name,
        token: "01a09759-a395-71f1-8082-2877a06a36fc",
        originCwd: WORKTREE_A,
      };

      expect(driver.canResume(emitted, WORKTREE_A)).toBe(true);
      expect(
        buildCodexArgs(
          "$qa 497",
          { cwd: WORKTREE_A, phase: "qa" },
          undefined,
          emitted.token,
        ).slice(0, 3),
      ).toEqual(["exec", "resume", emitted.token]);
    });

    // ADVISORY — records a decision, not a behaviour: the #674-era placeholder
    // here proposed AGENTS.md stack parity as a second resume precondition.
    // The #497 probe superseded that — it found cwd adoption to be the actual
    // failure mode and named originCwd equality "the only guard [that] stays
    // mandatory". No AGENTS.md check exists, deliberately; this asserts that
    // resume is gated on the cwd alone so a future reader does not mistake the
    // absence for an oversight.
    it("codex gates resume on originCwd alone, with no AGENTS.md precondition", () => {
      const driver = new CodexDriver();
      // Same cwd, same driver — accepted with no other precondition consulted.
      expect(
        driver.canResume(makeHandle("codex", WORKTREE_A), WORKTREE_A),
      ).toBe(true);
      // Differing only in cwd flips it, which is the whole decision surface.
      expect(
        driver.canResume(makeHandle("codex", WORKTREE_A), WORKTREE_B),
      ).toBe(false);
    });
  });
});
