/**
 * Tests for the shared dependency-marker parser (#767).
 *
 * Per AC-5, the negative/positive cases use the VERBATIM bodies of the issues
 * cited in #767's Evidence table — not synthetic fixtures. The real bodies are
 * saved under `__fixtures__/dependency-markers/` and loaded here, so a
 * false-negative hiding inside a real multi-marker body cannot slip through
 * (feedback_synthetic_test_fixture_trap).
 *
 * Corpus (from #767):
 *   Negatives — no dependency should be parsed:
 *     #19  prose:        "Use case: Issue 14 depends on 12+13 being merged first."
 *     #31  in-fence:     "**Depends on**: #10" inside a ```markdown fence
 *     #111 other issues: "- #11: Add login page (depends on #10)"
 *     #325 tool output:  "⚠ Depends on #175" inside a quoted status block
 *   Positives — the declared number should be parsed:
 *     #188 "- Depends on #187 ..."      → [187]
 *     #223 "- Depends on: #219 ..."     → [219]
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Mock `gh` so parseDependencies can be exercised without the network. Only the
// parseDependencies suite relies on this; the pure-parser suite ignores it.
vi.mock("child_process", () => ({ spawnSync: vi.fn() }));
import { spawnSync } from "child_process";
import { parseBodyDependencyMarkers } from "./dependency-markers.js";
import { parseDependencies } from "./batch-executor.js";

const mockSpawnSync = vi.mocked(spawnSync);

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "dependency-markers",
);

/** Load a verbatim issue-body fixture. */
function body(issue: number): string {
  return readFileSync(join(FIXTURE_DIR, `issue-${issue}.md`), "utf8");
}

// The sorter's marker set: `depends on` only (batch-executor.ts:parseDependencies).
const SORTER_MARKERS = ["depends on"] as const;
// The pre-flight's marker set: both markers (chain-preflight.ts).
const PREFLIGHT_MARKERS = ["depends on", "blocked by"] as const;

describe("parseBodyDependencyMarkers — verbatim negatives (AC-1)", () => {
  it("#19: ignores prose 'Issue 14 depends on 12+13' (no # / mid-sentence)", () => {
    expect(parseBodyDependencyMarkers(body(19), [...SORTER_MARKERS])).toEqual(
      [],
    );
  });

  it("#31: ignores '**Depends on**: #10' inside a ```markdown fence", () => {
    expect(parseBodyDependencyMarkers(body(31), [...SORTER_MARKERS])).toEqual(
      [],
    );
  });

  it("#111: ignores 'depends on #10' that describes OTHER issues in a list", () => {
    expect(parseBodyDependencyMarkers(body(111), [...SORTER_MARKERS])).toEqual(
      [],
    );
  });

  it("#325: ignores '⚠ Depends on #175' inside quoted tool output", () => {
    expect(parseBodyDependencyMarkers(body(325), [...SORTER_MARKERS])).toEqual(
      [],
    );
  });
});

describe("parseBodyDependencyMarkers — verbatim positives (AC-1)", () => {
  it("#188: parses line-leading '- Depends on #187' → [187]", () => {
    expect(parseBodyDependencyMarkers(body(188), [...SORTER_MARKERS])).toEqual([
      187,
    ]);
  });

  it("#223: parses line-leading '- Depends on: #219' → [219]", () => {
    expect(parseBodyDependencyMarkers(body(223), [...SORTER_MARKERS])).toEqual([
      219,
    ]);
  });
});

describe("parseBodyDependencyMarkers — the `#` is required (AC-2)", () => {
  it("does not parse 'depends on 12+13' as issue #12", () => {
    expect(
      parseBodyDependencyMarkers(
        "Issue 14 depends on 12+13 being merged first.\n",
        [...SORTER_MARKERS],
      ),
    ).toEqual([]);
  });

  it("does not parse a line-leading 'Depends on 12+13' either", () => {
    expect(
      parseBodyDependencyMarkers("Depends on 12+13\n", [...SORTER_MARKERS]),
    ).toEqual([]);
  });
});

describe("parseBodyDependencyMarkers — per-caller marker set (Open Q #1)", () => {
  const BLOCKED_BODY = "- Blocked by #36\n";

  it("the sorter set ('depends on' only) does NOT honor 'blocked by'", () => {
    expect(
      parseBodyDependencyMarkers(BLOCKED_BODY, [...SORTER_MARKERS]),
    ).toEqual([]);
  });

  it("the pre-flight set (both markers) DOES honor 'blocked by'", () => {
    expect(
      parseBodyDependencyMarkers(BLOCKED_BODY, [...PREFLIGHT_MARKERS]),
    ).toEqual([36]);
  });

  it("returns [] for an empty marker set", () => {
    expect(parseBodyDependencyMarkers("Depends on #5\n", [])).toEqual([]);
  });

  it("dedups and preserves first-seen order", () => {
    expect(
      parseBodyDependencyMarkers(
        "Depends on #10\nDepends on #11\nDepends on #10\n",
        [...SORTER_MARKERS],
      ),
    ).toEqual([10, 11]);
  });
});

describe("parseDependencies — label parsing unchanged (AC-3)", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  /** Build a `gh issue view --json body,labels` stdout payload. */
  function ghIssue(payload: { body?: string; labels?: { name: string }[] }) {
    return {
      status: 0,
      stdout: Buffer.from(JSON.stringify(payload)),
      stderr: Buffer.from(""),
      pid: 0,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>;
  }

  it("still parses a 'depends-on/123' label", () => {
    mockSpawnSync.mockReturnValue(
      ghIssue({ body: "", labels: [{ name: "depends-on/123" }] }),
    );
    expect(parseDependencies(1)).toEqual([123]);
  });

  it("still parses a 'depends-on-123' label", () => {
    mockSpawnSync.mockReturnValue(
      ghIssue({ body: "", labels: [{ name: "depends-on-123" }] }),
    );
    expect(parseDependencies(1)).toEqual([123]);
  });

  it("combines a line-leading body marker with a label, deduped", () => {
    mockSpawnSync.mockReturnValue(
      ghIssue({
        body: "- Depends on #187\n",
        labels: [{ name: "depends-on/187" }, { name: "bug" }],
      }),
    );
    expect(parseDependencies(1)).toEqual([187]);
  });

  it("hardened body parsing flows through: prose mention is ignored", () => {
    mockSpawnSync.mockReturnValue(
      ghIssue({
        body: "Use case: Issue 14 depends on 12+13 being merged first.\n",
        labels: [],
      }),
    );
    expect(parseDependencies(1)).toEqual([]);
  });

  it("the sorter does NOT reorder on a 'blocked by' body marker", () => {
    mockSpawnSync.mockReturnValue(
      ghIssue({ body: "- Blocked by #36\n", labels: [] }),
    );
    expect(parseDependencies(1)).toEqual([]);
  });
});
