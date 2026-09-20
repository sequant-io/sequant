/**
 * CI gate for `/release`'s `next`-first publish and `--soaked` gate (#1098, AC-5).
 *
 * Prose with no runtime twin, so it is asserted against the prompt text and
 * scoped, per CLAUDE.md, to the delimited `next-tag-publish` region: a mention
 * in the Usage block or a rollback note must not satisfy any of these.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { collectFiles } from "../../../scripts/check-skill-sync.js";

const SKILL_ROOTS = [".claude/skills", "skills", "templates/skills"] as const;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * The three release skill copies, enumerated through `collectFiles` — the
 * production function `lint:skill-sync` walks with — rather than a hardcoded
 * path list, so a layout change moves this gate instead of silently passing.
 */
function releaseSkillCopies(): string[] {
  return SKILL_ROOTS.map((root) => {
    const base = path.join(REPO_ROOT, root);
    const found = collectFiles(base).find((rel) => rel === "release/SKILL.md");
    if (!found) throw new Error(`release/SKILL.md not found under ${root}`);
    return path.join(base, found);
  });
}

function region(file: string): string {
  const full = fs.readFileSync(file, "utf-8");
  const m = full.match(
    /<!-- BEGIN: next-tag-publish[^>]*-->([\s\S]*?)<!-- END: next-tag-publish/,
  );
  if (!m) throw new Error(`${file}: next-tag-publish region missing`);
  return m[1];
}

describe("release skill soak gate", () => {
  it("publishes to next first, in all three copies", () => {
    for (const file of releaseSkillCopies()) {
      const r = region(file);
      expect(r, file).toMatch(/^npm publish --tag next$/m);
      expect(r, file).not.toMatch(/^npm publish$/m);
    }
  });

  it("promotes to latest only after the publish, via dist-tag", () => {
    for (const file of releaseSkillCopies()) {
      const r = region(file);
      const publish = r.search(/^npm publish --tag next$/m);
      const promote = r.search(/^npm dist-tag add .* latest$/m);
      expect(publish, file).toBeGreaterThanOrEqual(0);
      expect(promote, file).toBeGreaterThan(publish);
    }
  });

  it("prints the soak checklist and refuses latest without --soaked", () => {
    for (const file of releaseSkillCopies()) {
      const r = region(file);
      expect(r, file).toMatch(/Soak checklist/);
      expect(r, file).toMatch(/npx sequant@next sync --dry-run/);
      expect(r, file).toMatch(/Without `--soaked`: refuse/);
      expect(r, file).toMatch(/With `--soaked`/);
    }
  });

  it("documents --soaked in Usage", () => {
    for (const file of releaseSkillCopies()) {
      const full = fs.readFileSync(file, "utf-8");
      const usage = full.slice(
        full.indexOf("## Usage"),
        full.indexOf("## Pre-flight"),
      );
      expect(usage, file).toContain("--soaked");
    }
  });
});
