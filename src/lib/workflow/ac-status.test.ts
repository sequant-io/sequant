/**
 * #1525 AC-1: the per-AC parse against #1524's hand-labelled fixture.
 * Offline: the fixture files only.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AcStatus,
  leadingIdsInBody,
  parseAcRows,
  parseAcStatuses,
} from "./ac-status.js";

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../__tests__/fixtures/qa-comments",
);

interface ExpectedEntry {
  issue: number;
  commentId: number;
  acs: Array<{ id: string; status: AcStatus }>;
}

const expected = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, "expected.json"), "utf-8"),
) as Record<string, ExpectedEntry>;

const readBody = (fixture: string): string =>
  fs.readFileSync(path.join(FIXTURE_DIR, fixture), "utf-8");

/**
 * The three ACs #1524 measured the parse getting wrong (its precision and
 * recall), pinned by `scripts/qa/ac-status-parse-coverage.test.ts`. Each
 * entry names what the parse reads instead of the label. A miss that appears
 * or disappears fails its fixture's case, whichever side moved: the parse
 * (checked against the overlay) or the `expected.json` label (checked to
 * still differ from the overlay, so an edit to a pinned label is not hidden).
 */
const KNOWN_MISSES: Record<string, Record<string, AcStatus>> = {
  // "## Closing — AC-3 resolved against the gate": no status token.
  "922-5236374780.md": { "AC-3": "unknown" },
  // "| AC-2 | MET (locally) / PENDING (CI) |": the first token wins.
  "1265-5933933577.md": { "AC-2": "met", "AC-7": "met" },
};

describe("parseAcStatuses against the qa-comments fixture (AC-1)", () => {
  it.each(Object.keys(expected).sort())(
    "fixture %s: every labelled AC parses to its expected.json status",
    (fixture) => {
      const entry = expected[fixture];
      const got = parseAcStatuses(
        readBody(fixture),
        entry.acs.map((a) => a.id),
      );
      const want = Object.fromEntries(
        entry.acs.map((a) => [a.id, KNOWN_MISSES[fixture]?.[a.id] ?? a.status]),
      );
      expect(Object.fromEntries(got)).toEqual(want);
      for (const [id, reads] of Object.entries(KNOWN_MISSES[fixture] ?? {})) {
        const label = entry.acs.find((a) => a.id === id)?.status;
        expect(
          label,
          `${fixture} ${id}: pinned miss has no label`,
        ).toBeDefined();
        expect(
          label,
          `${fixture} ${id}: label equals the pinned parse`,
        ).not.toBe(reads);
      }
    },
  );

  it("fixture 879-5167288457.md: an AC id absent from the comment yields unknown", () => {
    const body = readBody("879-5167288457.md");
    expect(body).not.toContain("AC-99");
    const got = parseAcStatuses(body, ["AC-1", "AC-99"]);
    expect(got.get("AC-99")).toBe("unknown");
    expect(got.get("AC-1")).toBe("met");
  });
});

describe("parseAcRows", () => {
  it("keeps the row text after the id as notes, separators trimmed", () => {
    const body =
      "| AC-1 | MET | `npx vitest run x` → 4 passed |\n- AC-2: ❌ not wired";
    const got = parseAcRows(body, ["AC-1", "AC-2", "AC-3"]);
    expect(got.get("AC-1")).toEqual({
      status: "met",
      notes: "MET | `npx vitest run x` → 4 passed",
    });
    expect(got.get("AC-2")).toEqual({
      status: "not_met",
      notes: "❌ not wired",
    });
    expect(got.get("AC-3")).toEqual({ status: "unknown" });
  });

  it("caps long row text at 200 characters", () => {
    const body = `| AC-1 | MET | ${"x".repeat(500)} |`;
    const notes = parseAcRows(body, ["AC-1"]).get("AC-1")?.notes ?? "";
    expect(notes.length).toBe(200);
    expect(notes.endsWith("…")).toBe(true);
  });

  it("matches ids case-insensitively against the declared list", () => {
    const got = parseAcRows("| AC-1 | MET |", ["ac-1"]);
    expect(got.get("AC-1")?.status).toBe("met");
  });
});

describe("leadingIdsInBody", () => {
  it("lists every id leading a status-carrying row, and no prose mention", () => {
    const body = [
      "| AC-1 | MET |",
      "| AC-7/8 | NOT_MET |",
      "AC-9 is MET in prose.",
      "| AC-10 | no status here |",
    ].join("\n");
    expect(leadingIdsInBody(body).sort()).toEqual(["AC-1", "AC-7", "AC-8"]);
  });
});
