import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "child_process";

// Mock child_process (used by getResumablePhasesForIssue via GitHubProvider)
vi.mock("child_process", () => ({
  spawnSync: vi.fn(),
  execSync: vi.fn(),
}));

const mockSpawnSync = vi.mocked(spawnSync);

import { filterResumedPhases } from "../run.js";
import type { Phase } from "../../lib/workflow/types.js";

/** Helper: mock spawnSync to return comment bodies JSON */
function mockCommentBodies(bodies: string[]) {
  mockSpawnSync.mockReturnValue({
    status: 0,
    stdout: JSON.stringify(bodies),
    stderr: "",
    pid: 0,
    output: [],
    signal: null,
  } as never);
}

function mockSpawnSyncFailure() {
  mockSpawnSync.mockReturnValue({
    status: 1,
    stdout: "",
    stderr: "error",
    pid: 0,
    output: [],
    signal: null,
  } as never);
}

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
      // spawnSync should NOT be called
      expect(mockSpawnSync).not.toHaveBeenCalled();
    });

    it("calls getResumablePhasesForIssue when resume is true", () => {
      // Mock gh CLI returning no completed phases
      mockCommentBodies(["No phase markers"]);

      const phases: Phase[] = ["spec", "exec", "qa"];
      filterResumedPhases(123, phases, true);

      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["issue", "view", "123"]),
        expect.any(Object),
      );
    });
  });

  describe("AC-2: getResumablePhasesForIssue is called with correct args", () => {
    it("passes issue number and phases to the underlying gh CLI call", () => {
      mockCommentBodies(["Some comment body"]);

      const phases: Phase[] = ["exec", "qa"];
      filterResumedPhases(456, phases, true);

      // Verify gh issue view is called with the correct issue number
      expect(mockSpawnSync).toHaveBeenCalledWith(
        "gh",
        expect.arrayContaining(["issue", "view", "456", "--json", "comments"]),
        expect.any(Object),
      );
    });
  });

  describe("AC-3: completed phases are filtered from the execution list", () => {
    it("filters out phases that have completed markers", () => {
      // Simulate GitHub comments with spec and exec completed
      mockCommentBodies([
        'Some text <!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
        'More text <!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      ]);

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(789, phases, true);

      expect(result.phases).toEqual(["qa"]);
      expect(result.skipped).toEqual(["spec", "exec"]);
    });

    it("returns all phases when no phases are completed", () => {
      mockCommentBodies(["A comment with no phase markers"]);

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(100, phases, true);

      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.skipped).toEqual([]);
    });

    it("returns empty phases when all phases are completed", () => {
      mockCommentBodies([
        '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
        '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
        '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2025-01-15T12:00:00.000Z"} -->',
      ]);

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(200, phases, true);

      expect(result.phases).toEqual([]);
      expect(result.skipped).toEqual(["spec", "exec", "qa"]);
    });

    it("keeps failed phases for retry", () => {
      mockCommentBodies([
        '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
        '<!-- SEQUANT_PHASE: {"phase":"exec","status":"failed","timestamp":"2025-01-15T11:00:00.000Z","error":"Build failed"} -->',
      ]);

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(300, phases, true);

      // exec should remain (failed, not completed) — qa should remain (never ran)
      expect(result.phases).toEqual(["exec", "qa"]);
      expect(result.skipped).toEqual(["spec"]);
    });

    it("returns all phases when gh CLI call fails", () => {
      // getResumablePhasesForIssue catches errors and returns all phases
      mockSpawnSyncFailure();

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(400, phases, true);

      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.skipped).toEqual([]);
    });
  });
});
