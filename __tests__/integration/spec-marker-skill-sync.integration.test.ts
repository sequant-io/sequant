// Issue #921 — AC-1: the spec Output Template must emit the SEQUANT_SPEC
// marker (phases + qualityLoop) inside the posted plan comment, mirrored
// across all 3 skill copies.
//
// Per CLAUDE.md's gate-test rule, this scopes its content assertion to the
// `## Recommended Workflow` … next `---` region of SKILL.md, not the whole
// file — matching the whole file would let the marker being *described* in
// prose elsewhere (e.g. the Complexity Tier section, which already discusses
// an unrelated dead marker) satisfy the assertion without the Output
// Template itself actually emitting it.
//
// Run with: npx vitest run __tests__/integration/spec-marker-skill-sync.integration.test.ts

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MIRROR_ROOTS = [".claude/skills", "templates/skills", "skills"];

const TOUCHED_FILES = [
  "spec/SKILL.md",
  "spec/references/recommended-workflow.md",
];

const SPEC_MARKER_RE = /<!-- SEQUANT_SPEC: \{[^}]+\} -->/;

/** Extract the `## Recommended Workflow` section up to the next `---` rule. */
function extractRecommendedWorkflowSection(skillMd: string): string {
  const match = skillMd.match(/## Recommended Workflow\n[\s\S]*?(?=\n---\n)/);
  if (!match) {
    throw new Error("Could not locate '## Recommended Workflow' section");
  }
  return match[0];
}

describe("AC-1: SEQUANT_SPEC marker present in Output Template, mirrored 3-dir", () => {
  describe("happy path: all 3 mirrors of touched files exist", () => {
    for (const rel of TOUCHED_FILES) {
      it(`exists in all 3 mirror dirs: ${rel}`, () => {
        for (const root of MIRROR_ROOTS) {
          const full = path.join(REPO_ROOT, root, rel);
          expect(fs.existsSync(full), `Missing: ${full}`).toBe(true);
        }
      });
    }
  });

  describe("marker is present in the Recommended Workflow section (region-scoped)", () => {
    for (const root of MIRROR_ROOTS) {
      it(`${root}/spec/SKILL.md emits the marker in its Output Template`, () => {
        const full = path.join(REPO_ROOT, root, "spec/SKILL.md");
        const content = fs.readFileSync(full, "utf-8");
        const section = extractRecommendedWorkflowSection(content);
        expect(
          SPEC_MARKER_RE.test(section),
          `Expected SEQUANT_SPEC marker inside '## Recommended Workflow' section of ${full}`,
        ).toBe(true);
      });
    }
  });

  describe("scripts/check-skill-sync.ts reports synced 3/3 for touched files", () => {
    const output = (() => {
      try {
        return execSync("npx tsx scripts/check-skill-sync.ts", {
          cwd: REPO_ROOT,
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (err) {
        const e = err as { stdout?: string };
        return e.stdout || "";
      }
    })();

    for (const rel of TOUCHED_FILES) {
      it(`reports synced 3/3 for ${rel}`, () => {
        const escaped = rel.replace(/[/.]/g, (m) => "\\" + m);
        const syncedRe = new RegExp(`synced\\s+${escaped}\\s+—\\s+3\\/3 match`);
        expect(
          syncedRe.test(output),
          `Expected '${rel}' synced 3/3, got:\n${output}`,
        ).toBe(true);
        const divergedRe = new RegExp(`DIVERGED\\s+${escaped}`);
        const missingRe = new RegExp(`missing\\s+${escaped}`);
        expect(divergedRe.test(output)).toBe(false);
        expect(missingRe.test(output)).toBe(false);
      });
    }
  });
});
