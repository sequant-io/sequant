/**
 * Skill-text gates for the explicit in-place checkout mode (#1136).
 *
 * `SEQUANT_CHECKOUT=in-place` runs a phase on a feature branch in the current
 * clone, for checkouts that have no worktree (a claude.ai cloud session). The
 * claims locked down here live only in prose:
 *
 *   - `/exec` creates `feature/<N>-<slug>` in the clone and never reaches the
 *     worktree machinery (AC-1).
 *   - `/qa` (and `/loop`, `/testgen`, which also resolve a worktree) treat
 *     `$PWD` as the worktree and halt on the base branch (AC-2).
 *   - The mode is never inferred: every mention of the flag sits inside a
 *     delimited in-place region, so the #899 guards read exactly as before
 *     when it is unset (AC-3).
 *
 * Per CLAUDE.md, assertions are scoped to the delimited regions
 * (`<!-- BEGIN: in-place-checkout… -->` / `<!-- END: in-place-checkout… -->`),
 * never the whole file.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");

const SKILL_ROOTS = [".claude/skills", "templates/skills", "skills"] as const;

/** Skills besides /exec that locate a worktree and so need the in-place entry. */
const RESOLVING_SKILLS = ["qa", "loop", "testgen"] as const;

const MAIN_REGION = "in-place-checkout (#1136)";

/** The worktree machinery in-place mode must never invoke. */
const WORKTREE_CALLS = [
  "new-feature.sh",
  "git worktree add",
  "sequant worktree resolve",
] as const;

function readSkill(root: string, skill: string): string {
  const file = path.join(REPO_ROOT, root, skill, "SKILL.md");
  if (!existsSync(file)) throw new Error(`Missing skill file: ${file}`);
  return readFileSync(file, "utf8");
}

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

interface Region {
  name: string;
  start: number;
  end: number;
  body: string;
}

/**
 * Every `<!-- BEGIN: in-place-checkout… -->` … `<!-- END: <same name> -->`
 * region in the file, with its character offsets. An unmatched BEGIN throws,
 * so deleting an END marker fails loudly rather than widening a region.
 */
function inPlaceRegions(content: string): Region[] {
  const regions: Region[] = [];
  const begin = /<!-- BEGIN: (in-place-checkout[^>]*?) -->/g;
  for (let m = begin.exec(content); m !== null; m = begin.exec(content)) {
    const name = m[1];
    const endMarker = `<!-- END: ${name} -->`;
    const end = content.indexOf(endMarker, m.index);
    if (end === -1) throw new Error(`Region "${name}" has no END marker`);
    regions.push({
      name,
      start: m.index,
      end: end + endMarker.length,
      body: content.slice(m.index, end),
    });
  }
  return regions;
}

/** The named region, throwing when it is absent. */
function region(content: string, name: string): Region {
  const found = inPlaceRegions(content).find((r) => r.name === name);
  if (!found) throw new Error(`Region "${name}" not found`);
  return found;
}

