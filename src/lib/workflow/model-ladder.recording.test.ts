/**
 * #971 AC-10 (recording half) + AC-D1 — the two schema surfaces the ladder
 * writes to, and the marker-parser constraint that shapes both.
 *
 * The load-bearing risk here is not "does the field exist". It is that
 * `phase-detection.ts` parses phase markers with
 * `/<!-- SEQUANT_PHASE: (\{[^}]+\}) -->/g` — **flat JSON only**. A nested
 * `{ escalation: { … } }` payload would stop the match at the inner brace and
 * silently take every marker in that comment with it, which reads as "the
 * phase never ran" rather than as a parse failure. AC-D1 is the round-trip
 * that keeps the flat contract honest.
 *
 * The other half is backward compatibility (I-2): every field added here is
 * optional and append-only, so records and markers written before #971 still
 * load unchanged.
 */

import { describe, it, expect } from "vitest";
import { formatPhaseMarker, parsePhaseMarkers } from "./phase-detection.js";
import { PhaseMarkerSchema, type PhaseMarker } from "./state-schema.js";
import { PhaseUsageSchema, MetricRunSchema } from "./metrics-schema.js";
import { buildEscalationMarkerFields } from "./model-ladder.js";

const ESCALATED_MARKER: PhaseMarker = {
  phase: "exec",
  status: "completed",
  timestamp: "2026-09-08T00:00:00.000Z",
  commitSHA: "abc123",
  requestedModel: "role:strong",
  ladderRung: 1,
  baseModel: "sonnet",
  escalatedModel: "opus",
  escalationTrigger: "LOOP_NO_DIFF",
  topOfLadder: true,
};

describe("971 AC-10: escalation facts land in the phase marker", () => {
  it("the schema accepts every escalation field", () => {
    expect(PhaseMarkerSchema.parse(ESCALATED_MARKER)).toMatchObject({
      ladderRung: 1,
      baseModel: "sonnet",
      escalatedModel: "opus",
      escalationTrigger: "LOOP_NO_DIFF",
      requestedModel: "role:strong",
      topOfLadder: true,
    });
  });

  it("971 AC-D1: the fields survive a formatPhaseMarker → parsePhaseMarkers round-trip", () => {
    const formatted = formatPhaseMarker(ESCALATED_MARKER);
    const parsed = parsePhaseMarkers(formatted);

    // The whole point: the marker is still found AT ALL. A nested payload
    // would produce `[]` here, not a partial object.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      phase: "exec",
      ladderRung: 1,
      baseModel: "sonnet",
      escalatedModel: "opus",
      escalationTrigger: "LOOP_NO_DIFF",
      requestedModel: "role:strong",
      topOfLadder: true,
    });
  });

  it("971 AC-D1: an escalated marker does not break a SIBLING marker in the same body", () => {
    // The failure mode a nested payload causes is not local: a `}` inside the
    // first marker's body ends `[^}]+` early and desynchronizes the global
    // regex for everything after it.
    const body = [
      "Some progress text.",
      formatPhaseMarker(ESCALATED_MARKER),
      "More text.",
      formatPhaseMarker({
        phase: "qa",
        status: "failed",
        timestamp: "2026-09-08T01:00:00.000Z",
      }),
    ].join("\n\n");

    const parsed = parsePhaseMarkers(body);
    expect(parsed.map((m) => m.phase)).toEqual(["exec", "qa"]);
  });

  it("buildEscalationMarkerFields produces exactly the schema's field names", () => {
    const fields = buildEscalationMarkerFields({
      rung: 2,
      base: "opus",
      escalated: "fable",
      trigger: "SAME_SHA_NO_PROGRESS",
    });

    // Round-tripping the builder's output through the schema proves the two
    // sides cannot drift on a field name — a rename on either side fails here.
    const parsed = PhaseMarkerSchema.parse({
      phase: "qa",
      status: "failed",
      timestamp: "2026-09-08T00:00:00.000Z",
      ...fields,
    });
    expect(parsed.ladderRung).toBe(2);
    expect(parsed.escalationTrigger).toBe("SAME_SHA_NO_PROGRESS");
  });

  it("a pre-#971 marker still parses and loads (I-2 append-only)", () => {
    const body =
      '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2026-01-01T00:00:00.000Z"} -->';
    const parsed = parsePhaseMarkers(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].ladderRung).toBeUndefined();
    expect(parsed[0].escalationTrigger).toBeUndefined();
  });
});

describe("971 AC-10: escalation columns on the #986 phaseUsage row", () => {
  const BASE_ROW = {
    phase: "exec",
    model: "claude-opus-5",
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0.42,
  };

  it("accepts the escalation columns on an existing row shape", () => {
    const row = PhaseUsageSchema.parse({
      ...BASE_ROW,
      ladderRung: 1,
      baseModel: "sonnet",
      escalatedModel: "opus",
      escalationTrigger: "LOOP_NO_DIFF",
      requestedModel: "role:strong",
      topOfLadder: false,
    });
    expect(row.ladderRung).toBe(1);
    expect(row.escalatedModel).toBe("opus");
  });

  it("a pre-#971 row still validates — the columns are optional and additive", () => {
    const row = PhaseUsageSchema.parse(BASE_ROW);
    expect(row.ladderRung).toBeUndefined();
    expect(row.baseModel).toBeUndefined();
  });

  it("the columns extend #986's row rather than adding a parallel array", () => {
    // A second array would have to be re-joined to these rows by phase name,
    // and grouping by phase name is exactly what silently merges a
    // quality-loop retry into its first attempt — the reason #986 keeps rows
    // in `phaseResults` order.
    const shape = Object.keys(MetricRunSchema.shape.metrics.shape);
    expect(shape).toContain("phaseUsage");
    expect(shape.filter((k) => /escalat/i.test(k))).toEqual([]);
  });
});
