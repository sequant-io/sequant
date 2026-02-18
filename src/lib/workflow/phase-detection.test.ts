import { describe, it, expect } from "vitest";
import {
  formatPhaseMarker,
  parsePhaseMarkers,
  detectPhaseFromComments,
  getPhaseMap,
  getCompletedPhasesFromComments,
  getResumablePhases,
  isPhaseCompletedOrPast,
} from "./phase-detection.js";
import type { PhaseMarker } from "./state-schema.js";

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
