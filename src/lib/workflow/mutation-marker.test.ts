import { describe, it, expect } from "vitest";
import {
  parseMutationMarkers,
  latestMutationMarkerPerAc,
  classifyMutationMarker,
} from "./mutation-marker.js";

describe("mutation-marker", () => {
  describe("parseMutationMarkers", () => {
    it("parses a valid SEQUANT_MUTATION marker", () => {
      const body = `Some PR description.

<!-- SEQUANT_MUTATION: {"ac":"AC-3","mutation":"removed payload fixture block","failedTest":"injection.test.ts > rejects payload"} -->
`;
      const markers = parseMutationMarkers(body);
      expect(markers).toEqual([
        {
          ac: "AC-3",
          mutation: "removed payload fixture block",
          failedTest: "injection.test.ts > rejects payload",
        },
      ]);
    });

    it("parses multiple markers in one PR body, in document order", () => {
      const body = `
<!-- SEQUANT_MUTATION: {"ac":"AC-1","mutation":"deleted section header","failedTest":"skill-a.test.ts > has section"} -->
<!-- SEQUANT_MUTATION: {"ac":"AC-2","mutation":"deleted branch","failedTest":"skill-b.test.ts > has branch"} -->
`;
      const markers = parseMutationMarkers(body);
      expect(markers.map((m) => m.ac)).toEqual(["AC-1", "AC-2"]);
    });

    it("skips a marker naming a test absent from the diff (rejected downstream by classifyMutationMarker, still parsed here)", () => {
      const body = `<!-- SEQUANT_MUTATION: {"ac":"AC-9","mutation":"deleted fixture","failedTest":"nonexistent.test.ts > some test"} -->`;
      const markers = parseMutationMarkers(body);
      expect(markers).toHaveLength(1);
      expect(markers[0].failedTest).toBe("nonexistent.test.ts > some test");
    });

    it("skips malformed JSON without throwing", () => {
      const body = `<!-- SEQUANT_MUTATION: {ac: not valid json} -->
<!-- SEQUANT_MUTATION: {"ac":"AC-4","mutation":"m","failedTest":"f.test.ts > t"} -->`;
      expect(() => parseMutationMarkers(body)).not.toThrow();
      const markers = parseMutationMarkers(body);
      expect(markers).toEqual([
        { ac: "AC-4", mutation: "m", failedTest: "f.test.ts > t" },
      ]);
    });

    it("skips a marker missing a required field", () => {
      const body = `<!-- SEQUANT_MUTATION: {"ac":"AC-5","mutation":"m"} -->`;
      expect(parseMutationMarkers(body)).toEqual([]);
    });

    it("ignores a marker written inside a fenced code block", () => {
      const body = [
        "Example format:",
        "```markdown",
        '<!-- SEQUANT_MUTATION: {"ac":"AC-1","mutation":"example","failedTest":"example.test.ts > example"} -->',
        "```",
      ].join("\n");
      expect(parseMutationMarkers(body)).toEqual([]);
    });

    it("returns an empty array when no marker is present", () => {
      expect(parseMutationMarkers("No markers here.")).toEqual([]);
    });
  });

  describe("latestMutationMarkerPerAc", () => {
    it("keeps the later marker when the same AC is declared twice", () => {
      const markers = parseMutationMarkers(`
<!-- SEQUANT_MUTATION: {"ac":"AC-2","mutation":"first attempt","failedTest":"a.test.ts > t"} -->
<!-- SEQUANT_MUTATION: {"ac":"AC-2","mutation":"corrected attempt","failedTest":"b.test.ts > t"} -->
`);
      const byAc = latestMutationMarkerPerAc(markers);
      expect(byAc.get("AC-2")?.mutation).toBe("corrected attempt");
      expect(byAc.size).toBe(1);
    });
  });

  describe("classifyMutationMarker", () => {
    it("classifies a marker naming a test present in the diff as valid", () => {
      const marker = {
        ac: "AC-3",
        mutation: "removed payload fixture",
        failedTest: "src/lib/__tests__/injection.test.ts > rejects payload",
      };
      const result = classifyMutationMarker(marker, [
        "src/lib/__tests__/injection.test.ts",
      ]);
      expect(result).toBe("valid");
    });

    it("classifies a marker naming a test absent from the diff as test_not_in_diff", () => {
      const marker = {
        ac: "AC-9",
        mutation: "deleted fixture",
        failedTest: "nonexistent.test.ts > some test",
      };
      const result = classifyMutationMarker(marker, [
        "src/lib/__tests__/injection.test.ts",
      ]);
      expect(result).toBe("test_not_in_diff");
    });

    it("classifies a marker against an empty diff test-file list as test_not_in_diff", () => {
      const marker = {
        ac: "AC-1",
        mutation: "m",
        failedTest: "f.test.ts > t",
      };
      expect(classifyMutationMarker(marker, [])).toBe("test_not_in_diff");
    });
  });

  describe("parseMutationMarkers(prBody, diffTestFiles) — AC-3's rejecting entry point", () => {
    it("attaches a valid classification when the failedTest file is in the diff", () => {
      const body = `<!-- SEQUANT_MUTATION: {"ac":"AC-3","mutation":"removed payload fixture","failedTest":"src/lib/__tests__/injection.test.ts > rejects payload"} -->`;
      const markers = parseMutationMarkers(body, [
        "src/lib/__tests__/injection.test.ts",
      ]);
      expect(markers).toEqual([
        {
          ac: "AC-3",
          mutation: "removed payload fixture",
          failedTest: "src/lib/__tests__/injection.test.ts > rejects payload",
          classification: "valid",
        },
      ]);
    });

    it("rejects (classifies test_not_in_diff) a marker naming a test absent from the diff, without dropping it", () => {
      const body = `<!-- SEQUANT_MUTATION: {"ac":"AC-9","mutation":"deleted fixture","failedTest":"nonexistent.test.ts > some test"} -->`;
      const markers = parseMutationMarkers(body, [
        "src/lib/__tests__/injection.test.ts",
      ]);
      expect(markers).toHaveLength(1);
      expect(markers[0].classification).toBe("test_not_in_diff");
    });

    it("classifies multiple markers independently in one call", () => {
      const body = `
<!-- SEQUANT_MUTATION: {"ac":"AC-1","mutation":"m1","failedTest":"real.test.ts > t"} -->
<!-- SEQUANT_MUTATION: {"ac":"AC-2","mutation":"m2","failedTest":"fake.test.ts > t"} -->
`;
      const markers = parseMutationMarkers(body, ["real.test.ts"]);
      expect(markers.map((m) => m.classification)).toEqual([
        "valid",
        "test_not_in_diff",
      ]);
    });

    it("with no second argument, returns plain markers with no classification field", () => {
      const body = `<!-- SEQUANT_MUTATION: {"ac":"AC-3","mutation":"m","failedTest":"f.test.ts > t"} -->`;
      const markers = parseMutationMarkers(body);
      expect(markers[0]).not.toHaveProperty("classification");
    });
  });
});
