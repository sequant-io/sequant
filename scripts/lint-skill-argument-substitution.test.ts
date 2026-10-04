import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { findViolations, scanRoots } from "./lint-skill-argument-substitution.js";

describe("lint-skill-argument-substitution", () => {
  it("flags a bare $0 inside a fenced awk program", () => {
    const body = "```bash\nawk '{ print substr($0, 2) }'\n```\n";
    expect(findViolations(body).map((v) => v.line)).toEqual([2]);
  });

  it("rejects the backslash escape, which other drivers read literally", () => {
    expect(findViolations("awk '{ print \\$0 }'").map((v) => v.line)).toEqual([1]);
  });

  it("accepts the $(N) and -v field forms", () => {
    expect(
      findViolations("awk '{ print substr($(0), 2) }'\nawk -v n=2 '{ print $n, $NF }'"),
    ).toEqual([]);
  });

  it("accepts $ARGUMENTS and non-positional dollars", () => {
    expect(findViolations("$ARGUMENTS and $HOME and $(date)")).toEqual([]);
  });

  it("scans SKILL.md only, in every root", () => {
    const root = mkdtempSync(join(tmpdir(), "lint-subst-"));
    try {
      for (const dir of [".claude/skills", "templates/skills", "plugin/skills"]) {
        mkdirSync(join(root, dir, "x", "scripts"), { recursive: true });
        writeFileSync(join(root, dir, "x", "SKILL.md"), "awk '{print $1}'\n");
        writeFileSync(join(root, dir, "x", "scripts", "s.sh"), "awk '{print $1}'\n");
      }
      expect(scanRoots(root).map((v) => v.file).sort()).toEqual([
        ".claude/skills/x/SKILL.md",
        "plugin/skills/x/SKILL.md",
        "templates/skills/x/SKILL.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the shipped skills have no positional $N", () => {
    expect(scanRoots()).toEqual([]);
  });
});

describe("qa helper scripts", () => {
  const run = (script: string, input: string) =>
    execFileSync("bash", [`.claude/skills/qa/scripts/${script}`], {
      input,
      encoding: "utf8",
    });

  it("added-lines.sh strips the + and skips the +++ header", () => {
    const diff = "+++ b/f\n@@ -1 +1,2 @@\n+one\n two\n+three\n-gone\n";
    expect(run("added-lines.sh", diff)).toBe("one\nthree\n");
  });
});
