/**
 * Direct import tests for phase-executor module.
 *
 * These tests verify that phase-executor exports are importable
 * directly and test pure functions.
 */

import { describe, it, expect } from "vitest";
import {
  PHASE_PROMPTS,
  ISOLATED_PHASES,
  parseQaVerdict,
  formatDuration,
  getPhasePrompt,
  executePhase,
  executePhaseWithRetry,
} from "./phase-executor.js";

describe("phase-executor direct imports", () => {
  describe("formatDuration", () => {
    it("should format seconds", () => {
      expect(formatDuration(30)).toBe("30.0s");
    });

    it("should format minutes and seconds", () => {
      expect(formatDuration(90)).toBe("1m 30s");
    });

    it("should format zero", () => {
      expect(formatDuration(0)).toBe("0.0s");
    });
  });

  describe("parseQaVerdict", () => {
    it("should parse READY_FOR_MERGE from markdown header", () => {
      expect(parseQaVerdict("### Verdict: READY_FOR_MERGE")).toBe(
        "READY_FOR_MERGE",
      );
    });

    it("should parse AC_NOT_MET from bold format", () => {
      expect(parseQaVerdict("**Verdict:** AC_NOT_MET")).toBe("AC_NOT_MET");
    });

    it("should parse AC_MET_BUT_NOT_A_PLUS", () => {
      expect(parseQaVerdict("Verdict: AC_MET_BUT_NOT_A_PLUS")).toBe(
        "AC_MET_BUT_NOT_A_PLUS",
      );
    });

    it("should parse NEEDS_VERIFICATION", () => {
      expect(parseQaVerdict("### Verdict: NEEDS_VERIFICATION")).toBe(
        "NEEDS_VERIFICATION",
      );
    });

    it("should return null for empty string", () => {
      expect(parseQaVerdict("")).toBeNull();
    });

    it("should return null when no verdict found", () => {
      expect(parseQaVerdict("Some other content")).toBeNull();
    });
  });

  describe("getPhasePrompt", () => {
    it("should substitute issue number in prompt", () => {
      const prompt = getPhasePrompt("qa", 123);
      expect(prompt).toContain("123");
      expect(prompt).not.toContain("{issue}");
    });
  });

  describe("constants", () => {
    it("should export PHASE_PROMPTS for all phases", () => {
      expect(PHASE_PROMPTS.spec).toBeDefined();
      expect(PHASE_PROMPTS.exec).toBeDefined();
      expect(PHASE_PROMPTS.qa).toBeDefined();
      expect(PHASE_PROMPTS.loop).toBeDefined();
    });

    it("should export ISOLATED_PHASES", () => {
      expect(ISOLATED_PHASES).toContain("exec");
      expect(ISOLATED_PHASES).toContain("qa");
      expect(ISOLATED_PHASES).not.toContain("spec");
    });
  });

  describe("exports exist", () => {
    it("should export async functions", () => {
      expect(typeof executePhase).toBe("function");
      expect(typeof executePhaseWithRetry).toBe("function");
    });
  });
});
