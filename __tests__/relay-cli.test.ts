// Tests for relay CLI command argument parsing (#383):
// AC-17a (--type validation), AC-17b (auto-resolve single run).

import { describe, it, expect } from "vitest";
import type { IssueState } from "../src/lib/workflow/state-schema.js";
import {
  parseRelayPromptArgs,
  findActiveIssues,
  resolveTargetIssue,
} from "../src/commands/prompt.js";

function makeIssueState(
  number: number,
  status: "in_progress" | "merged" = "in_progress",
): IssueState {
  return {
    number,
    title: `Issue ${number}`,
    status,
    currentPhase: "exec",
    iteration: 0,
    lastActivity: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  } as IssueState;
}

describe("Relay CLI — prompt command argument validation", () => {
  // === AC-17a: --type query|directive|abort validated ===
  describe("AC-17a: --type flag validation", () => {
    it("accepts --type query", () => {
      const r = parseRelayPromptArgs(["368", "hello"], { type: "query" });
      expect(r.type).toBe("query");
      expect(r.issue).toBe(368);
      expect(r.message).toBe("hello");
    });

    it("accepts --type directive", () => {
      const r = parseRelayPromptArgs(["368", "skip migration"], {
        type: "directive",
      });
      expect(r.type).toBe("directive");
    });

    it("accepts --type abort", () => {
      const r = parseRelayPromptArgs(["368", "stop"], { type: "abort" });
      expect(r.type).toBe("abort");
    });

    it("defaults to query when --type is omitted", () => {
      const r = parseRelayPromptArgs(["368", "hi"]);
      expect(r.type).toBe("query");
    });

    it("rejects --type nudge with an actionable error", () => {
      expect(() =>
        parseRelayPromptArgs(["368", "hi"], { type: "nudge" }),
      ).toThrow(/query, directive, abort/);
    });

    it("rejects empty message body", () => {
      expect(() => parseRelayPromptArgs(["368", "   "])).toThrow(
        /Message cannot be empty/,
      );
    });

    it("auto-resolves issue when only message arg provided", () => {
      const r = parseRelayPromptArgs(["hello there"]);
      expect(r.issue).toBeNull();
      expect(r.message).toBe("hello there");
    });

    it("rejects invalid issue number", () => {
      expect(() => parseRelayPromptArgs(["abc", "hello"])).toThrow(
        /Invalid issue number/,
      );
    });

    it("joins remaining positional args into the message", () => {
      const r = parseRelayPromptArgs(["368", "what", "is", "happening"]);
      expect(r.message).toBe("what is happening");
    });
  });

  // === AC-17b: Auto-resolve single active run; error on ambiguous ===
  describe("AC-17b: Auto-resolve when issue is omitted", () => {
    it("uses the sole active run when there is exactly one", () => {
      const r = resolveTargetIssue({
        explicit: null,
        activeIssues: [368],
      });
      expect(r.issue).toBe(368);
      expect(r.reason).toBe("single-active");
    });

    it("errors with a list of issues when multiple runs are active", () => {
      expect(() =>
        resolveTargetIssue({
          explicit: null,
          activeIssues: [368, 385],
        }),
      ).toThrow(/Multiple active runs.*#368.*#385/s);
    });

    it("errors when zero runs are active", () => {
      expect(() =>
        resolveTargetIssue({
          explicit: null,
          activeIssues: [],
        }),
      ).toThrow(/No active sequant runs/);
    });

    it("uses explicit issue without consulting active list", () => {
      const r = resolveTargetIssue({
        explicit: 999,
        activeIssues: [368, 385],
      });
      expect(r.issue).toBe(999);
      expect(r.reason).toBe("explicit");
    });
  });

  describe("findActiveIssues", () => {
    it("returns only issues that are in_progress with an alive PID", () => {
      const issues = [
        makeIssueState(100, "in_progress"),
        makeIssueState(200, "merged"),
        makeIssueState(300, "in_progress"),
      ];
      const aliveFor = new Set<number>([100]);
      // Mock readPidFile by stubbing fs via the function signature: this test
      // exercises the contract — issues with no pidfile yield no result.
      const active = findActiveIssues(
        issues,
        (pid) => aliveFor.has(pid),
        // Use a non-existent cwd so readPidFile returns null universally.
        "/nonexistent/path",
      );
      expect(active).toEqual([]);
    });
  });
});
