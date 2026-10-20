import { describe, it, expect } from "vitest";

import { CAPTURES, assertReadOnly } from "./capture-gh-fixtures.js";
import { loadGhFixture } from "../src/lib/workflow/platforms/gh-fixtures.js";

describe("capture-gh-fixtures (#1506)", () => {
  it.each([
    [["issue", "comment", "1", "--body", "x"]],
    [["pr", "create", "--title", "t"]],
    [["pr", "merge", "7"]],
    [["issue", "edit", "1", "--add-label", "bug"]],
    [["label", "create", "x"]],
    [["api", "-X", "PATCH", "repos/o/r/pulls/7"]],
    [["api", "--method=DELETE", "repos/o/r"]],
    [["api", "graphql", "-f", "query=mutation"]],
    [["api", "repos/o/r/issues", "--input", "-"]],
  ])("refuses the writing call %j", (args) => {
    expect(() => assertReadOnly(args)).toThrow(/refusing to capture/);
  });

  it.each([
    [["issue", "view", "1", "--json", "title"]],
    [["pr", "list", "--state", "open"]],
    [["api", "repos/o/r/commits/abc/check-runs", "-q", ".check_runs"]],
    [["auth", "status"]],
  ])("allows the read-only call %j", (args) => {
    expect(() => assertReadOnly(args)).not.toThrow();
  });

  it("every capture is read-only and has a captured fixture on disk", () => {
    for (const capture of CAPTURES) {
      expect(() => assertReadOnly(capture.run ?? capture.args)).not.toThrow();
      const fixture = loadGhFixture(capture.name);
      expect(fixture.provenance).toBe("captured");
      expect(fixture.args).toEqual(capture.args);
      expect(fixture.command).toMatch(/^gh /);
    }
  });
});
