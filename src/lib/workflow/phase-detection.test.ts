import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  formatPhaseMarker,
  parsePhaseMarkers,
  detectPhaseFromComments,
  detectPriorQAFindings,
  getPhaseMap,
  getCompletedPhasesFromComments,
  getResumablePhases,
  isPhaseCompletedOrPast,
  getIssuePhase,
  getCompletedPhases,
  getResumablePhasesForIssue,
} from "./phase-detection.js";
import type { PhaseMarker } from "./state-schema.js";

// Mock child_process module for testing gh CLI wrapper functions
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execSync: vi.fn(actual.execSync),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

// Get mocked functions for configuring in tests
import { execSync, spawnSync } from "child_process";
const mockExecSync = vi.mocked(execSync);
const mockSpawnSync = vi.mocked(spawnSync);

describe("formatPhaseMarker", () => {
  it("produces valid HTML comment with JSON", () => {
    const marker: PhaseMarker = {
      phase: "spec",
      status: "completed",
      timestamp: "2025-01-15T10:30:00.000Z",
    };
    const result = formatPhaseMarker(marker);
    expect(result).toBe(
      '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:30:00.000Z"} -->',
    );
  });

  it("includes optional pr field", () => {
    const marker: PhaseMarker = {
      phase: "exec",
      status: "completed",
      timestamp: "2025-01-15T10:30:00.000Z",
      pr: 42,
    };
    const result = formatPhaseMarker(marker);
    expect(result).toContain('"pr":42');
  });

  it("includes optional error field", () => {
    const marker: PhaseMarker = {
      phase: "exec",
      status: "failed",
      timestamp: "2025-01-15T10:30:00.000Z",
      error: "Build failed",
    };
    const result = formatPhaseMarker(marker);
    expect(result).toContain('"error":"Build failed"');
  });

  it("roundtrips through parse", () => {
    const marker: PhaseMarker = {
      phase: "qa",
      status: "completed",
      timestamp: "2025-01-15T12:00:00.000Z",
    };
    const formatted = formatPhaseMarker(marker);
    const parsed = parsePhaseMarkers(formatted);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(marker);
  });
});

describe("parsePhaseMarkers", () => {
  it("extracts marker from comment body", () => {
    const body = `## Spec Complete

Some human-readable content.

<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:30:00.000Z"} -->`;
    const markers = parsePhaseMarkers(body);
    expect(markers).toHaveLength(1);
    expect(markers[0].phase).toBe("spec");
    expect(markers[0].status).toBe("completed");
  });

  it("extracts multiple markers from one comment", () => {
    const body = `<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->
Some content
<!-- SEQUANT_PHASE: {"phase":"exec","status":"in_progress","timestamp":"2025-01-15T11:00:00.000Z"} -->`;
    const markers = parsePhaseMarkers(body);
    expect(markers).toHaveLength(2);
    expect(markers[0].phase).toBe("spec");
    expect(markers[1].phase).toBe("exec");
  });

  it("returns empty array for no markers", () => {
    const body = "Just a regular comment with no markers.";
    expect(parsePhaseMarkers(body)).toEqual([]);
  });

  it("skips malformed JSON", () => {
    const body =
      '<!-- SEQUANT_PHASE: {invalid json} -->\n<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->';
    const markers = parsePhaseMarkers(body);
    expect(markers).toHaveLength(1);
    expect(markers[0].phase).toBe("spec");
  });

  it("skips markers with invalid schema", () => {
    // Missing required fields
    const body =
      '<!-- SEQUANT_PHASE: {"phase":"spec"} -->\n<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->';
    const markers = parsePhaseMarkers(body);
    expect(markers).toHaveLength(1);
    expect(markers[0].phase).toBe("exec");
  });

  it("skips markers with unknown phase", () => {
    const body =
      '<!-- SEQUANT_PHASE: {"phase":"unknown","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->';
    const markers = parsePhaseMarkers(body);
    expect(markers).toEqual([]);
  });

  it("handles empty string", () => {
    expect(parsePhaseMarkers("")).toEqual([]);
  });

  it("ignores markers inside fenced code blocks (AC-1)", () => {
    const body = `Here's how to emit a phase marker:

\`\`\`markdown
<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->
\`\`\`

This is documentation, not a real marker.`;
    const markers = parsePhaseMarkers(body);
    expect(markers).toEqual([]);
  });

  it("ignores markers inside tilde fenced code blocks", () => {
    const body = `Example with tildes:

~~~
<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->
~~~`;
    const markers = parsePhaseMarkers(body);
    expect(markers).toEqual([]);
  });

  it("ignores markers inside 4+ backtick fenced code blocks", () => {
    const body = `Example with 4 backticks:

\`\`\`\`markdown
<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->
\`\`\`\``;
    const markers = parsePhaseMarkers(body);
    expect(markers).toEqual([]);
  });

  it("ignores markers inside inline code (AC-2)", () => {
    const body =
      'Use the marker format: `<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->`';
    const markers = parsePhaseMarkers(body);
    expect(markers).toEqual([]);
  });

  it("parses real markers while ignoring code block examples", () => {
    const body = `## Phase Detection Documentation

Here's an example of a phase marker:

\`\`\`markdown
<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T09:00:00.000Z"} -->
\`\`\`

And inline: \`<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->\`

The real marker is below:

<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->`;
    const markers = parsePhaseMarkers(body);
    expect(markers).toHaveLength(1);
    expect(markers[0].phase).toBe("qa");
    expect(markers[0].status).toBe("completed");
  });
});

