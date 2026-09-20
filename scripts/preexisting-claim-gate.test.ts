/**
 * Gate tests for the mechanical "pre-existing failure" proof (#1093).
 *
 * These assert that the rule is *written where it is enforced*, in every
 * mirrored copy of the skills — not merely that the words appear somewhere in
 * a 3,700-line file. Every assertion is scoped to the delimited section that
 * is supposed to carry it (CLAUDE.md §Testing), so a doc header, a changelog
 * line, or an unrelated mention cannot satisfy it.
 *
 * The three skill roots are enumerated through `collectFiles`, the same
 * production function `lint:skill-sync` uses, rather than by hardcoding the
 * file list: if a skill's file layout changes, this gate follows it instead of
 * silently passing on a path that no longer exists.
 *
 * No regex literals here on purpose. The tautology detector's brace counter
 * truncates a block at the first `{` it meets inside `it()`, and a quantifier
 * like `#{2,3}` is enough to do it — so section boundaries are found by string
 * prefix matching.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { collectFiles } from "./check-skill-sync.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

/** Every mirrored skill root, canonical first. */
const SKILL_ROOTS = [".claude/skills", "templates/skills", "skills"];

/**
 * Absolute paths to one skill's `SKILL.md` in each root, located structurally.
 *
 * Fails loudly if a root does not carry the skill, so a missing mirror is a
 * red test rather than a silently shorter list of files to check.
 */
function skillCopies(skill: string): string[] {
  const wanted = `${skill}/SKILL.md`;
  return SKILL_ROOTS.map((root) => {
    const base = join(PROJECT_ROOT, root);
    const found = collectFiles(base).find((rel) => rel === wanted);
    if (!found) {
      throw new Error(`${wanted} not found under ${root}`);
    }
    return join(base, found);
  });
}

/**
 * The lines of one markdown section: from the line starting with `heading` up
 * to the next heading at `##` or `###` depth, fenced blocks passed through
 * whole so a `### ` inside an output template does not end the section early.
 */
function sectionLines(content: string, heading: string): string[] {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return [];

  const out: string[] = [lines[start]];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("```")) {
      fenced = !fenced;
    } else if (
      !fenced &&
      (line.startsWith("## ") || line.startsWith("### "))
    ) {
      break;
    }
    out.push(line);
  }
  return out;
}

function sectionText(content: string, heading: string): string {
  return sectionLines(content, heading).join("\n");
}

function read(path: string): string {
  return readFileSync(path, "utf-8");
}

describe("preexisting claim gate", () => {
  it("exec skill names the settle script in its red-test section, in all three copies", () => {
    const copies = skillCopies("exec");
    expect(copies).toHaveLength(3);

    for (const path of copies) {
      const section = sectionText(read(path), "### 3. Checks-first Mindset");
      expect(section, path).not.toBe("");
      // The script is named, with its path, inside the section that tells the
      // agent what to do about a red test it did not cause.
      expect(section, path).toContain("scripts/settle-against-base.sh");
      expect(section, path).toContain("### Settled against base");
      expect(section, path).toContain("every");
    }
  });

  it("qa skill rejects an unbacked pre-existing claim, in all three copies", () => {
    const copies = skillCopies("qa");
    expect(copies).toHaveLength(3);

    for (const path of copies) {
      const content = read(path);

      // The check section defines the status and declares the floor.
      const check = sectionText(
        content,
        "### 2a. Build & Red-Test Verification",
      );
      expect(check, path).not.toBe("");
      expect(check, path).toContain("settle_evidence_status");
      expect(check, path).toContain("Unbacked");
      expect(check, path).toContain("scripts/settle-against-base.sh");
      expect(check, path).toContain("floor the verdict at");

      // The verdict section carries the status as a real gate: a step-2 token
      // attributed to Section 2a, and a step-4 branch on that token.
      const verdict = sectionText(content, "### 7. A+ Status Verdict");
      expect(verdict, path).not.toBe("");

      const tokenLine = sectionLines(content, "### 7. A+ Status Verdict").find(
        (line) =>
          line.includes("settle_evidence_status =") &&
          line.includes("Section 2a"),
      );
      expect(tokenLine, `${path}: §7 step 2 token`).toBeDefined();

      const branchLine = sectionLines(content, "### 7. A+ Status Verdict").find(
        (line) =>
          line.includes("IF settle_evidence_status") &&
          line.includes('"Unbacked"'),
      );
      expect(branchLine, `${path}: §7 step 4 branch`).toBeDefined();
    }
  });

  it("red-main rule is stated in CLAUDE.md", () => {
    const section = sectionText(
      read(join(PROJECT_ROOT, "CLAUDE.md")),
      "## Red main",
    );
    expect(section).not.toBe("");
    // Order of operations: revert first, debug second.
    expect(section).toContain("reverted first and debugged second");
    // And the revert is traceable back to the run that justified it.
    expect(section).toContain("revert PR references the failing run");
    // The rule names the gate that makes a red main everyone's problem.
    expect(section).toContain("scripts/ruleset-main.sh");

    // The release skill must repeat CLAUDE.md's own wording, not an
    // independently hardcoded paraphrase — reword the rule in one place and
    // this fails, which is the drift a two-sided literal assertion misses.
    for (const path of skillCopies("release")) {
      const git = sectionText(read(path), "### Git Checks");
      expect(git, path).not.toBe("");
      expect(git, path).toContain("reverted first and debugged second");
    }
  });

  it("red-main rule is repeated by the release skill in all three copies", () => {
    const copies = skillCopies("release");
    expect(copies).toHaveLength(3);

    for (const path of copies) {
      const section = sectionText(read(path), "### Git Checks");
      expect(section, path).not.toBe("");
      expect(section, path).toContain("reverted first and debugged second");
      expect(section, path).toContain("revert PR references the failing run");
    }
  });
});
