// Issue #552 — AC-1: `/spec` Rule Touchpoints integration
// Run with: npx vitest run __tests__/integration/behavior-rule-spec-wiring.integration.test.ts
//
// Tests the SKILL.md prompt-shell boundary: the "Rule Touchpoints" subsection
// in `.claude/skills/spec/SKILL.md` must invoke `findTouchpoints` from the
// detector module and link the shared reference doc. SKILL.md edits that
// break shell quoting, change function names, or drift the path only surface
// post-merge in production /spec runs without this test.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SPEC_SKILL = path.join(
  REPO_ROOT,
  ".claude",
  "skills",
  "spec",
  "SKILL.md",
);

describe("AC-1: /spec Rule Touchpoints integration", () => {
  const TEST_DIR = `/tmp/sequant-552-spec-${process.pid}-${Date.now()}`;

  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("SKILL.md wiring", () => {
    it("links references/behavior-rule-detection.md (AC-3 cross-link)", () => {
      const contents = fs.readFileSync(SPEC_SKILL, "utf8");
      expect(contents).toMatch(
        /\.\.\/_shared\/references\/behavior-rule-detection\.md/,
      );
    });

    it("invokes findTouchpoints via npx tsx -e snippet", () => {
      const contents = fs.readFileSync(SPEC_SKILL, "utf8");
      expect(contents).toMatch(/findTouchpoints/);
      expect(contents).toMatch(/npx tsx -e/);
      expect(contents).toMatch(/behavior-rule-detector/);
    });

    it("documents the SPEC_AC_ID / SPEC_AC_TEXT env vars used by the snippet", () => {
      const contents = fs.readFileSync(SPEC_SKILL, "utf8");
      expect(contents).toMatch(/SPEC_AC_ID/);
      expect(contents).toMatch(/SPEC_AC_TEXT/);
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

/**
 * Runs the same shape of npx tsx -e snippet that `.claude/skills/spec/SKILL.md`
 * documents — calling detectBehaviorRule and findTouchpoints with the AC text
 * passed via env var. The test mirrors the production invocation (rather than
 * importing the module directly) so SKILL.md drift is caught.
 *
 * `npx tsx -e` reads the script from a single shell argument, so we write the
 * snippet to a temp .ts file and pass the path. This matches the SKILL.md
 * snippet semantically (`-e` would also work) without fighting shell quoting.
 */
function runDetectorSnippet(acText: string): string {
  const detectorPath = path.join(
    REPO_ROOT,
    "src/lib/heuristics/behavior-rule-detector.ts",
  );
  const snippet = [
    "(async () => {",
    `  const m = await import('${detectorPath}');`,
    "  const ac = { id: 'AC-1', description: process.env.SPEC_AC_TEXT, verificationMethod: 'manual', status: 'pending' };",
    "  const detection = m.detectBehaviorRule(ac);",
    "  if (!detection.triggered) { console.log(JSON.stringify({ triggered: false })); return; }",
    "  const touchpoints = m.findTouchpoints(ac, process.cwd());",
    "  console.log(JSON.stringify({ triggered: true, keywords: detection.keywords, touchpoints }));",
    "})();",
  ].join("\n");

  const tmpScript = path.join(
    fs.mkdtempSync(path.join(require("node:os").tmpdir(), "sequant-552-spec-")),
    "snippet.ts",
  );
  fs.writeFileSync(tmpScript, snippet);
  try {
    return execSync(`npx tsx ${tmpScript}`, {
      cwd: REPO_ROOT,
      env: { ...process.env, SPEC_AC_TEXT: acText },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } finally {
    fs.rmSync(path.dirname(tmpScript), { recursive: true, force: true });
  }
}