describe("detectPhaseFromComments", () => {
  it("returns latest marker by timestamp", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"qa","status":"in_progress","timestamp":"2025-01-15T12:00:00.000Z"} -->',
      },
    ];
    const result = detectPhaseFromComments(comments);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe("qa");
    expect(result!.status).toBe("in_progress");
  });

  it("returns null for no comments", () => {
    expect(detectPhaseFromComments([])).toBeNull();
  });

  it("returns null when no markers present", () => {
    const comments = [
      { body: "Just a regular comment." },
      { body: "Another comment without markers." },
    ];
    expect(detectPhaseFromComments(comments)).toBeNull();
  });

  it("handles mixed comments with and without markers", () => {
    const comments = [
      { body: "Regular comment" },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
      { body: "Another regular comment" },
    ];
    const result = detectPhaseFromComments(comments);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe("spec");
  });
});

describe("getPhaseMap", () => {
  it("returns latest marker per phase", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"in_progress","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      },
    ];
    const map = getPhaseMap(comments);
    expect(map.size).toBe(1);
    expect(map.get("exec")!.status).toBe("completed");
  });

  it("tracks multiple phases", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"qa","status":"failed","timestamp":"2025-01-15T12:00:00.000Z"} -->',
      },
    ];
    const map = getPhaseMap(comments);
    expect(map.size).toBe(3);
    expect(map.get("spec")!.status).toBe("completed");
    expect(map.get("exec")!.status).toBe("completed");
    expect(map.get("qa")!.status).toBe("failed");
  });

  it("returns empty map for no markers", () => {
    expect(getPhaseMap([{ body: "no markers" }]).size).toBe(0);
  });
});

describe("getCompletedPhasesFromComments", () => {
  it("returns only completed phases in workflow order", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"qa","status":"failed","timestamp":"2025-01-15T12:00:00.000Z"} -->',
      },
    ];
    const completed = getCompletedPhasesFromComments(comments);
    expect(completed).toEqual(["spec", "exec"]);
  });

  it("returns empty array when no phases completed", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"spec","status":"in_progress","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
    ];
    expect(getCompletedPhasesFromComments(comments)).toEqual([]);
  });

  it("respects workflow phase ordering", () => {
    // Even if exec is completed before spec in timestamp, output follows WORKFLOW_PHASES order
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      },
    ];
    const completed = getCompletedPhasesFromComments(comments);
    expect(completed).toEqual(["spec", "qa"]);
  });
});

describe("getResumablePhases", () => {
  it("filters out completed phases", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      },
    ];
    const result = getResumablePhases(["spec", "exec", "qa"], comments);
    expect(result).toEqual(["qa"]);
  });

  it("keeps failed phases (for retry)", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"failed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      },
    ];
    const result = getResumablePhases(["spec", "exec", "qa"], comments);
    expect(result).toEqual(["exec", "qa"]);
  });

  it("returns all phases when no markers exist", () => {
    const result = getResumablePhases(
      ["spec", "exec", "qa"],
      [{ body: "no markers" }],
    );
    expect(result).toEqual(["spec", "exec", "qa"]);
  });

  it("returns all phases for empty comments", () => {
    const result = getResumablePhases(["spec", "exec", "qa"], []);
    expect(result).toEqual(["spec", "exec", "qa"]);
  });

  it("handles all phases completed", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2025-01-15T12:00:00.000Z"} -->',
      },
    ];
    const result = getResumablePhases(["spec", "exec", "qa"], comments);
    expect(result).toEqual([]);
  });
});

