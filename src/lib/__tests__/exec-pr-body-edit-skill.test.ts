/**
 * Gate test for #1302 AC-1 / AC-2: under `SEQUANT_ORCHESTRATOR` a phase agent
 * never edits the PR body or title; exec routes content through its final
 * `## Summary` and QA's mutation-marker gap names that Summary.
 *
 * Scoped to two regions of each mirrored copy, never the whole file:
 * - exec: `### PR Creation and Verification` up to the next `###` heading;
 * - qa: `### 6i. Mutation Verification` up to the next `###` heading.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  collectFiles,
  SKILL_ROOTS,
} from "../../../scripts/check-skill-sync.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");

function readSkill(dir: string): string {
  const files = collectFiles(join(REPO_ROOT, dir));
  expect(files, `${dir} holds SKILL.md`).toContain("SKILL.md");
  return readFileSync(join(REPO_ROOT, dir, "SKILL.md"), "utf8");
}

function region(skill: string, heading: string): string {
  const start = skill.indexOf(heading);
  expect(start, `${heading} present`).toBeGreaterThanOrEqual(0);
  const rest = skill.slice(start + 1);
  const next = rest.search(/\n### /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

describe.each(SKILL_ROOTS)("%s: no phase edits the PR body", (root) => {
  it("exec PR Creation section forbids body/title edits and routes to the final Summary", () => {
    const text = region(
      readSkill(`${root}/exec`),
      "### PR Creation and Verification",
    );
    expect(text).toContain("Do not change the PR's body or title by any means");
    expect(text).toContain("no `gh pr edit`");
    expect(text).toContain("no `gh api` PATCH on `pulls/N`");
    expect(text).toContain("no MCP tool");
    expect(text).toContain("put it in your final `## Summary`");
  });

  it("qa 6i Missing gap names exec's final Summary, not the PR body", () => {
    const text = region(
      readSkill(`${root}/qa`),
      "### 6i. Mutation Verification",
    );
    expect(text).toContain(
      "\"add the markers to exec's final `## Summary`\", never to the PR body",
    );
  });
});
