// Issue #552 — behavior-rule detector
// AC-5: Tests verify trigger conditions (Unit + Integration)
// AC-1 / AC-2 underlying-function coverage (findTouchpoints / findSurvivingInverseSymbols)
// Run with: npx vitest run src/lib/heuristics/__tests__/behavior-rule-detector.test.ts

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import { createAcceptanceCriterion } from "../../workflow/state-schema.js";
import {
  detectBehaviorRule,
  findTouchpoints,
  findSurvivingInverseSymbols,
} from "../behavior-rule-detector.js";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

describe("behavior-rule-detector", () => {
  describe("AC-5 unit: detectBehaviorRule trigger conditions", () => {
    it("triggers on 'Default rule becomes X' (default + rule)", () => {
      const ac = createAcceptanceCriterion(
        "AC-1",
        "Default rule becomes X for new users",
      );
      const result = detectBehaviorRule(ac);
      expect(result.triggered).toBe(true);
      expect(result.keywords).toEqual(
        expect.arrayContaining(["default", "rule"]),
      );
    });

    it("triggers on 'Always include Y in response payload behavior' (always + behavior)", () => {
      const ac = createAcceptanceCriterion(
        "AC-1",
        "Always include Y in response payload behavior",
      );
      const result = detectBehaviorRule(ac);
      expect(result.triggered).toBe(true);
      expect(result.keywords).toEqual(
        expect.arrayContaining(["always", "behavior"]),
      );
    });

    it("triggers on 'Never skip Z' (never + skip)", () => {
      const ac = createAcceptanceCriterion(
        "AC-1",
        "Never skip Z when condition is true",
      );
      const result = detectBehaviorRule(ac);
      expect(result.triggered).toBe(true);
      expect(result.keywords).toEqual(
        expect.arrayContaining(["never", "skip"]),
      );
    });

    it("does NOT trigger on 'Update line 42 of foo.ts'", () => {
      const ac = createAcceptanceCriterion(
        "AC-1",
        "Update line 42 of foo.ts to use new API",
      );
      const result = detectBehaviorRule(ac);
      expect(result.triggered).toBe(false);
    });

    it("does NOT trigger on 'Add field to interface X'", () => {
      const ac = createAcceptanceCriterion(
        "AC-1",
        "Add field to interface X for type safety",
      );
      const result = detectBehaviorRule(ac);
      expect(result.triggered).toBe(false);
    });

    it("does NOT trigger on 'set default value to 5' (single-keyword false-positive guard)", () => {
      const ac = createAcceptanceCriterion(
        "AC-1",
        "Set default value to 5 in config",
      );
      const result = detectBehaviorRule(ac);
      expect(result.triggered).toBe(false);
    });

    it("triggers on explicit 'always X unless Y' pattern even with 1 keyword", () => {
      const ac = createAcceptanceCriterion(
        "AC-1",
        "Always run validation unless force flag is set",
      );
      const result = detectBehaviorRule(ac);
      expect(result.triggered).toBe(true);
      expect(result.matchedPattern).toBeTruthy();
    });

    describe("edge cases", () => {
      it("returns triggered=false on empty description", () => {
        const ac = createAcceptanceCriterion("AC-1", "");
        const result = detectBehaviorRule(ac);
        expect(result.triggered).toBe(false);
        expect(result.keywords).toEqual([]);
      });

      it("matches keywords case-insensitively", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "DEFAULT behavior is Always to skip empty",
        );
        const result = detectBehaviorRule(ac);
        expect(result.triggered).toBe(true);
        expect(result.keywords.length).toBeGreaterThanOrEqual(2);
      });

      it("does not throw on undefined description", () => {
        // Some upstream parsers have produced undefined descriptions; the
        // detector must defend rather than crash a /spec or /qa run.
        const ac = {
          id: "AC-1",
          // Cast through unknown to preserve the runtime defense check while
          // documenting that this is *not* a normal call shape.
          description: undefined as unknown as string,
          verificationMethod: "manual" as const,
          status: "pending" as const,
        };
        expect(() => detectBehaviorRule(ac)).not.toThrow();
        expect(detectBehaviorRule(ac).triggered).toBe(false);
      });
    });
  });

  // The literal AC-5 example strings from the #552 issue body must trigger
  // verbatim — no augmentation. Per feedback_qa_ac_literal.md and
  // feedback_synthetic_test_fixture_trap.md.
  describe("AC-5 verbatim: literal example strings from #552 issue body", () => {
    it("triggers verbatim on 'Default rule becomes X' (issue-body example)", () => {
      const ac = createAcceptanceCriterion("AC-5", "Default rule becomes X");
      expect(detectBehaviorRule(ac).triggered).toBe(true);
    });

    it("triggers verbatim on 'Always include Y' via imperative-opener pattern", () => {
      // Single keyword (`always`) — pre-fix this returned `triggered: false`.
      // Imperative-opener explicit pattern now covers it.
      const ac = createAcceptanceCriterion("AC-5", "Always include Y");
      const result = detectBehaviorRule(ac);
      expect(result.triggered).toBe(true);
      expect(result.matchedPattern).toBeTruthy();
    });

    it("triggers verbatim on 'Never skip Z' (issue-body example)", () => {
      const ac = createAcceptanceCriterion("AC-5", "Never skip Z");
      expect(detectBehaviorRule(ac).triggered).toBe(true);
    });

    it("does NOT trigger on lowercase mid-sentence 'always include' prose", () => {
      // Imperative-opener pattern is case-sensitive on purpose: descriptive
      // prose like "the system always includes Y" must not self-trigger.
      const ac = createAcceptanceCriterion(
        "AC-5",
        "the system always includes Y in responses",
      );
      expect(detectBehaviorRule(ac).triggered).toBe(false);
    });
  });

  // The #533 fixture uses the verbatim AC text from the issue body so the
  // detector is tested against real-world payload, not a synthetic. See
  // feedback_motivating_example_regression.md / feedback_synthetic_test_fixture_trap.md.
  describe("AC-5 integration: findTouchpoints (#533 motivating fixture)", () => {
    it("finds duplicate implementations across skill+TypeScript layers (#533 fixture)", () => {
      // Verbatim AC text from issue #533 (combining AC-1 + AC-2):
      //   AC-1: Remove the "Skip spec when (bug/docs label AND no domain
      //         labels)" rule from `.claude/skills/assess/SKILL.md`
      //         "Step 4: Workflow Detection"
      //   AC-2: Default rule becomes: **always include `spec` unless a prior
      //         `spec` phase marker already exists on the issue**
      const ac = createAcceptanceCriterion(
        "AC-1",
        'Remove the "Skip spec when (bug/docs label AND no domain labels)" rule from `.claude/skills/assess/SKILL.md` "Step 4: Workflow Detection". Default rule becomes: always include `spec` unless a prior `spec` phase marker already exists on the issue.',
      );

      const hits = findTouchpoints(ac, REPO_ROOT);
      expect(hits.length).toBeGreaterThan(0);

      const paths = hits.map((h) => h.path);
      // The AC explicitly names .claude/skills/assess/SKILL.md as a known
      // touchpoint; the runtime should also surface phase-mapper and
      // batch-executor as the duplicate implementations the issue calls out.
      expect(
        paths.some((p) => p.includes("phase-mapper.ts")),
        `Expected a phase-mapper.ts hit, got:\n${paths.join("\n")}`,
      ).toBe(true);
      expect(
        paths.some((p) => p.includes("batch-executor.ts")),
        `Expected a batch-executor.ts hit, got:\n${paths.join("\n")}`,
      ).toBe(true);

      // Each hit carries the documented shape.
      for (const hit of hits) {
        expect(hit.line).toBeGreaterThan(0);
        expect(hit.snippet).toBeTruthy();
      }
    });

    it("returns empty when AC has no behavior-rule keywords (cheap short-circuit)", () => {
      const ac = createAcceptanceCriterion(
        "AC-1",
        "Add field to interface X for type safety",
      );
      const hits = findTouchpoints(ac, REPO_ROOT);
      expect(hits).toEqual([]);
    });

    it("returns hits with stable shape: { path, line, snippet }", () => {
      const ac = createAcceptanceCriterion(
        "AC-1",
        "Default rule becomes: always include `spec` unless a prior `spec` phase marker already exists",
      );
      const hits = findTouchpoints(ac, REPO_ROOT);
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(typeof hit.path).toBe("string");
        expect(typeof hit.line).toBe("number");
        expect(typeof hit.snippet).toBe("string");
      }
    });

    it("returns [] when repoRoot does not exist (defensive, no ENOENT throw)", () => {
      const ac = createAcceptanceCriterion(
        "AC-1",
        "Default rule becomes: always include spec; never skip",
      );
      expect(() =>
        findTouchpoints(ac, "/nonexistent/path/for/test/" + Date.now()),
      ).not.toThrow();
      const hits = findTouchpoints(
        ac,
        "/nonexistent/path/for/test/" + Date.now(),
      );
      expect(hits).toEqual([]);
    });

    // Guards against the recurring "CLI wiring gap" — see CLAUDE.md memory.
    // A behavior rule about a CLI default lands in skill code while the
    // Commander.js .option() registration in bin/cli.ts goes stale. Pre-fix
    // (TOUCHPOINT_ROOTS = ["src/lib", ".claude/skills"]) the detector would
    // miss it.
    it("scans bin/ for CLI option registration touchpoints", () => {
      function makeFixtureRepo(files: Record<string, string>): string {
        const tmp = fs.mkdtempSync(
          path.join(os.tmpdir(), `sequant-552-cli-scope-`),
        );
        for (const [rel, content] of Object.entries(files)) {
          const full = path.join(tmp, rel);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, content);
        }
        return tmp;
      }

      const fixture = makeFixtureRepo({
        "bin/cli.ts": [
          'import { Command } from "commander";',
          "const program = new Command();",
          '.option("--skip-spec", "Skip the spec phase entirely")',
        ].join("\n"),
        "src/commands/run.ts": [
          "export interface RunOptions {",
          "  /** Skip spec phase entirely — legacy default. */",
          "  skipSpec?: boolean;",
          "}",
        ].join("\n"),
      });

      const ac = createAcceptanceCriterion(
        "AC-1",
        "Default rule becomes: never skip spec; remove `--skip-spec` legacy flag",
      );
      const hits = findTouchpoints(ac, fixture);

      const paths = hits.map((h) => h.path);
      expect(
        paths.some((p) => p.startsWith("bin/")),
        `Expected a bin/ hit, got:\n${paths.join("\n")}`,
      ).toBe(true);
      expect(
        paths.some((p) => p.startsWith("src/commands/")),
        `Expected a src/commands/ hit, got:\n${paths.join("\n")}`,
      ).toBe(true);

      fs.rmSync(fixture, { recursive: true, force: true });
    });
  });

  // AC-2 reactive coverage. Uses a temp-dir fixture so the test asserts on
  // shape and behavior, not on the (mutating) live repo state.
  describe("findSurvivingInverseSymbols (AC-2 reactive check)", () => {
    function makeFixtureRepo(files: Record<string, string>): string {
      const tmp = fs.mkdtempSync(
        path.join(os.tmpdir(), `sequant-552-survival-`),
      );
      for (const [rel, content] of Object.entries(files)) {
        const full = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
      }
      return tmp;
    }

    it("flags survival when OLD-rule symbol still exists in diff blast radius", () => {
      // AC asserts the NEW rule (always include spec by default). Inverse
      // keywords ("skip", "exclude", "bypass") will hit the legacy line.
      const fixture = makeFixtureRepo({
        "src/lib/legacy.ts": [
          "export function detectPhases(labels: string[]) {",
          "  // legacy: skip spec for bug/docs labels",
          "  return labels.includes('bug') ? ['exec'] : ['spec'];",
          "}",
        ].join("\n"),
      });

      const ac = createAcceptanceCriterion(
        "AC-1",
        "Default /assess spec phase becomes ON; never skip spec for bug/docs labels",
      );

      const survivors = findSurvivingInverseSymbols(ac, fixture, [
        "src/lib/legacy.ts",
      ]);

      expect(survivors.length).toBeGreaterThan(0);
      expect(survivors[0].path).toContain("legacy.ts");
      expect(survivors[0].line).toBeGreaterThan(0);
      expect(survivors[0].snippet).toMatch(/skip/i);

      fs.rmSync(fixture, { recursive: true, force: true });
    });

    it("returns no survivors when diff fully removes the OLD rule", () => {
      const fixture = makeFixtureRepo({
        "src/lib/clean.ts": [
          "export function detectPhases(_labels: string[]) {",
          "  return ['spec', 'exec', 'qa'];",
          "}",
        ].join("\n"),
      });

      const ac = createAcceptanceCriterion(
        "AC-1",
        "Default /assess spec phase becomes ON; never skip spec for bug/docs",
      );

      const survivors = findSurvivingInverseSymbols(ac, fixture, [
        "src/lib/clean.ts",
      ]);
      expect(survivors).toEqual([]);

      fs.rmSync(fixture, { recursive: true, force: true });
    });

    it("scopes search to diff blast radius (does not flag out-of-radius files)", () => {
      const fixture = makeFixtureRepo({
        "src/lib/in-diff.ts": "export const X = 1;\n",
        "src/lib/out-of-diff.ts":
          "// legacy: skip spec for bug labels\nexport const Y = 2;\n",
      });

      const ac = createAcceptanceCriterion(
        "AC-1",
        "Default /assess spec phase becomes ON; never skip spec for bug/docs",
      );

      // Only in-diff.ts is in the blast radius — out-of-diff.ts must not be
      // reported even though it contains the inverse keyword.
      const survivors = findSurvivingInverseSymbols(ac, fixture, [
        "src/lib/in-diff.ts",
      ]);
      expect(survivors).toEqual([]);

      fs.rmSync(fixture, { recursive: true, force: true });
    });

    it("returns [] when AC is not a behavior rule (cheap short-circuit)", () => {
      const ac = createAcceptanceCriterion(
        "AC-1",
        "Add field to interface X for type safety",
      );
      const survivors = findSurvivingInverseSymbols(ac, REPO_ROOT, [
        "src/lib/heuristics/behavior-rule-detector.ts",
      ]);
      expect(survivors).toEqual([]);
    });

    it("returns [] when diffPaths is empty", () => {
      const ac = createAcceptanceCriterion(
        "AC-1",
        "Default rule becomes: always include spec; never skip",
      );
      const survivors = findSurvivingInverseSymbols(ac, REPO_ROOT, []);
      expect(survivors).toEqual([]);
    });
  });
});
