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
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** All three skill roots. `.claude/skills` is canonical; the others mirror it. */
const SKILL_ROOTS = [".claude/skills", "templates/skills", "skills"] as const;

/**
 * Skills the orchestrator hands `SEQUANT_WORKTREE` and which therefore need
 * the existence guard before they `cd` into it (#899 for exec, #904 for the
 * rest). `/testgen` is absent deliberately: it has no orchestrated path.
 */
const EXISTENCE_GUARD_SKILLS = ["exec", "qa", "loop"] as const;

/**
 * Skills that locate a worktree themselves when run standalone. `/testgen`
 * joins this list — it writes test files, so landing in a sibling project's
 * worktree scatters stubs into an unrelated repo.
 */
const STANDALONE_LOOKUP_SKILLS = ["exec", "qa", "loop", "testgen"] as const;

function readSkill(root: string, skill: string): string {
  const file = path.join(REPO_ROOT, root, skill, "SKILL.md");
  if (!existsSync(file)) throw new Error(`Missing skill file: ${file}`);
  return readFileSync(file, "utf8");
}

/** Every skill directory under a root that has a SKILL.md. */
function allSkills(root: string): string[] {
  const dir = path.join(REPO_ROOT, root);
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        existsSync(path.join(dir, e.name, "SKILL.md")),
    )
    .map((e) => e.name)
    .sort();
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

/** Non-throwing `region`, for the completeness sweep over every skill. */
function tryRegion(content: string, name: string): string | null {
  try {
    return region(content, name);
  } catch {
    return null;
  }
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

  // The same two defects existed in every skill the orchestrator hands
  // SEQUANT_WORKTREE to, not only /exec. `/qa` reviewed the wrong tree,
  // `/loop` and `/testgen` *wrote* into it. #904.
  describe.each(EXISTENCE_GUARD_SKILLS)("%s existence guard", (skill) => {
    it("verifies SEQUANT_WORKTREE before use and halts on failure", () => {
      const body = region(
        readSkill(root, skill),
        "worktree-existence-guard (#899)",
      );

      expect(body).toContain("sequant worktree verify");
      expect(body).toContain("exit 1");
      for (const code of [
        "SEQUANT_WORKTREE_NOT_FOUND",
        "SEQUANT_WORKTREE_FOREIGN",
        "SEQUANT_WORKTREE_ISSUE_MISMATCH",
      ]) {
        expect(body).toContain(code);
      }
    });
  });

  describe.each(STANDALONE_LOOKUP_SKILLS)("%s standalone lookup", (skill) => {
    it("resolves through git rather than globbing the shared directory", () => {
      const body = region(
        readSkill(root, skill),
        "worktree-standalone-lookup (#899)",
      );

      expect(body).toContain("sequant worktree resolve");
      for (const line of body.split("\n")) {
        if (!line.includes("../worktrees/")) continue;
        expect(line).toMatch(
          /Do not glob|shared by every sibling repository|which reports only/,
        );
      }
    });
  });

  // Completeness invariants. The bug reached five skills by being copied, so
  // pinning the three known sites is not enough — these fail on a NEW skill
  // that reintroduces either pattern.
  describe("no unguarded worktree adoption anywhere", () => {
    it("every `cd $SEQUANT_WORKTREE` sits inside a verify-bearing guard region", () => {
      const offenders: string[] = [];

      for (const skill of allSkills(root)) {
        const content = readSkill(root, skill);
        if (!/cd\s+"?\$SEQUANT_WORKTREE"?/.test(content)) continue;

        const guard = tryRegion(content, "worktree-existence-guard (#899)");
        // Every occurrence must be inside the guard, and the guard must verify.
        const outside = guard ? content.split(guard).join("") : content;
        if (
          !guard ||
          !guard.includes("sequant worktree verify") ||
          /cd\s+"?\$SEQUANT_WORKTREE"?/.test(outside)
        ) {
          offenders.push(skill);
        }
      }

      expect(offenders).toEqual([]);
    });

    it("no skill instructs globbing ../worktrees/ or grepping the worktree list", () => {
      const offenders: string[] = [];

      for (const skill of allSkills(root)) {
        for (const line of readSkill(root, skill).split("\n")) {
          const globs = /(^|[^`])(ls|cat|cd)\s+\.\.\/worktrees\/feature\//.test(
            line,
          );
          // Only issue-KEYED selection is a defect. `[^|]*` lets a flag sit
          // between the command and the pipe (the `--porcelain` form), while
          // the pattern check spares structural field greps like
          // `grep "^worktree"`, which enumerate every worktree rather than
          // picking one and therefore cannot mis-select.
          // Capture only grep's own argument (up to the next pipe) —
          // trailing stages such as `| cut -d' ' -f2` carry digits that
          // would otherwise read as an issue number.
          const pipedGrep = /git worktree list[^|]*\|\s*grep\s+([^|]*)/.exec(
            line,
          );
          const greps =
            pipedGrep !== null &&
            /\$ISSUE|<issue-number>|<N>|feature\/|[0-9]/.test(pipedGrep[1]) &&
            !/do not grep/i.test(line);
          if (globs || greps) offenders.push(`${skill}: ${line.trim()}`);
        }
      }

      expect(offenders).toEqual([]);
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
