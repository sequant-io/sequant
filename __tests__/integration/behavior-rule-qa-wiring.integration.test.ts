// Issue #552 — AC-2: `/qa` Behavior-Rule Survival Check integration
// Run with: npx vitest run __tests__/integration/behavior-rule-qa-wiring.integration.test.ts
//
// Tests the SKILL.md prompt-shell boundary for `.claude/skills/qa/SKILL.md` §6e
// and its §7 verdict-gating wiring. SKILL.md edits that break shell quoting,
// change function names, or unwire the verdict gate only surface in production
// /qa runs without this test.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const QA_SKILL = path.join(REPO_ROOT, ".claude", "skills", "qa", "SKILL.md");

describe("AC-2: /qa Behavior-Rule Survival Check integration", () => {
  let fixtureDir: string;

  beforeAll(() => {
    fixtureDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "sequant-552-qa-fixture-"),
    );
    fs.mkdirSync(path.join(fixtureDir, "src/lib"), { recursive: true });
    // Real-shape #533 fixture: BUG_LABELS short-circuit survives in
    // phase-mapper.ts after a "spec on by default" rule change.
    fs.writeFileSync(
      path.join(fixtureDir, "src/lib/phase-mapper.ts"),
      [
        "export const BUG_LABELS = ['bug', 'fix'];",
        "export function detectPhasesFromLabels(labels: string[]) {",
        "  // legacy: skip spec when bug/docs label present",
        "  if (labels.some(l => BUG_LABELS.includes(l))) return ['exec','qa'];",
        "  return ['spec','exec','qa'];",
        "}",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(fixtureDir, "src/lib/clean.ts"),
      "export const NO_LEGACY = true;\n",
    );
  });

  afterAll(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  describe("SKILL.md wiring", () => {
    it("links references/behavior-rule-detection.md (AC-3 cross-link)", () => {
      const contents = fs.readFileSync(QA_SKILL, "utf8");
      expect(contents).toMatch(
        /\.\.\/_shared\/references\/behavior-rule-detection\.md/,
      );
    });

    it("contains §6e Behavior-Rule Survival Check section", () => {
      const contents = fs.readFileSync(QA_SKILL, "utf8");
      expect(contents).toMatch(/6e\.\s+Behavior-Rule Survival Check/);
      expect(contents).toMatch(/findSurvivingInverseSymbols/);
    });

    it("wires §6e into §7 verdict gating with behavior_rule_survival_status", () => {
      const contents = fs.readFileSync(QA_SKILL, "utf8");
      expect(contents).toMatch(/behavior_rule_survival_status/);
      // Survivors Found must floor verdict at AC_NOT_MET in the §7 algorithm.
      expect(contents).toMatch(
        /behavior_rule_survival_status[\s\S]{0,200}AC_NOT_MET/,
      );
    });

    it("documents the QA_AC_TEXT / QA_DIFF_PATHS env vars used by the snippet", () => {
      const contents = fs.readFileSync(QA_SKILL, "utf8");
      expect(contents).toMatch(/QA_AC_TEXT/);
      expect(contents).toMatch(/QA_DIFF_PATHS/);
    });
  });

  describe("happy path: survival detected → AC NOT_MET", () => {
    it("flags survivors with path:line when OLD-rule symbol survives in diff blast radius", () => {
      const stdout = runQaSnippet({
        acText:
          "Default /assess spec phase becomes ON; never skip spec for bug/docs labels",
        repoRoot: fixtureDir,
        diffPaths: ["src/lib/phase-mapper.ts"],
      });
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
      const stdout = runQaSnippet({
        acText:
          "Default /assess spec phase becomes ON; never skip spec for bug/docs labels",
        repoRoot: fixtureDir,
        diffPaths: ["src/lib/clean.ts"],
      });
      const result = JSON.parse(stdout);
      expect(result.triggered).toBe(true);
      expect(result.survivors).toEqual([]);
    });

    it("scopes to diff blast radius (does NOT flag out-of-radius survivors)", () => {
      // phase-mapper.ts has a survivor, but it's not in diffPaths — must be ignored.
      const stdout = runQaSnippet({
        acText:
          "Default /assess spec phase becomes ON; never skip spec for bug/docs labels",
        repoRoot: fixtureDir,
        diffPaths: ["src/lib/clean.ts"],
      });
      const result = JSON.parse(stdout);
      expect(result.survivors).toEqual([]);
    });
  });

  describe("error scenarios", () => {
    it("short-circuits cleanly when no AC has triggered (cost gate)", () => {
      const stdout = runQaSnippet({
        acText: "Add field to interface X for type safety",
        repoRoot: fixtureDir,
        diffPaths: ["src/lib/phase-mapper.ts"],
      });
      const result = JSON.parse(stdout);
      expect(result.triggered).toBe(false);
    });

    it("returns survivors=[] when diffPaths is empty", () => {
      const stdout = runQaSnippet({
        acText: "Default rule becomes: always include spec; never skip",
        repoRoot: fixtureDir,
        diffPaths: [],
      });
      const result = JSON.parse(stdout);
      expect(result.survivors).toEqual([]);
    });
  });
});

interface QaSnippetArgs {
  acText: string;
  repoRoot: string;
  diffPaths: string[];
}

function runQaSnippet(args: QaSnippetArgs): string {
  const snippet = [
    "(async () => {",
    `  const m = await import('${path.join(REPO_ROOT, "src/lib/heuristics/behavior-rule-detector.ts")}');`,
    "  const ac = { id: 'AC-1', description: process.env.QA_AC_TEXT, verificationMethod: 'manual', status: 'pending' };",
    "  const detection = m.detectBehaviorRule(ac);",
    "  if (!detection.triggered) { console.log(JSON.stringify({ triggered: false })); return; }",
    "  const diffPaths = (process.env.QA_DIFF_PATHS || '').split('|').filter(Boolean);",
    "  const survivors = m.findSurvivingInverseSymbols(ac, process.env.QA_REPO_ROOT, diffPaths);",
    "  console.log(JSON.stringify({ triggered: true, survivors }));",
    "})();",
  ].join("\n");

  const tmpScript = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "sequant-552-qa-snippet-")),
    "snippet.ts",
  );
  fs.writeFileSync(tmpScript, snippet);
  try {
    return execSync(`npx tsx ${tmpScript}`, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        QA_AC_TEXT: args.acText,
        QA_REPO_ROOT: args.repoRoot,
        QA_DIFF_PATHS: args.diffPaths.join("|"),
      },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } finally {
    fs.rmSync(path.dirname(tmpScript), { recursive: true, force: true });
  }
}
