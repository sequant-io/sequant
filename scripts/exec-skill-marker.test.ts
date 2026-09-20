import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseMutationMarkers } from "../src/lib/workflow/mutation-marker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXEC_SKILL = join(__dirname, "../.claude/skills/exec/SKILL.md");
const HEADING = "### Recording the mutation result";

/** The section from its heading to the next `#`-heading, skipping fenced blocks. */
function markerSection(content: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.startsWith(HEADING));
  if (start === -1) return "";
  const out: string[] = [lines[start]];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (!fenced && /^#{1,3} /.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

describe("exec skill marker section", () => {
  it("exec skill documents the SEQUANT_MUTATION failedTest file prefix", () => {
    const section = markerSection(readFileSync(EXEC_SKILL, "utf-8"));
    expect(section).toContain("SEQUANT_MUTATION");
    expect(section).toContain('"failedTest":"scripts/');
    expect(section).toContain(" > <describe> > <case>");
  });

  it("the section's example marker classifies valid against the classifier it documents", () => {
    const section = markerSection(readFileSync(EXEC_SKILL, "utf-8"));
    // Line-based on purpose: a brace-bearing regex here would truncate the
    // block for the tautology detector's brace counter.
    const example =
      section.split("\n").find((l) => l.startsWith("<!-- SEQUANT_MUTATION:")) ??
      "";
    expect(example).not.toBe("");
    const [marker] = parseMutationMarkers(example, [
      "scripts/exec-skill-marker.test.ts",
    ]);
    expect(marker?.classification).toBe("valid");
  });
});
