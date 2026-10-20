// Issue #552 — AC-1: `/spec` Rule Touchpoints integration
// Run with: npx vitest run __tests__/integration/behavior-rule-spec-wiring.integration.test.ts
//
// Runs the "Rule Touchpoints" bash fence from `.claude/skills/spec/SKILL.md`
// itself (#1512) and checks the section links the shared reference doc.
// SKILL.md edits that break shell quoting, change function names, or drift
// the path only surface post-merge in production /spec runs without this test.

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  fill,
  REPO_ROOT,
  skillEnv,
  skillFence,
} from "../helpers/skill-fence.js";

const SPEC_SKILL = path.join(
  REPO_ROOT,
  ".claude",
  "skills",
  "spec",
  "SKILL.md",
);

describe("AC-1: /spec Rule Touchpoints integration", () => {
  describe("SKILL.md wiring", () => {
    it("links references/behavior-rule-detection.md (AC-3 cross-link)", () => {
      const contents = fs.readFileSync(SPEC_SKILL, "utf8");
      expect(contents).toMatch(
        /\.\.\/_shared\/references\/behavior-rule-detection\.md/,
      );
    });

    it("contains a Rule Touchpoints section template in the plan output", () => {
      const contents = fs.readFileSync(SPEC_SKILL, "utf8");
      expect(contents).toMatch(/##\s+Rule Touchpoints/);
    });
  });

  describe("happy path: behavior-rule AC triggers and surfaces touchpoints", () => {
    it("returns triggered=true with touchpoints for #533-style AC", () => {
      const acText =
        "Default /assess spec phase becomes ON; never skip spec for bug/docs labels";
      const stdout = runDetectorSnippet(acText);
      const result = JSON.parse(stdout);
      expect(result.triggered).toBe(true);
      expect(Array.isArray(result.touchpoints)).toBe(true);
      expect(result.touchpoints.length).toBeGreaterThan(0);
      for (const tp of result.touchpoints) {
        expect(tp.path).toBeTruthy();
        expect(tp.line).toBeGreaterThan(0);
      }
    });
  });

  describe("negative path: non-behavior AC short-circuits", () => {
    it("does NOT trigger on 'Update line 42 of foo.ts'", () => {
      const stdout = runDetectorSnippet(
        "Update line 42 of foo.ts to use new API",
      );
      const result = JSON.parse(stdout);
      expect(result.triggered).toBe(false);
    });

    it("does NOT trigger on 'set default value to 5' (false-positive guard)", () => {
      const stdout = runDetectorSnippet("Set default value to 5 in config");
      const result = JSON.parse(stdout);
      expect(result.triggered).toBe(false);
    });
  });

  describe("error scenarios", () => {
    it("handles malformed (empty) AC text without crashing", () => {
      const stdout = runDetectorSnippet("");
      const result = JSON.parse(stdout);
      expect(result.triggered).toBe(false);
    });
  });
});

/** Runs the spec skill's Rule Touchpoints fence with `acText` as the AC. */
function runDetectorSnippet(acText: string): string {
  const fence = skillFence("spec", {
    section: "### Rule Touchpoints",
    contains: "findTouchpoints",
  });
  return execSync(
    fill(fence, { "<verbatim AC description from the issue body>": acText }),
    {
      cwd: REPO_ROOT,
      env: skillEnv(),
      encoding: "utf8",
      shell: "/bin/bash",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}