describe("isPhaseCompletedOrPast", () => {
  it("returns true when target phase is completed", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
    ];
    expect(isPhaseCompletedOrPast("spec", comments)).toBe(true);
  });

  it("returns true when a later phase is completed", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
    ];
    // spec is before exec in WORKFLOW_PHASES, so if exec is completed, spec must have been too
    expect(isPhaseCompletedOrPast("spec", comments)).toBe(true);
  });

  it("returns false when target phase not reached", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
    ];
    expect(isPhaseCompletedOrPast("exec", comments)).toBe(false);
  });

  it("returns false when target phase is in_progress", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"in_progress","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
    ];
    expect(isPhaseCompletedOrPast("exec", comments)).toBe(false);
  });

  it("returns false when target phase failed and no later phase completed", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"failed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
    ];
    expect(isPhaseCompletedOrPast("exec", comments)).toBe(false);
  });

  it("returns false for empty comments", () => {
    expect(isPhaseCompletedOrPast("spec", [])).toBe(false);
  });
});

describe("gh CLI wrapper functions", () => {
  function mockSpawnSyncSuccess(stdout: string) {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout,
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

  beforeEach(() => {
    mockExecSync.mockReset();
    mockSpawnSync.mockReset();
  });

  describe("getIssuePhase", () => {
    it("returns null when spawnSync fails (AC-1)", () => {
      mockSpawnSyncFailure();

      const result = getIssuePhase(123);
      expect(result).toBeNull();
    });

    it("returns correct marker when spawnSync returns valid JSON (AC-4)", () => {
      const commentBodies = [
        '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
        '<!-- SEQUANT_PHASE: {"phase":"exec","status":"in_progress","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      ];
      mockSpawnSyncSuccess(JSON.stringify(commentBodies));

      const result = getIssuePhase(42);

      expect(result).not.toBeNull();
      expect(result!.phase).toBe("exec");
      expect(result!.status).toBe("in_progress");
    });

    it("returns null when no phase markers found", () => {
      const commentBodies = ["Just a regular comment", "Another comment"];
      mockSpawnSyncSuccess(JSON.stringify(commentBodies));

      const result = getIssuePhase(42);
      expect(result).toBeNull();
    });
  });

  describe("getCompletedPhases", () => {
    it("returns empty array when spawnSync fails (AC-2)", () => {
      mockSpawnSyncFailure();

      const result = getCompletedPhases(456);
      expect(result).toEqual([]);
    });

    it("returns correct phases when spawnSync returns valid JSON (AC-5)", () => {
      const commentBodies = [
        '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
        '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
        '<!-- SEQUANT_PHASE: {"phase":"qa","status":"failed","timestamp":"2025-01-15T12:00:00.000Z"} -->',
      ];
      mockSpawnSyncSuccess(JSON.stringify(commentBodies));

      const result = getCompletedPhases(42);

      expect(result).toEqual(["spec", "exec"]);
    });

    it("returns empty array when no phases completed", () => {
      const commentBodies = [
        '<!-- SEQUANT_PHASE: {"phase":"spec","status":"in_progress","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      ];
      mockSpawnSyncSuccess(JSON.stringify(commentBodies));

      const result = getCompletedPhases(42);
      expect(result).toEqual([]);
    });
  });

  describe("getResumablePhasesForIssue", () => {
    it("returns all requested phases when spawnSync fails (AC-3)", () => {
      mockSpawnSyncFailure();

      const requestedPhases = ["spec", "exec", "qa"];
      const result = getResumablePhasesForIssue(789, requestedPhases);

      expect(result).toEqual(["spec", "exec", "qa"]);
    });

    it("filters out completed phases when spawnSync returns valid JSON", () => {
      const commentBodies = [
        '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
        '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      ];
      mockSpawnSyncSuccess(JSON.stringify(commentBodies));

      const requestedPhases = ["spec", "exec", "qa"];
      const result = getResumablePhasesForIssue(42, requestedPhases);

      expect(result).toEqual(["qa"]);
    });

    it("returns all phases when no markers found", () => {
      const commentBodies = ["Just a regular comment"];
      mockSpawnSyncSuccess(JSON.stringify(commentBodies));

      const requestedPhases = ["spec", "exec", "qa"];
      const result = getResumablePhasesForIssue(42, requestedPhases);

      expect(result).toEqual(["spec", "exec", "qa"]);
    });
  });
});

describe("detectPriorQAFindings", () => {
  it("returns null when no QA markers exist", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"2025-01-15T10:00:00.000Z"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T11:00:00.000Z"} -->',
      },
    ];
    expect(detectPriorQAFindings(comments)).toBeNull();
  });

  it("detects QA marker without commitSHA", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2025-01-15T12:00:00.000Z"} -->',
      },
    ];
    const result = detectPriorQAFindings(comments);
    expect(result).not.toBeNull();
    expect(result!.commitSHA).toBeNull();
    expect(result!.timestamp).toBe("2025-01-15T12:00:00.000Z");
    expect(result!.status).toBe("completed");
  });

  it("detects QA marker with commitSHA", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2025-01-15T12:00:00.000Z","commitSHA":"abc123def456"} -->',
      },
    ];
    const result = detectPriorQAFindings(comments);
    expect(result).not.toBeNull();
    expect(result!.commitSHA).toBe("abc123def456");
    expect(result!.timestamp).toBe("2025-01-15T12:00:00.000Z");
  });

  it("returns latest QA marker when multiple exist", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"qa","status":"failed","timestamp":"2025-01-15T10:00:00.000Z","commitSHA":"old123"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2025-01-15T14:00:00.000Z","commitSHA":"new456"} -->',
      },
    ];
    const result = detectPriorQAFindings(comments);
    expect(result).not.toBeNull();
    expect(result!.commitSHA).toBe("new456");
    expect(result!.status).toBe("completed");
  });

  it("ignores non-QA markers even if more recent", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2025-01-15T10:00:00.000Z","commitSHA":"qa123"} -->',
      },
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2025-01-15T15:00:00.000Z","commitSHA":"exec789"} -->',
      },
    ];
    const result = detectPriorQAFindings(comments);
    expect(result).not.toBeNull();
    expect(result!.commitSHA).toBe("qa123");
  });

  it("returns null for empty comments array", () => {
    expect(detectPriorQAFindings([])).toBeNull();
  });

  it("detects failed QA marker status", () => {
    const comments = [
      {
        body: '<!-- SEQUANT_PHASE: {"phase":"qa","status":"failed","timestamp":"2025-01-15T12:00:00.000Z","error":"AC_NOT_MET","commitSHA":"fail789"} -->',
      },
    ];
    const result = detectPriorQAFindings(comments);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("failed");
    expect(result!.commitSHA).toBe("fail789");
  });
});

