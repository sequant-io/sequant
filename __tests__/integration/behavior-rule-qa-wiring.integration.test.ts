// Issue #552 — AC-2: `/qa` Behavior-Rule Survival Check integration
// Run with: npx vitest run __tests__/integration/behavior-rule-qa-wiring.integration.test.ts
//
// Runs the §6e bash fence from `.claude/skills/qa/SKILL.md` itself (#1512) in a
// fixture repo whose `git diff origin/main...HEAD` is the blast radius, and
// checks its §7 verdict-gating wiring. SKILL.md edits that break shell quoting,
// change function names, or unwire the verdict gate only surface in production
// /qa runs without this test.

import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  fill,
  makeDiffRepo,
  REPO_ROOT,
  skillEnv,
  skillFence,
} from "../helpers/skill-fence.js";

const QA_SKILL = path.join(REPO_ROOT, ".claude", "skills", "qa", "SKILL.md");

// Real-shape #533 fixture: BUG_LABELS short-circuit survives in
// phase-mapper.ts after a "spec on by default" rule change.
const PHASE_MAPPER = [
  "export const BUG_LABELS = ['bug', 'fix'];",
  "export function detectPhasesFromLabels(labels: string[]) {",
  "  // legacy: skip spec when bug/docs label present",
  "  if (labels.some(l => BUG_LABELS.includes(l))) return ['exec','qa'];",
  "  return ['spec','exec','qa'];",
  "}",
].join("\n");
const FIXTURE: Record<string, string> = {
  "src/lib/phase-mapper.ts": PHASE_MAPPER,
  "src/lib/clean.ts": "export const NO_LEGACY = true;\n",
};

describe("AC-2: /qa Behavior-Rule Survival Check integration", () => {
  const repos: string[] = [];
  afterAll(() => {
    for (const dir of repos) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Run the §6e fence in a fixture repo where `diffPaths` are the files the
   * branch changed and the rest of FIXTURE sits on origin/main.
   */
  function runQaSnippet(acText: string, diffPaths: string[]): string {
    const changed = Object.fromEntries(diffPaths.map((p) => [p, FIXTURE[p]]));
    const base = Object.fromEntries(
      Object.entries(FIXTURE).filter(([p]) => !diffPaths.includes(p)),
    );
    const dir = makeDiffRepo(changed, base);
    repos.push(dir);
    // The fence imports ./src/lib/heuristics from its cwd; link this
    // checkout's copy in, untracked so it stays out of the diff.
    fs.symlinkSync(
      path.join(REPO_ROOT, "src/lib/heuristics"),
      path.join(dir, "src/lib/heuristics"),
    );
    const fence = skillFence("qa", {
      section: "### 6e. Behavior-Rule Survival Check",
      contains: "findSurvivingInverseSymbols",
    });
    return execSync(fill(fence, { "<verbatim AC description>": acText }), {
      cwd: dir,
      env: skillEnv(),
      encoding: "utf8",
      shell: "/bin/bash",
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  describe("SKILL.md wiring", () => {
    it("links references/behavior-rule-detection.md (AC-3 cross-link)", () => {
      const contents = fs.readFileSync(QA_SKILL, "utf8");
      expect(contents).toMatch(
        /\.\.\/_shared\/references\/behavior-rule-detection\.md/,
      );
    });

    it("wires §6e into §7 verdict gating with behavior_rule_survival_status", () => {
      const contents = fs.readFileSync(QA_SKILL, "utf8");
      expect(contents).toMatch(/behavior_rule_survival_status/);
      // Survivors Found must floor verdict at AC_NOT_MET in the §7 algorithm.
      expect(contents).toMatch(
        /behavior_rule_survival_status[\s\S]{0,200}AC_NOT_MET/,
      );
    });
  });

  describe("happy path: survival detected → AC NOT_MET", () => {
    it("flags survivors with path:line when OLD-rule symbol survives in diff blast radius", () => {
      const stdout = runQaSnippet(
        "Default /assess spec phase becomes ON; never skip spec for bug/docs labels",
        ["src/lib/phase-mapper.ts"],
      );
      const result = JSON.parse(stdout);
      expect(result.triggered).toBe(true);
      expect(Array.isArray(result.survivors)).toBe(true);
      expect(result.survivors.length).toBeGreaterThan(0);
      for (const s of result.survivors) {
        expect(s.path).toBeTruthy();
        expect(s.line).toBeGreaterThan(0);
        expect(s.snippet).toBeTruthy();
      }
    });
  });

  describe("negative path: clean diff → no survivors", () => {
    it("returns survivors=[] when diff fully removes the OLD rule", () => {
      const stdout = runQaSnippet(
        "Default /assess spec phase becomes ON; never skip spec for bug/docs labels",
        ["src/lib/clean.ts"],
      );
      const result = JSON.parse(stdout);
      expect(result.triggered).toBe(true);
      expect(result.survivors).toEqual([]);
    });

    it("scopes to diff blast radius (does NOT flag out-of-radius survivors)", () => {
      // phase-mapper.ts has a survivor, but it's not in diffPaths — must be ignored.
      const stdout = runQaSnippet(
        "Default /assess spec phase becomes ON; never skip spec for bug/docs labels",
        ["src/lib/clean.ts"],
      );
      const result = JSON.parse(stdout);
      expect(result.survivors).toEqual([]);
    });
  });

  describe("error scenarios", () => {
    it("short-circuits cleanly when no AC has triggered (cost gate)", () => {
      const stdout = runQaSnippet("Add field to interface X for type safety", [
        "src/lib/phase-mapper.ts",
      ]);
      const result = JSON.parse(stdout);
      expect(result.triggered).toBe(false);
    });

    it("returns survivors=[] when diffPaths is empty", () => {
      const stdout = runQaSnippet(
        "Default rule becomes: always include spec; never skip",
        [],
      );
      const result = JSON.parse(stdout);
      expect(result.survivors).toEqual([]);
    });
  });
});
