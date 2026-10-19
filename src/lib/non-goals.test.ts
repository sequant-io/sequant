/**
 * Tests for the shared Non-Goals scanner (#1474) — pins each D-7 heading rule
 * and the item clean-up directly.
 */

import { describe, it, expect } from "vitest";
import { parseNonGoals, scanNonGoals } from "./non-goals.js";

describe("scanNonGoals", () => {
  it("opens a section on a heading with trailing text after the keyword", () => {
    const body = "## Out of scope (deferred, not rejected)\n- Probe sessions\n";
    expect(scanNonGoals(body)).toEqual({
      items: ["Probe sessions"],
      found: true,
    });
  });

  it("opens a section on a ### heading", () => {
    const body = "### Non-Goals\n- Feature X\n";
    expect(scanNonGoals(body).items).toEqual(["Feature X"]);
  });

  it("unions several Non-Goals sections and stops at other headings", () => {
    const body = [
      "## Non-goals",
      "- First",
      "## Risks",
      "- Not a non-goal",
      "## Non-Goals",
      "- Second",
    ].join("\n");
    expect(scanNonGoals(body).items).toEqual(["First", "Second"]);
  });

  it("keeps an item that starts with '#'", () => {
    const body = "## Non-Goals\n- #1297 (exec summary). Run it sequentially.\n";
    expect(scanNonGoals(body).items).toEqual([
      "#1297 (exec summary). Run it sequentially.",
    ]);
  });

  it("strips a task-list checkbox and markdown emphasis", () => {
    const body =
      "## Non-Goals\n- [ ] Backend `API` changes\n* [x] **DB** work\n";
    expect(scanNonGoals(body).items).toEqual([
      "Backend API changes",
      "DB work",
    ]);
  });

  it("reports found with zero items for an empty section", () => {
    expect(scanNonGoals("## Non-Goals\n\n## Implementation\n")).toEqual({
      items: [],
      found: true,
    });
  });

  it("reports not found when no section exists", () => {
    expect(scanNonGoals("## Problem\n- Something\n")).toEqual({
      items: [],
      found: false,
    });
    expect(scanNonGoals("")).toEqual({ items: [], found: false });
  });

  it("ignores a Non-Goals heading inside a fenced code block", () => {
    const body = "```markdown\n## Non-Goals\n- Fenced example\n```\n";
    expect(scanNonGoals(body)).toEqual({ items: [], found: false });
  });
});

describe("parseNonGoals", () => {
  it("returns the scanned items", () => {
    expect(parseNonGoals("## Non-goals\n- Auto-merge\n")).toEqual([
      "Auto-merge",
    ]);
  });
});
