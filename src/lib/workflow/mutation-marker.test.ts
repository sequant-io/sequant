import { describe, it, expect } from "vitest";
import {
  parseMutationMarkers,
  parseMutationMarkersFromExecOutput,
  renderMutationMarker,
  latestMutationMarkerPerAc,
  classifyMutationMarker,
} from "./mutation-marker.js";
import {
  recordToMarker,
  renderMutationMarkersFromState,
  type MutationRecord,
  type MutationState,
} from "./mutation-state.js";

describe("mutation-marker", () => {
  describe("renderMutationMarker round-trip (#1305)", () => {
    const base = { ac: "AC-2", mutation: "m", failedTest: "a.test.ts > d > c" };
    const cases = [
      [
        "mutation holds a regex quantifier",
        { ...base, mutation: "regex changed to /x{9}/" },
      ],
      ["ac holds a brace", { ...base, ac: "AC-2}" }],
      [
        "failedTest holds braces",
        { ...base, failedTest: "a.test.ts > {d} > c}" },
      ],
      ["mutation holds -->", { ...base, mutation: "dropped } --> tail" }],
      [
        "mutation holds an HTML comment with braces",
        { ...base, mutation: "dropped the <!-- guards:{count} slot" },
      ],
      [
        "mutation holds the marker opener",
        { ...base, mutation: "x <!-- SEQUANT_MUTATION: {} --> y" },
      ],
    ] as const;

    it.each(cases)("%s: round-trips through both entry points", (_n, m) => {
      const rendered = renderMutationMarker(m);
      expect(parseMutationMarkers(rendered)).toEqual([m]);
      expect(parseMutationMarkersFromExecOutput(rendered)).toEqual([m]);
    });

    it("never lets a rendered value end the comment early", () => {
      const rendered = renderMutationMarker({ ...base, mutation: "a --> b" });
      expect(rendered.indexOf("-->")).toBe(rendered.length - 3);
    });

    it("renders the failedTest ` > ` separators literally", () => {
      expect(renderMutationMarker(base)).toBe(
        '<!-- SEQUANT_MUTATION: {"ac":"AC-2","mutation":"m","failedTest":"a.test.ts > d > c"} -->',
      );
    });

    it("still parses a marker whose JSON spans lines", () => {
      const body =
        '<!-- SEQUANT_MUTATION: {"ac":"AC-3",\n"mutation":"m {x}",\n"failedTest":"a.test.ts > t"} -->';
      expect(parseMutationMarkers(body)).toEqual([
        { ac: "AC-3", mutation: "m {x}", failedTest: "a.test.ts > t" },
      ]);
    });

    it("parses a hand-written marker holding an HTML comment (PR #1035)", () => {
      const body =
        '<!-- SEQUANT_MUTATION: {"ac": "AC-4", "mutation": "changed the doc\'s guards:count slot from the computed 16 to 18", "failedTest": "src/lib/__tests__/security-docs.test.ts > matches the number in the doc\'s <!-- guards:count --> slot"} -->';
      expect(parseMutationMarkers(body)).toEqual([
        {
          ac: "AC-4",
          mutation:
            "changed the doc's guards:count slot from the computed 16 to 18",
          failedTest:
            "src/lib/__tests__/security-docs.test.ts > matches the number in the doc's <!-- guards:count --> slot",
        },
      ]);
    });

    it("does not let an unterminated marker swallow the next one", () => {
      const body = [
        '<!-- SEQUANT_MUTATION: {"ac":"AC-1","mutation":"m","failedTest":"x"}',
        '<!-- SEQUANT_MUTATION: {"ac":"AC-2","mutation":"m","failedTest":"y"} -->',
      ].join("\n");
      expect(parseMutationMarkers(body)).toEqual([
        { ac: "AC-2", mutation: "m", failedTest: "y" },
      ]);
    });
  });

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

  describe("round-trip from state (#1604)", () => {
    const record = (over: Partial<MutationRecord>): MutationRecord => ({
      ac: "AC-1",
      test: "src/commands/mutation.test.ts",
      name: "mutation begin > refuses a dirty tree",
      mutation: "deleted the dirty-tree check",
      mutatedExit: 1,
      restoredExit: 0,
      ranAt: "2026-10-26T12:00:00.000Z",
      sha: "abc123",
      ...over,
    });
    const state = (records: MutationRecord[]): MutationState => ({
      issue: 1604,
      sha: "abc123",
      startedAt: "2026-10-26T11:00:00.000Z",
      records,
    });

    it("parses back every record, including mutation text with braces, angle brackets and comment delimiters", () => {
      const records = [
        record({
          ac: "AC-1",
          mutation: "removed `if (dirty) { return 2; }` > the guard",
        }),
        record({
          ac: "AC-2",
          mutation: "emptied {}; then --> and <!-- in text",
          name: "d > c}",
        }),
      ];

      const body = renderMutationMarkersFromState(state(records)).join("\n");

      expect(parseMutationMarkers(body)).toEqual(records.map(recordToMarker));
      expect(parseMutationMarkers(body)[0].failedTest).toBe(
        "src/commands/mutation.test.ts > mutation begin > refuses a dirty tree",
      );
    });

    it("renders one marker per AC, the latest record winning, and nothing for no state", () => {
      const lines = renderMutationMarkersFromState(
        state([
          record({ ac: "AC-3", mutation: "first" }),
          record({ ac: "AC-3", mutation: "second > }" }),
        ]),
      );

      expect(lines).toHaveLength(1);
      expect(parseMutationMarkers(lines[0])[0].mutation).toBe("second > }");
      expect(renderMutationMarkersFromState(undefined)).toEqual([]);
    });
  });
});
