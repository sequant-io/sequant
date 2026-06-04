// Issue #711 — AC-1 / AC-4: every managed SKILL.md carries the local-override
// overlay directive, so `.claude/.local/skills/<name>/overrides.md` is honored
// at invocation. This is the automated bar; the end-to-end bar (an override
// actually winning at invocation) is the manual verification documented in
// docs/guides/customization.md.
//
// The directive must sit at the TOP of the body (before the first `#` heading),
// not at the end — a "read the override file first" instruction buried at line
// 3136 of a 3138-line skill (e.g. /qa) is unreliable to fire. This test pins the
// early placement so it can't silently regress to end-of-file.
//
// Run with: npx vitest run __tests__/integration/local-override-directive.integration.test.ts

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Stable sentinel at the top of every managed SKILL.md body. Asserting on the
// sentinel (not prose) keeps the test robust to wording tweaks.
const SENTINEL = "<!-- sequant:local-override -->";

// All three mirror dirs the harness/plugin/published-package read from.
const SKILL_ROOTS = [".claude/skills", "templates/skills", "skills"];

function findSkillFiles(root: string): string[] {
  const base = path.join(REPO_ROOT, root);
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "SKILL.md") out.push(full);
    }
  };
  walk(base);
  return out.sort();
}

describe("AC-1: local-override overlay directive in every managed SKILL.md", () => {
  for (const root of SKILL_ROOTS) {
    const files = findSkillFiles(root);

    it(`${root} has at least one SKILL.md to check`, () => {
      expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file);
      // Skill name is the directory containing SKILL.md.
      const name = path.basename(path.dirname(file));

      it(`${rel} contains the overlay directive at the top of the body`, () => {
        const content = fs.readFileSync(file, "utf8");
        expect(content.includes(SENTINEL), `Missing sentinel in ${rel}`).toBe(
          true,
        );
        // The directive must point at THIS skill's literal override path —
        // a placeholder or wrong name would make the path non-resolvable.
        const overridePath = `.claude/.local/skills/${name}/overrides.md`;
        expect(
          content.includes(overridePath),
          `Expected literal override path '${overridePath}' in ${rel}`,
        ).toBe(true);

        // Placement: the sentinel must appear BEFORE the first `#` heading, i.e.
        // it is the first thing in the body after the frontmatter. An override
        // directive at end-of-file is unreliable to fire in long skills (#711).
        const lines = content.split("\n");
        const sentinelLine = lines.findIndex((l) => l.includes(SENTINEL));
        const firstHeadingLine = lines.findIndex((l) => /^# /.test(l));
        expect(
          firstHeadingLine,
          `No top-level heading in ${rel}`,
        ).toBeGreaterThan(-1);
        expect(
          sentinelLine,
          `Directive in ${rel} must precede the first heading (line ${
            firstHeadingLine + 1
          }), found at line ${sentinelLine + 1}`,
        ).toBeLessThan(firstHeadingLine);
      });
    }
  }
});