describe("PhaseMarker commitSHA support", () => {
  it("parses markers with commitSHA field", () => {
    const body =
      '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2025-01-15T12:00:00.000Z","commitSHA":"abc123"} -->';
    const markers = parsePhaseMarkers(body);
    expect(markers).toHaveLength(1);
    expect(markers[0].commitSHA).toBe("abc123");
  });

  it("formats markers with commitSHA field", () => {
    const marker: PhaseMarker = {
      phase: "qa",
      status: "completed",
      timestamp: "2025-01-15T12:00:00.000Z",
      commitSHA: "abc123def456",
    };
    const result = formatPhaseMarker(marker);
    expect(result).toContain('"commitSHA":"abc123def456"');
  });

  it("roundtrips commitSHA through format and parse", () => {
    const marker: PhaseMarker = {
      phase: "qa",
      status: "completed",
      timestamp: "2025-01-15T12:00:00.000Z",
      commitSHA: "deadbeef12345",
    };
    const formatted = formatPhaseMarker(marker);
    const parsed = parsePhaseMarkers(formatted);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].commitSHA).toBe("deadbeef12345");
  });

  it("handles markers without commitSHA (backward compat)", () => {
    const body =
      '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2025-01-15T12:00:00.000Z"} -->';
    const markers = parsePhaseMarkers(body);
    expect(markers).toHaveLength(1);
    expect(markers[0].commitSHA).toBeUndefined();
  });
});
