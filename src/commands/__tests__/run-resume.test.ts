import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  deriveGhFixture,
  loadGhFixture,
  type GhReplay,
} from "../../lib/workflow/platforms/gh-fixtures.js";

// getResumablePhasesForIssue builds its own GitHubProvider; swap in one that
// replays captured gh output (#1506) instead of mocking child_process.
const gh = vi.hoisted((): GhReplay => ({ fixtures: [], calls: [] }));
vi.mock("../../lib/workflow/platforms/github.js", async (importOriginal) =>
  (
    await import("../../lib/workflow/platforms/gh-fixtures.js")
  ).replayGitHubModule(importOriginal, gh),
);

import { filterResumedPhases } from "../run.js";
import type { Phase } from "../../lib/workflow/types.js";

const BODIES = loadGhFixture("issue-comment-bodies");

/** gh answers `issue view <n> --json comments` with these comment bodies. */
function mockCommentBodies(issue: number, bodies: string[]) {
  gh.fixtures = [
    deriveGhFixture(BODIES, { number: issue, json: () => bodies }),
  ];
}

function mockGhFailure(issue: number) {
  const notFound = loadGhFixture("issue-view-not-found");
  gh.fixtures = [
    deriveGhFixture(BODIES, {
      number: issue,
      exitCode: notFound.exitCode,
      stdout: "",
      stderr: notFound.stderr,
    }),
  ];
}

describe("filterResumedPhases (--resume integration)", () => {
  beforeEach(() => {
    gh.fixtures = [];
    gh.calls.length = 0;
  });

  describe("AC-1: --resume flag is parsed and passed through", () => {
    it("returns all phases unchanged when resume is false", () => {
      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(123, phases, false);

      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.skipped).toEqual([]);
      // gh should NOT be called
      expect(gh.calls).toHaveLength(0);
    });

    it("calls getResumablePhasesForIssue when resume is true", () => {
      // Mock gh CLI returning no completed phases
      mockCommentBodies(123, ["No phase markers"]);

      const phases: Phase[] = ["spec", "exec", "qa"];
      filterResumedPhases(123, phases, true);

      expect(gh.calls).toHaveLength(1);
      expect(gh.calls[0].args).toEqual(
        expect.arrayContaining(["issue", "view", "123"]),
      );
    });
  });

  describe("AC-2: getResumablePhasesForIssue is called with correct args", () => {
    it("passes issue number and phases to the underlying gh CLI call", () => {
      mockCommentBodies(456, ["Some comment body"]);

      const phases: Phase[] = ["exec", "qa"];
      filterResumedPhases(456, phases, true);

      // Verify gh issue view is called with the correct issue number
      expect(gh.calls[0].args).toEqual(
        expect.arrayContaining(["issue", "view", "456", "--json", "comments"]),
      );
    });
  });

  describe("AC-3: completed phases are filtered from the execution list", () => {
    it("filters out phases that have completed markers", () => {
      // Simulate GitHub comments with spec and exec completed
      mockCommentBodies(789, [
        'Some text <!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
        'More text <!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      ]);

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(789, phases, true);

      expect(result.phases).toEqual(["qa"]);
      expect(result.skipped).toEqual(["spec", "exec"]);
    });

    it("returns all phases when no phases are completed", () => {
      mockCommentBodies(100, ["A comment with no phase markers"]);

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(100, phases, true);

      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.skipped).toEqual([]);
    });

    it("returns empty phases when all phases are completed", () => {
      mockCommentBodies(200, [
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
      mockCommentBodies(300, [
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
      mockGhFailure(400);

      const phases: Phase[] = ["spec", "exec", "qa"];
      const result = filterResumedPhases(400, phases, true);

      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.skipped).toEqual([]);
    });
  });
});