/** Concatenated bodies of every fenced code block in `text`. */
function codeBlocks(text: string): string {
  return [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
    .map((m) => m[1])
    .join("\n");
}

/** `text` with its fenced code blocks removed, leaving the prose. */
function prose(text: string): string {
  return text.replace(/```[a-z]*\n[\s\S]*?```/g, "");
}

describe.each(SKILL_ROOTS)("in-place checkout mode in %s", (root) => {
  describe("exec", () => {
    it("creates feature/<N>-<slug> from origin/<base> when on the base branch (AC-1)", () => {
      const code = codeBlocks(region(readSkill(root, "exec"), MAIN_REGION).body);

      // Entered only by the explicit flag.
      expect(code).toContain('"${SEQUANT_CHECKOUT:-}" == "in-place"');
      // On the base branch (or detached), branch from the remote base.
      expect(code).toContain('"$CURRENT" == "$BASE"');
      expect(code).toContain("feature/<issue-number>-${SLUG}");
      expect(code).toContain('git checkout -b "$BRANCH" "origin/$BASE"');
    });

    it("never invokes new-feature.sh, git worktree add, or worktree resolve (AC-1)", () => {
      const body = region(readSkill(root, "exec"), MAIN_REGION).body;

      const code = codeBlocks(body);
      for (const call of WORKTREE_CALLS) {
        expect(code).not.toContain(call);
      }
      // In prose they may appear only inside the prohibition.
      const text = prose(body);
      const mentions = text
        .split("\n")
        .filter((line) => WORKTREE_CALLS.some((c) => line.includes(c)));
      expect(mentions.length).toBeGreaterThan(0);
      expect(text).toMatch(
        /\*\*Never\*\* run `\.\/scripts\/new-feature\.sh`[\s\S]*never run `git worktree add`[\s\S]*never run `npx sequant worktree resolve`/,
      );
    });

    it("skips the dev-server smoke test unless SEQUANT_SMOKE=1 and never invokes /test (AC-1)", () => {
      const content = readSkill(root, "exec");
      const main = region(content, MAIN_REGION).body;
      const smoke = region(content, "in-place-checkout-skip: smoke-test (#1136)");

      expect(main).toContain("**Never invoke `/test`.**");
      expect(smoke.body).toMatch(/skip this section unless\s+`SEQUANT_SMOKE=1`/);
      // The marker must precede the dev-server command it skips.
      expect(smoke.start).toBeLessThan(content.indexOf("npm run dev &"));
    });

    it("marks each worktree-creating site as skipped, ahead of the call (AC-1)", () => {
      const content = readSkill(root, "exec");

      const gathering = region(
        content,
        "in-place-checkout-skip: context-gathering (#1136)",
      );
      expect(gathering.start).toBeLessThan(
        content.indexOf("./scripts/new-feature.sh <issue-number> &"),
      );

      const workflow = region(
        content,
        "in-place-checkout-skip: worktree-workflow (#1136)",
      );
      expect(workflow.body).toContain("skip this whole section");
      // Ahead of the main-branch safeguard, the #899 guard and the lookup.
      for (const later of [
        "**CRITICAL: Main Branch Safeguard",
        "<!-- BEGIN: worktree-existence-guard (#899) -->",
        "<!-- BEGIN: worktree-standalone-lookup (#899) -->",
      ]) {
        const at = content.indexOf(later);
        expect(at).toBeGreaterThan(-1);
        expect(workflow.end).toBeLessThan(at);
      }
    });
  });

  describe.each(RESOLVING_SKILLS)("%s", (skill) => {
    it("treats $PWD as the worktree and halts on the base branch (AC-2)", () => {
      const content = readSkill(root, skill);
      const main = region(content, MAIN_REGION);
      const code = codeBlocks(main.body);

      expect(code).toContain('WORKTREE="$PWD"');
      // The base-branch halt: the branch test is followed directly by exit 1,
      // and nothing but the flag check encloses it.
      expect(code).toMatch(
        /if \[\[ -z "\$CURRENT" \|\| "\$CURRENT" == "\$BASE" \]\]; then\n\s+echo "❌ HALT:[^\n]*"\n\s+exit 1/,
      );
      expect(code).not.toMatch(/git (checkout -b|switch -c)/);
      for (const call of WORKTREE_CALLS) {
        expect(code).not.toContain(call);
      }

      // It must run before either #899 path could resolve a worktree.
      const lookup = content.indexOf(
        "<!-- BEGIN: worktree-standalone-lookup (#899) -->",
      );
      expect(lookup).toBeGreaterThan(-1);
      expect(main.end).toBeLessThan(lookup);
      const guard = content.indexOf(
        "<!-- BEGIN: worktree-existence-guard (#899) -->",
      );
      if (guard !== -1) expect(main.end).toBeLessThan(guard);
    });
  });

  describe("qa", () => {
    it("skips worktree resolve in the implementation status check (AC-2)", () => {
      const content = readSkill(root, "qa");
      const skip = region(content, "in-place-checkout-skip: status-check (#1136)");

      expect(skip.body).toContain('worktree_path="$PWD"');
      const call = content.indexOf(
        'worktree_path=$(npx sequant worktree resolve "<issue-number>"',
      );
      expect(call).toBeGreaterThan(-1);
      expect(skip.end).toBeLessThan(call);
    });
  });

  describe("never inferred", () => {
    it("every mention of the flag sits inside a delimited in-place region (AC-3)", () => {
      const offenders: string[] = [];
      let mentions = 0;

      for (const skill of allSkills(root)) {
        const content = readSkill(root, skill);
        const regions = inPlaceRegions(content);
        const flag = /SEQUANT_CHECKOUT|in-place/g;
        for (let m = flag.exec(content); m !== null; m = flag.exec(content)) {
          mentions++;
          const at = m.index;
          if (!regions.some((r) => at >= r.start && at < r.end)) {
            const line = content.slice(0, at).split("\n").length;
            offenders.push(`${skill}:${line}: ${m[0]}`);
          }
        }
      }

      // Guard against a vacuous pass if the flag were renamed everywhere.
      expect(mentions).toBeGreaterThan(0);
      expect(offenders).toEqual([]);
    });

    it("states that the mode is never inferred from git state (AC-3)", () => {
      for (const skill of ["exec", ...RESOLVING_SKILLS]) {
        const body = region(readSkill(root, skill), MAIN_REGION).body;
        expect(body).toMatch(/never\s+inferred\s+from\s+git\s+state/);
      }
    });
  });
});

describe("checkout modes reference page (AC-5)", () => {
  it("lists the three modes with entry condition and what each skips", () => {
    const file = path.join(REPO_ROOT, "docs/reference/checkout-modes.md");
    const table = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("|"));

    for (const mode of ["orchestrated", "standalone", "in-place"]) {
      const row = table.find((line) => line.startsWith(`| ${mode} `));
      expect(row, `row for ${mode}`).toBeDefined();
      // Mode, entry condition, where the work happens, what it skips.
      expect(row!.split("|").filter((c) => c.trim()).length).toBe(4);
    }
    expect(table[0]).toMatch(/Entry condition/);
    expect(table[0]).toMatch(/skips/i);
  });
});
