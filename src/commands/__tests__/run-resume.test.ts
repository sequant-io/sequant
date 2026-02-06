import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "child_process";

// Mock child_process (used by getResumablePhasesForIssue)
vi.mock("child_process", () => ({
  spawnSync: vi.fn(),
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

import { filterResumedPhases } from "../run.js";
import type { Phase } from "../../lib/workflow/types.js";

describe("filterResumedPhases (--resume integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("AC-1: --resume flag is parsed and passed through", () => {
    it("returns all phases unchanged when resume is false", () => {
      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(123, phases, false);

      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.skipped).toEqual([]);
      // getResumablePhasesForIssue should NOT be called
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("calls getResumablePhasesForIssue when resume is true", () => {
      // Mock gh CLI returning no completed phases
      mockExecSync.mockReturnValue(
        JSON.stringify(["No phase markers"]) as unknown as Buffer,
      );

      const phases: Phase[] = ["spec", "exec", "qa"];
      filterResumedPhases(123, phases, true);

      expect(mockExecSync).toHaveBeenCalledTimes(1);
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining("gh issue view 123"),
        expect.objectContaining({ encoding: "utf-8" }),
      );
    });
  });

  describe("AC-2: getResumablePhasesForIssue is called with correct args", () => {
    it("passes issue number and phases to the underlying gh CLI call", () => {
      mockExecSync.mockReturnValue(
        JSON.stringify(["Some comment body"]) as unknown as Buffer,
      );

      const phases: Phase[] = ["exec", "qa"];
      filterResumedPhases(456, phases, true);

      // Verify gh issue view is called with the correct issue number
      const call = mockExecSync.mock.calls[0];
      expect(call[0]).toContain("gh issue view 456");
      expect(call[0]).toContain("--json comments");
    });
  });

  describe("AC-3: completed phases are filtered from the execution list", () => {
    it("filters out phases that have completed markers", () => {
      // Simulate GitHub comments with spec and exec completed
      const commentsJson = JSON.stringify([
        'Some text <!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
        'More text <!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      ]);
      mockExecSync.mockReturnValue(commentsJson as unknown as Buffer);

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(789, phases, true);

      expect(result.phases).toEqual(["qa"]);
      expect(result.skipped).toEqual(["spec", "exec"]);
    });

    it("returns all phases when no phases are completed", () => {
      const commentsJson = JSON.stringify(["A comment with no phase markers"]);
      mockExecSync.mockReturnValue(commentsJson as unknown as Buffer);

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(100, phases, true);

      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.skipped).toEqual([]);
    });

    it("returns empty phases when all phases are completed", () => {
      const commentsJson = JSON.stringify([
        '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
        '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
        '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2025-01-15T12:00:00.000Z"} -->',
      ]);
      mockExecSync.mockReturnValue(commentsJson as unknown as Buffer);

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(200, phases, true);

      expect(result.phases).toEqual([]);
      expect(result.skipped).toEqual(["spec", "exec", "qa"]);
    });

    it("keeps failed phases for retry", () => {
      const commentsJson = JSON.stringify([
        '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
        '<!-- SEQUANT_PHASE: {"phase":"exec","status":"failed","timestamp":"2025-01-15T11:00:00.000Z","error":"Build failed"} -->',
      ]);
      mockExecSync.mockReturnValue(commentsJson as unknown as Buffer);

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(300, phases, true);

      // exec should remain (failed, not completed) — qa should remain (never ran)
      expect(result.phases).toEqual(["exec", "qa"]);
      expect(result.skipped).toEqual(["spec"]);
    });

    it("returns all phases when gh CLI call fails", () => {
      // getResumablePhasesForIssue catches errors and returns all phases
      mockExecSync.mockImplementation(() => {
        throw new Error("gh: command not found");
      });

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(400, phases, true);

      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.skipped).toEqual([]);
    });
  });
});
