import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { join } from "path";
import { slugify } from "../worktree-manager.js";

const SCRIPT = join(process.cwd(), "templates/scripts/new-feature.sh");

function scriptBranch(issue: number, title: string): string {
  const r = spawnSync("bash", [SCRIPT, "--print-branch", String(issue), title], {
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  return r.stdout.trim();
}

describe("new-feature.sh branch name parity with slugify()", () => {
  const cases: Array<[string, string]> = [
    [
      "long slug with dash at position 50",
      "fix(init): --yes init replaces a user-modified AGENTS.md file silently",
    ],
    ["short title", "Fix the thing"],
    ["leading punctuation", "  --[WIP] (Fix) the thing!!"],
  ];

  it.each(cases)("%s", (_name, title) => {
    expect(scriptBranch(1123, title)).toBe(`feature/1123-${slugify(title)}`);
  });

  it("the long-slug fixture really exceeds 50 chars with a dash at 50", () => {
    const title = cases[0][1];
    const full = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    expect(full.length).toBeGreaterThan(50);
    expect(slugify(title)[49]).toBe("-");
  });
});
