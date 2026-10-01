/**
 * Gate test for #1247 AC-1 / AC-4: under `SEQUANT_ORCHESTRATOR` the exec
 * skill pushes but opens no PR, so `createPR` is the only PR producer (and
 * `--no-pr` therefore suppresses every producer).
 *
 * Scoped to two regions of each copy, never the whole file:
 * - `### PR Creation and Verification` up to the next `###` heading;
 * - the `in-place-checkout (#1136)` block, between its BEGIN/END markers.
 * All three copies are checked because the phase agent reads whichever one
 * its project installed. Each case walks the mirrored skill directory with
 * `collectFiles` (the skill-sync guard's own walker) to locate the file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { collectFiles } from "../../../scripts/check-skill-sync.js";
import { buildAutomatedPRBody } from "../workflow/worktree-manager.js";
import { parseMutationMarkers } from "../workflow/mutation-marker.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "../../..");
const SKILL_DIRS = [
  ".claude/skills/exec",
  "skills/exec",
  "templates/skills/exec",
];

const SKIP_LINE =
  "**Skip this section if `SEQUANT_ORCHESTRATOR` is set** - except step 1";

function readSkill(dir: string): string {
  const files = collectFiles(join(REPO_ROOT, dir));
  expect(files, `${dir} holds SKILL.md`).toContain("SKILL.md");
  return readFileSync(join(REPO_ROOT, dir, "SKILL.md"), "utf8");
}

function prCreationRegion(skill: string): string {
  const start = skill.indexOf("### PR Creation and Verification");
  expect(start, "PR Creation heading present").toBeGreaterThanOrEqual(0);
  const rest = skill.slice(start + 1);
  const next = rest.search(/\n### /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function inPlaceRegion(skill: string): string {
  const begin = skill.indexOf("<!-- BEGIN: in-place-checkout (#1136) -->");
  const end = skill.indexOf("<!-- END: in-place-checkout (#1136) -->");
  expect(begin, "in-place block present").toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return skill.slice(begin, end);
}

describe.each(SKILL_DIRS)(
  "%s exec skill: orchestrator is the only PR producer",
  (dir) => {
    it("PR Creation section opens with the orchestrator skip and forbids both PR tools", () => {
      const region = prCreationRegion(readSkill(dir));
      const firstParagraph = region.split("\n\n")[1] ?? "";
      expect(firstParagraph.startsWith(SKIP_LINE)).toBe(true);
      expect(firstParagraph).toContain("git push -u origin <branch>");
      expect(firstParagraph).toContain("no `gh pr create`");
      expect(firstParagraph).toContain("no GitHub MCP pull-request tool");
      expect(firstParagraph).toContain("`--no-pr`");
      // Standalone still creates the PR: the original steps follow the skip.
      expect(region).toContain("gh pr create --title");
    });

    it("the in-place block no longer lists PR creation as unchanged under the orchestrator", () => {
      const region = inPlaceRegion(readSkill(dir));
      expect(region).not.toContain("the mutation\n  record, PR creation and");
      expect(region).toContain(
        "PR creation is unchanged only when\n  standalone",
      );
      expect(region).toContain(
        "when orchestrated, open no PR by either means (#1247)",
      );
    });

    it("the markers the skip routes through `## Summary` reach the orchestrator's PR body", () => {
      const region = prCreationRegion(readSkill(dir));
      expect(region).toContain(
        "every `SEQUANT_MUTATION` marker inside that final `## Summary` section",
      );
      const failedTest =
        "src/lib/__tests__/exec-orchestrated-no-pr-skill.test.ts > x > y";
      const marker = `<!-- SEQUANT_MUTATION: ${JSON.stringify({ ac: "AC-1", mutation: "deleted the skip line", failedTest })} -->`;
      const body = buildAutomatedPRBody(1247, {
        execOutput: `notes\n## Summary\nDone.\n\n${marker}\n`,
      });
      const parsed = parseMutationMarkers(body, [
        "src/lib/__tests__/exec-orchestrated-no-pr-skill.test.ts",
      ]);
      expect(parsed.map((m) => [m.ac, m.classification])).toEqual([
        ["AC-1", "valid"],
      ]);
    });
  },
);
