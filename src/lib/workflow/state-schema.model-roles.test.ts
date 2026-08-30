/**
 * Tests for #975 AC-4: PhaseMarkerSchema accepts the new optional
 * requestedModel and resolvedModel fields and round-trips them through
 * parsePhaseMarkers without loss.
 */

import { describe, it, expect } from "vitest";
import { PhaseMarkerSchema } from "./state-schema.js";
import { parsePhaseMarkers } from "./phase-detection.js";

describe("#975 AC-4: PhaseMarkerSchema round-trip for requestedModel and resolvedModel", () => {
  it("PhaseMarkerSchema accepts requestedModel and resolvedModel as optional fields", () => {
    const result = PhaseMarkerSchema.safeParse({
      phase: "exec",
      status: "completed",
      timestamp: "2026-08-29T12:00:00.000Z",
      requestedModel: "role:fast",
      resolvedModel: "claude-sonnet-5",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requestedModel).toBe("role:fast");
      expect(result.data.resolvedModel).toBe("claude-sonnet-5");
    }
  });

  it("PhaseMarkerSchema parses without requestedModel/resolvedModel (backward compat)", () => {
    const result = PhaseMarkerSchema.safeParse({
      phase: "qa",
      status: "completed",
      timestamp: "2026-08-29T12:00:00.000Z",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requestedModel).toBeUndefined();
      expect(result.data.resolvedModel).toBeUndefined();
    }
  });

  it("parsePhaseMarkers round-trips requestedModel and resolvedModel from a comment body", () => {
    const body = `<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2026-08-29T12:00:00.000Z","requestedModel":"role:strong","resolvedModel":"claude-opus-4-8"} -->`;

    const markers = parsePhaseMarkers(body);

    expect(markers).toHaveLength(1);
    expect(markers[0].requestedModel).toBe("role:strong");
    expect(markers[0].resolvedModel).toBe("claude-opus-4-8");
  });

  it("parsePhaseMarkers passes through a raw model string (no role: prefix) as requestedModel", () => {
    const body = `<!-- SEQUANT_PHASE: {"phase":"exec","status":"completed","timestamp":"2026-08-29T12:00:00.000Z","requestedModel":"claude-sonnet-5","resolvedModel":"claude-sonnet-5"} -->`;

    const markers = parsePhaseMarkers(body);

    expect(markers).toHaveLength(1);
    expect(markers[0].requestedModel).toBe("claude-sonnet-5");
    expect(markers[0].resolvedModel).toBe("claude-sonnet-5");
  });
});
