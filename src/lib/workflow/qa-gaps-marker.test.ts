import { describe, it, expect } from "vitest";
import { parseQaGapsMarker } from "./qa-gaps-marker.js";

describe("qa-gaps-marker", () => {
  describe("parseQaGapsMarker", () => {
    it("parses a valid SEQUANT_QA_GAPS marker with one finding", () => {
      const output = `Some QA output.

<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"test_gap","evidence":"src/foo.ts:12 has no test","description":"Missing test for empty input","recommendedAction":"fix_now"}]} -->`;
      const findings = parseQaGapsMarker(output);
      expect(findings).toEqual([
        {
          category: "test_gap",
          evidence: "src/foo.ts:12 has no test",
          description: "Missing test for empty input",
          recommendedAction: "fix_now",
        },
      ]);
    });

    it("parses multiple findings in one marker", () => {
      const output = `<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"requirement_gap","evidence":"e1","description":"d1","recommendedAction":"fix_now"},{"category":"risk_gap","evidence":"e2","description":"d2","recommendedAction":"document"}]} -->`;
      const findings = parseQaGapsMarker(output);
      expect(findings?.map((f) => f.description)).toEqual(["d1", "d2"]);
    });

    it("parses optional affectedAcs and nonGoal fields", () => {
      const output = `<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"execution_gap","evidence":"e","description":"d","recommendedAction":"pause_for_human","affectedAcs":["AC-3"],"nonGoal":true}]} -->`;
      const findings = parseQaGapsMarker(output);
      expect(findings?.[0]).toMatchObject({
        affectedAcs: ["AC-3"],
        nonGoal: true,
      });
    });

    it("returns the LAST valid marker when multiple markers are present (latest wins)", () => {
      const output = `
<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"test_gap","evidence":"e1","description":"first pass","recommendedAction":"fix_now"}]} -->
<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"test_gap","evidence":"e2","description":"second pass","recommendedAction":"document"}]} -->
`;
      const findings = parseQaGapsMarker(output);
      expect(findings?.map((f) => f.description)).toEqual(["second pass"]);
    });

    it("returns null when no marker is present", () => {
      expect(parseQaGapsMarker("No marker here.")).toBeNull();
    });

    it("returns null for empty input", () => {
      expect(parseQaGapsMarker("")).toBeNull();
    });

    it("returns null (does not throw) on malformed JSON", () => {
      const output = `<!-- SEQUANT_QA_GAPS: {findings: not valid json} -->`;
      expect(() => parseQaGapsMarker(output)).not.toThrow();
      expect(parseQaGapsMarker(output)).toBeNull();
    });

    it("returns null when a finding is missing required evidence", () => {
      const output = `<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"test_gap","description":"d","recommendedAction":"fix_now"}]} -->`;
      expect(parseQaGapsMarker(output)).toBeNull();
    });

    it("returns null when the category is not one of the six", () => {
      const output = `<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"vibes_gap","evidence":"e","description":"d","recommendedAction":"fix_now"}]} -->`;
      expect(parseQaGapsMarker(output)).toBeNull();
    });

    it("ignores a marker written inside a fenced code block", () => {
      const output = [
        "Example format:",
        "```markdown",
        '<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"test_gap","evidence":"e","description":"example","recommendedAction":"fix_now"}]} -->',
        "```",
      ].join("\n");
      expect(parseQaGapsMarker(output)).toBeNull();
    });

    it("parses correctly even though the payload contains a nested object (not the flat-JSON marker family)", () => {
      // Regression guard: this marker's payload is an ARRAY of OBJECTS, so
      // it cannot use the `{[^}]+}` regex the flat markers (SEQUANT_SPEC,
      // SEQUANT_PHASE, SEQUANT_MUTATION) rely on — that stops at the first
      // `}` and would truncate mid-JSON here.
      const output = `<!-- SEQUANT_QA_GAPS: {"findings":[{"category":"dependency_gap","evidence":"e","description":"d","recommendedAction":"fix_now","affectedAcs":["AC-1","AC-2"]}]} -->`;
      const findings = parseQaGapsMarker(output);
      expect(findings).toHaveLength(1);
      expect(findings?.[0].affectedAcs).toEqual(["AC-1", "AC-2"]);
    });

    it("returns an empty array (not null) when findings is present but empty", () => {
      const output = `<!-- SEQUANT_QA_GAPS: {"findings":[]} -->`;
      expect(parseQaGapsMarker(output)).toEqual([]);
    });
  });
});
