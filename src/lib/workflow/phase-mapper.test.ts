/**
 * Direct import tests for phase-mapper module.
 *
 * These tests verify that phase-mapper exports are importable
 * directly and test pure functions.
 */

import { describe, it, expect } from "vitest";
import {
  UI_LABELS,
  BUG_LABELS,
  DOCS_LABELS,
  COMPLEX_LABELS,
  SECURITY_LABELS,
  detectPhasesFromLabels,
  parseRecommendedWorkflow,
  hasUILabels,
  determinePhasesForIssue,
  filterResumedPhases,
  parseDependencies,
  sortByDependencies,
} from "./phase-mapper.js";

describe("phase-mapper direct imports", () => {
  describe("detectPhasesFromLabels", () => {
    it("should return standard workflow for no labels", () => {
      const result = detectPhasesFromLabels([]);
      expect(result.phases).toEqual(["spec", "exec", "qa"]);
      expect(result.qualityLoop).toBe(false);
    });

    it("should skip spec for bug labels", () => {
      const result = detectPhasesFromLabels(["bug"]);
      expect(result.phases).toEqual(["exec", "qa"]);
    });

    it("should add test phase for UI labels", () => {
      const result = detectPhasesFromLabels(["frontend"]);
      expect(result.phases).toContain("test");
    });

    it("should enable quality loop for complex labels", () => {
      const result = detectPhasesFromLabels(["refactor"]);
      expect(result.qualityLoop).toBe(true);
    });

    it("should add security-review for security labels", () => {
      const result = detectPhasesFromLabels(["security"]);
      expect(result.phases).toContain("security-review");
    });
  });

  describe("parseRecommendedWorkflow", () => {
    it("should parse phases from spec output", () => {
      const output = `## Recommended Workflow
**Phases:** exec → qa
**Quality Loop:** disabled`;
      const result = parseRecommendedWorkflow(output);
      expect(result).not.toBeNull();
      expect(result!.phases).toEqual(["exec", "qa"]);
      expect(result!.qualityLoop).toBe(false);
    });

    it("should parse quality loop enabled", () => {
      const output = `## Recommended Workflow
**Phases:** spec → exec → qa
**Quality Loop:** enabled`;
      const result = parseRecommendedWorkflow(output);
      expect(result!.qualityLoop).toBe(true);
    });

    it("should return null for missing section", () => {
      expect(parseRecommendedWorkflow("No workflow here")).toBeNull();
    });
  });

  describe("hasUILabels", () => {
    it("should detect UI labels", () => {
      expect(hasUILabels(["frontend"])).toBe(true);
      expect(hasUILabels(["admin"])).toBe(true);
    });

    it("should return false for non-UI labels", () => {
      expect(hasUILabels(["bug"])).toBe(false);
      expect(hasUILabels([])).toBe(false);
    });
  });

  describe("determinePhasesForIssue", () => {
    it("should add testgen after spec when requested", () => {
      const phases = determinePhasesForIssue(["spec", "exec", "qa"], [], {
        testgen: true,
      });
      expect(phases).toEqual(["spec", "testgen", "exec", "qa"]);
    });

    it("should add test phase for UI labels", () => {
      const phases = determinePhasesForIssue(
        ["spec", "exec", "qa"],
        ["frontend"],
        {},
      );
      expect(phases).toContain("test");
    });
  });

  describe("constants", () => {
    it("should export label arrays", () => {
      expect(UI_LABELS).toContain("frontend");
      expect(BUG_LABELS).toContain("bug");
      expect(DOCS_LABELS).toContain("docs");
      expect(COMPLEX_LABELS).toContain("refactor");
      expect(SECURITY_LABELS).toContain("security");
    });
  });

  describe("exports exist", () => {
    it("should export all expected functions", () => {
      expect(typeof filterResumedPhases).toBe("function");
      expect(typeof parseDependencies).toBe("function");
      expect(typeof sortByDependencies).toBe("function");
    });
  });
});
