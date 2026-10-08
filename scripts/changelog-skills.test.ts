import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { collate } from "./changelog-collate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skill = (name: string, base = ".claude/skills") =>
  readFileSync(join(root, base, name, "SKILL.md"), "utf-8");

/** Text from the line starting `from` up to (excluding) the line starting `to`. */
function region(text: string, from: string, to: string): string {
  const lines = text.split("\n");
  const a = lines.findIndex((l) => l.startsWith(from));
  const b = lines.findIndex((l, i) => i > a && l.startsWith(to));
  return a === -1 || b === -1 ? "" : lines.slice(a, b).join("\n");
}
/** Bash fenced blocks inside a region. */
function bashBlocks(text: string): string[] {
  return [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "clskill-"));
  dirs.push(d);
  return d;
}

describe("changelog skills (#1351)", { timeout: 30_000 }, () => {
  it.each([".claude/skills", "templates/skills", "plugin/skills"])(
    "exec §3f in %s names changelog.d and never tells the agent to edit [Unreleased]",
    (base) => {
      const s = region(skill("exec", base), "### 3f.", "### 3g.");
      expect(s).toContain("changelog.d/");
      expect(s).not.toMatch(/Edit tool to add an entry under/);
      // The documented fragment example must parse with the real parser.
      const example = bashBlocks(
        s.replace(/```markdown/g, "```bash"),
      )[0].replace(/^ +/gm, "");
      const d = tmp();
      mkdirSync(join(d, "changelog.d"));
      writeFileSync(join(d, "changelog.d", "5-x.md"), example);
      writeFileSync(join(d, "CHANGELOG.md"), "## [Unreleased]\n");
      expect(collate(d, "1.0.0", "2026-01-01").count).toBe(1);
    },
  );

  it.each([".claude/skills", "templates/skills", "plugin/skills"])(
    "release Step 3 in %s collates fragments and its extraction reads the new section",
    (base) => {
      const rel = skill("release", base);
      const step3 = region(rel, "### Step 3:", "### Step 4:");
      expect(step3).toContain("changelog:collate");
      expect(step3).not.toMatch(/Replace `## \[Unreleased\]`/);
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      expect(pkg.scripts["changelog:collate"]).toContain(
        "changelog-collate.ts",
      );

      // Run the documented feature-bullet extraction against a really-collated file.
      const d = tmp();
      mkdirSync(join(d, "changelog.d"));
      writeFileSync(join(d, "package.json"), '{"version":"3.0.0"}');
      writeFileSync(
        join(d, "changelog.d", "7-a.md"),
        "kind: Added\n\nShiny (#7)\n",
      );
      writeFileSync(
        join(d, "CHANGELOG.md"),
        "## [Unreleased]\n\n## [2.0.0] - 2026-01-01\n\n### Added\n\n- old (#1)\n",
      );
      collate(d, "3.0.0", "2026-02-02");
      const block = bashBlocks(
        region(
          rel,
          "Extract features from the new",
          "**If CHANGELOG has features**",
        ),
      )[0];
      const out = execFileSync("bash", ["-c", block], {
        cwd: d,
        encoding: "utf-8",
      });
      expect(out).toContain("- Shiny (#7)");
      expect(out).not.toContain("old (#1)");
    },
  );

  it("qa §10a detection counts a fragment added by the branch (AC-6)", () => {
    const q = region(skill("qa"), "### 10a.", "**Verification Logic:**");
    const line =
      q.split("\n").find((l) => l.startsWith("fragment_entries=")) ?? "";
    expect(line).not.toBe("");
    const d = tmp();
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", d, ...a], { encoding: "utf-8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(d, "a.txt"), "x");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-q", "-b", "feat");
    mkdirSync(join(d, "changelog.d"));
    writeFileSync(join(d, "changelog.d", "9-x.md"), "kind: Added\n\nx (#9)\n");
    git("add", "-A");
    git("commit", "-q", "-m", "feat");
    const out = execFileSync(
      "bash",
      ["-c", `${line}\necho "$fragment_entries"`],
      { cwd: d, encoding: "utf-8" },
    );
    expect(out.trim()).toBe("changelog.d/9-x.md");
  });
});
