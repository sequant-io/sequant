/**
 * Skill-text gates for the worktree contract (#899).
 *
 * These lock down three claims that live only in prose, and were each wrong
 * for seven months:
 *
 *   - `/fullsolve` creates the worktree itself and exports a resolved path.
 *   - `/exec` verifies `SEQUANT_WORKTREE` before using it.
 *   - `/spec` does not claim to create a worktree.
 *
 * Per CLAUDE.md, assertions are scoped to the delimited region they mean to
 * check — matching the whole file would let an unrelated doc header or the
 * prose that *warns about* a glob satisfy the assertion. Each region is
 * delimited by `<!-- BEGIN: <name> -->` / `<!-- END: <name> -->` markers in
 * the SKILL.md files themselves.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** All three skill roots. `.claude/skills` is canonical; the others mirror it. */
const SKILL_ROOTS = [".claude/skills", "templates/skills", "skills"] as const;

function readSkill(root: string, skill: string): string {
  const file = path.join(REPO_ROOT, root, skill, "SKILL.md");
  if (!existsSync(file)) throw new Error(`Missing skill file: ${file}`);
  return readFileSync(file, "utf8");
}

/**
 * Extract the text between `<!-- BEGIN: name -->` and `<!-- END: name -->`.
 *
 * Throws when the region is absent, so deleting the markers fails the test
 * loudly rather than silently reducing it to a vacuous assertion on "".
 */
function region(content: string, name: string): string {
  const begin = content.indexOf(`<!-- BEGIN: ${name}`);
  const end = content.indexOf(`<!-- END: ${name}`);
  if (begin === -1 || end === -1 || end <= begin) {
    throw new Error(`Region "${name}" not found (begin=${begin}, end=${end})`);
  }
  return content.slice(begin, end);
}

/** Every `export SEQUANT_WORKTREE=...` line, across the whole file. */
function worktreeExports(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => /^\s*export\s+SEQUANT_WORKTREE=/.test(line));
}

describe.each(SKILL_ROOTS)("worktree contract in %s", (root) => {
  describe("fullsolve", () => {
    it("creates the worktree itself via new-feature.sh (AC-1)", () => {
      const body = region(
        readSkill(root, "fullsolve"),
        "worktree-creation (#899)",
      );

      expect(body).toContain("./scripts/new-feature.sh");
      expect(body).toContain("sequant worktree resolve");
    });

    it("exports no globbed SEQUANT_WORKTREE value (AC-2)", () => {
      const exports = worktreeExports(readSkill(root, "fullsolve"));

      // Guard against the assertion going vacuous if the exports are renamed.
      expect(exports.length).toBeGreaterThanOrEqual(3);
      for (const line of exports) {
        expect(line).not.toContain("*");
      }
    });

    it("does not claim /spec creates the worktree (AC-7)", () => {
      const content = readSkill(root, "fullsolve");

      // The false claim was a bullet under "The `/spec` skill will:".
      const specBullets = content.slice(
        content.indexOf("The `/spec` skill will:"),
      );
      expect(specBullets.indexOf("The `/spec` skill will:")).toBe(0);
      expect(specBullets.slice(0, 400)).not.toMatch(
        /^-\s*Create feature worktree\s*$/m,
      );

      // And the stale orchestration note that attributed creation to /spec.
      expect(content).not.toContain("already done by `/spec`");
    });
  });

  describe("exec", () => {
    it("guards SEQUANT_WORKTREE existence before use (AC-3)", () => {
      const body = region(
        readSkill(root, "exec"),
        "worktree-existence-guard (#899)",
      );

      expect(body).toContain("sequant worktree verify");
      expect(body).toContain("SEQUANT_WORKTREE_NOT_FOUND");
      // The guard must halt, not fall through to the current directory.
      expect(body).toContain("exit 1");
    });

    it("names the foreign-worktree failure mode (AC-4)", () => {
      const body = region(
        readSkill(root, "exec"),
        "worktree-existence-guard (#899)",
      );

      expect(body).toContain("SEQUANT_WORKTREE_FOREIGN");
    });

    it("resolves the standalone lookup through git, not a filesystem glob (AC-5, AC-6)", () => {
      const body = region(
        readSkill(root, "exec"),
        "worktree-standalone-lookup (#899)",
      );

      expect(body).toContain("sequant worktree resolve");
      expect(body).toContain("git worktree list");

      // The old instruction — "check if `../worktrees/` contains a directory
      // for this issue" — must not survive as a directive. The region does
      // mention the glob, but only inside a "Do not" prohibition.
      const globMentions = body
        .split("\n")
        .filter((line) => line.includes("../worktrees/"));
      expect(globMentions.length).toBeGreaterThan(0);
      for (const line of globMentions) {
        expect(line).toMatch(/Do not glob|shared by every sibling repository/);
      }
    });
  });

  describe("spec", () => {
    it("states the worktree contract explicitly (AC-8)", () => {
      const body = region(
        readSkill(root, "spec"),
        "spec-worktree-contract (#899)",
      );

      expect(body).toContain("Planning happens in the main repository");
      expect(body).toMatch(/orchestrator/i);
      expect(body).toContain("/exec");
    });

    it("never instructs creating a worktree", () => {
      const content = readSkill(root, "spec");

      expect(content).not.toContain("./scripts/new-feature.sh");
      expect(content).not.toContain("git worktree add");
    });
  });
});
