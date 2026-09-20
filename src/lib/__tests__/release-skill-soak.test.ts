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

const SKILL_ROOTS = [".claude/skills", "skills", "templates/skills"] as const;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function region(root: string): string {
  const full = fs.readFileSync(
    path.join(REPO_ROOT, root, "release/SKILL.md"),
    "utf-8",
  );
  const m = full.match(
    /<!-- BEGIN: next-tag-publish[^>]*-->([\s\S]*?)<!-- END: next-tag-publish/,
  );
  if (!m) throw new Error(`${root}: next-tag-publish region missing`);
  return m[1];
}

describe.each(SKILL_ROOTS)("release skill soak gate (%s)", (root) => {
  it("publishes to next first", () => {
    const r = region(root);
    expect(r).toMatch(/^npm publish --tag next$/m);
    expect(r).not.toMatch(/^npm publish$/m);
  });

  it("promotes to latest only after the publish, via dist-tag", () => {
    const r = region(root);
    const publish = r.search(/^npm publish --tag next$/m);
    const promote = r.search(/^npm dist-tag add .* latest$/m);
    expect(publish).toBeGreaterThanOrEqual(0);
    expect(promote).toBeGreaterThan(publish);
  });

  it("prints the soak checklist and refuses latest without --soaked", () => {
    const r = region(root);
    expect(r).toMatch(/Soak checklist/);
    expect(r).toMatch(/npx sequant@next sync --dry-run/);
    expect(r).toMatch(/Without `--soaked`: refuse/);
    expect(r).toMatch(/With `--soaked`/);
  });

  it("documents --soaked in Usage", () => {
    const full = fs.readFileSync(
      path.join(REPO_ROOT, root, "release/SKILL.md"),
      "utf-8",
    );
    const usage = full.slice(
      full.indexOf("## Usage"),
      full.indexOf("## Pre-flight"),
    );
    expect(usage).toContain("--soaked");
  });
});
