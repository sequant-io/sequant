// Gate test for #993 AC-4 — every recorded `claude plugin eval` result under
// `evals/results/` must carry a `fixture_commit` field, and that commit must
// be an ancestor of HEAD. Without this, a result can be credited forever to a
// fixture version that has since been edited or deleted (the #830 failure
// class this issue's cases exist to catch).

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const RESULTS_DIR = join(process.cwd(), "evals", "results");

function isAncestor(sha: string): boolean {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", sha, "HEAD"],
    { encoding: "utf-8" },
  );
  return result.status === 0;
}

function listResultFiles(): string[] {
  return readdirSync(RESULTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);
}

describe("evals/results fixture_commit gate (#993 AC-4)", () => {
  const files = listResultFiles();

  it("finds at least one recorded eval result", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s carries a fixture_commit", (file) => {
    const data = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf-8"));
    expect(typeof data.fixture_commit).toBe("string");
    expect(data.fixture_commit.length).toBeGreaterThan(0);
  });

  it.each(files)("%s's fixture_commit is an ancestor of HEAD", (file) => {
    const data = JSON.parse(readFileSync(join(RESULTS_DIR, file), "utf-8"));
    expect(isAncestor(data.fixture_commit)).toBe(true);
  });

  it("rejects a fixture_commit that is not an ancestor of HEAD", () => {
    // A commit-shaped SHA that does not exist in this repo's object
    // database. Not-an-ancestor and not-found are both correctly rejected —
    // this is the negative control proving the gate isn't vacuous.
    expect(isAncestor("0000000000000000000000000000000000000000")).toBe(false);
  });
});
