/**
 * Tests for AC Linter
 */

import { describe, it, expect } from "vitest";
import {
  lintAcceptanceCriterion,
  lintAcceptanceCriteria,
  formatACLintResults,
  getDefaultLintPatterns,
  createLintPatterns,
  type ACLintIssueType,
} from "./ac-linter.js";
import { createAcceptanceCriterion } from "./workflow/state-schema.js";

describe("AC Linter", () => {
  describe("lintAcceptanceCriterion", () => {
    describe("vague patterns", () => {
      it("should flag 'should work' as vague", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "System should work after deployment",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].type).toBe("vague");
        expect(result.issues[0].matchedPattern).toBe("should work");
      });

      it("should flag 'works properly' as vague", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Feature works properly in production",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues.some((i) => i.type === "vague")).toBe(true);
      });

      it("should flag 'correctly' as vague", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Button correctly updates state",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].matchedPattern).toBe("correctly");
      });

      it("should flag 'as expected' as vague", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Function behaves as expected",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].matchedPattern).toBe("as expected");
      });
    });

    describe("unmeasurable patterns", () => {
      it("should flag 'fast' as unmeasurable", () => {
        const ac = createAcceptanceCriterion("AC-1", "Page loads fast");
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("unmeasurable");
        expect(result.issues[0].matchedPattern).toBe("fast");
      });

      it("should not flag 'fast forward' as unmeasurable", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "User can fast forward the video",
        );
        const result = lintAcceptanceCriterion(ac);

        // Should not flag "fast forward" as an unmeasurable performance term
        expect(
          result.issues.filter((i) => i.matchedPattern === "fast"),
        ).toHaveLength(0);
      });

      it("should flag 'performant' as unmeasurable", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Application is performant under load",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("unmeasurable");
      });

      it("should flag 'quickly' as unmeasurable", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Data should sync quickly",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("unmeasurable");
      });

      it("should flag 'responsive' as unmeasurable", () => {
        const ac = createAcceptanceCriterion("AC-1", "UI is responsive");
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("unmeasurable");
      });

      it("should flag 'scalable' as unmeasurable", () => {
        const ac = createAcceptanceCriterion("AC-1", "System is scalable");
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("unmeasurable");
      });
    });

    describe("incomplete patterns", () => {
      it("should flag 'handle errors' as incomplete", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "System should handle errors gracefully",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues.some((i) => i.type === "incomplete")).toBe(true);
      });

      it("should flag 'edge cases' as incomplete", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Function handles edge cases",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("incomplete");
      });

      it("should flag 'corner cases' as incomplete", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Module covers corner cases",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("incomplete");
      });

      it("should flag 'all scenarios' as incomplete", () => {
        const ac = createAcceptanceCriterion("AC-1", "Works in all scenarios");
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("incomplete");
      });
    });

    describe("open-ended patterns", () => {
      it("should flag 'etc.' as open-ended", () => {
        const ac = createAcceptanceCriterion("AC-1", "Supports PNG, JPG, etc.");
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("open_ended");
        // Regex captures "etc" (word boundary doesn't include the period)
        expect(result.issues[0].matchedPattern.toLowerCase()).toBe("etc");
      });

      it("should flag 'and more' as open-ended", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Supports dark mode and more",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("open_ended");
      });

      it("should flag 'such as' as open-ended", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Handles formats such as JSON and XML",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("open_ended");
      });

      it("should flag 'including but not limited to' as open-ended", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Supports browsers including but not limited to Chrome",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("open_ended");
      });

      it("should flag 'for example' as open-ended", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Shows metrics for example CPU and memory",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues[0].type).toBe("open_ended");
      });
    });

    describe("clear criteria", () => {
      it("should pass clear and specific AC", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Login form returns 400 status with error message for invalid email format",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(true);
        expect(result.issues).toHaveLength(0);
      });

      it("should pass AC with specific threshold", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Page loads in under 2 seconds on 3G connection",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(true);
      });

      it("should pass AC with enumerated list", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Supports PNG, JPG, and WebP image formats",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(true);
      });

      it("should pass AC with specific error handling", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "Returns 404 for missing resources and 503 when database is unavailable",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(true);
      });
    });

    describe("multiple issues", () => {
      it("should detect multiple issues in one AC", () => {
        const ac = createAcceptanceCriterion(
          "AC-1",
          "System should work properly and be fast",
        );
        const result = lintAcceptanceCriterion(ac);

        expect(result.passed).toBe(false);
        expect(result.issues.length).toBeGreaterThan(1);
        expect(result.issues.some((i) => i.type === "vague")).toBe(true);
        expect(result.issues.some((i) => i.type === "unmeasurable")).toBe(true);
      });
    });
  });

  describe("lintAcceptanceCriteria", () => {
    it("should lint multiple criteria and return summary", () => {
      const criteria = [
        createAcceptanceCriterion("AC-1", "User can login with email"),
        createAcceptanceCriterion("AC-2", "System should work properly"),
        createAcceptanceCriterion("AC-3", "Page loads in <2s"),
        createAcceptanceCriterion("AC-4", "Handles edge cases"),
      ];

      const results = lintAcceptanceCriteria(criteria);

      expect(results.summary.total).toBe(4);
      expect(results.summary.passed).toBe(2);
      expect(results.summary.flagged).toBe(2);
      expect(results.hasIssues).toBe(true);
    });

    it("should return no issues for all clear criteria", () => {
      const criteria = [
        createAcceptanceCriterion("AC-1", "User can login with email"),
        createAcceptanceCriterion(
          "AC-2",
          "Login returns 400 for invalid input",
        ),
        createAcceptanceCriterion("AC-3", "Session expires after 30 minutes"),
      ];

      const results = lintAcceptanceCriteria(criteria);

      expect(results.summary.total).toBe(3);
      expect(results.summary.passed).toBe(3);
      expect(results.summary.flagged).toBe(0);
      expect(results.hasIssues).toBe(false);
    });

    it("should handle empty criteria array", () => {
      const results = lintAcceptanceCriteria([]);

      expect(results.summary.total).toBe(0);
      expect(results.summary.passed).toBe(0);
      expect(results.summary.flagged).toBe(0);
      expect(results.hasIssues).toBe(false);
    });
  });

  describe("formatACLintResults", () => {
    it("should format results with issues", () => {
      const criteria = [
        createAcceptanceCriterion("AC-1", "User can login"),
        createAcceptanceCriterion("AC-2", "System should work properly"),
        createAcceptanceCriterion("AC-3", "Page loads fast"),
      ];
      const results = lintAcceptanceCriteria(criteria);
      const output = formatACLintResults(results);

      expect(output).toContain("## AC Quality Check");
      expect(output).toContain("⚠️ **AC-2:**");
      expect(output).toContain("⚠️ **AC-3:**");
      expect(output).toContain("✅ AC-1: Clear and testable");
      expect(output).toContain("2/3 AC items flagged for review");
    });

    it("should format results without issues", () => {
      const criteria = [
        createAcceptanceCriterion("AC-1", "User can login with email"),
        createAcceptanceCriterion(
          "AC-2",
          "Login returns 400 for invalid input",
        ),
      ];
      const results = lintAcceptanceCriteria(criteria);
      const output = formatACLintResults(results);

      expect(output).toContain("## AC Quality Check");
      expect(output).toContain(
        "✅ All 2 acceptance criteria are clear and testable",
      );
      expect(output).not.toContain("⚠️");
    });

    it("should handle no criteria", () => {
      const results = lintAcceptanceCriteria([]);
      const output = formatACLintResults(results);

      expect(output).toContain("## AC Quality Check");
      expect(output).toContain("No acceptance criteria found to lint");
    });

    it("should include problem and suggestion for each issue", () => {
      const criteria = [
        createAcceptanceCriterion(
          "AC-1",
          "System should handle errors gracefully",
        ),
      ];
      const results = lintAcceptanceCriteria(criteria);
      const output = formatACLintResults(results);

      expect(output).toContain("→");
      expect(output).toContain("Suggest:");
    });
  });

  describe("getDefaultLintPatterns", () => {
    it("should return a copy of default patterns", () => {
      const patterns1 = getDefaultLintPatterns();
      const patterns2 = getDefaultLintPatterns();

      expect(patterns1).not.toBe(patterns2);
      expect(patterns1.length).toBe(patterns2.length);
      expect(patterns1.length).toBeGreaterThan(0);
    });
  });

  describe("createLintPatterns", () => {
    it("should create custom patterns from config", () => {
      const config = [
        {
          pattern: "\\bmagic\\b",
          type: "vague" as ACLintIssueType,
          problem: 'Custom: "magic" is not specific',
          suggestion: "Specify the actual mechanism",
        },
      ];

      const patterns = createLintPatterns(config);

      expect(patterns).toHaveLength(1);
      expect(patterns[0].regex.test("It works like magic")).toBe(true);
      expect(patterns[0].type).toBe("vague");
    });

    it("should use custom patterns in linting", () => {
      const config = [
        {
          pattern: "\\bmagic\\b",
          type: "vague" as ACLintIssueType,
          problem: 'Custom: "magic" is not specific',
          suggestion: "Specify the actual mechanism",
        },
      ];

      const patterns = createLintPatterns(config);
      const ac = createAcceptanceCriterion("AC-1", "It works like magic");
      const result = lintAcceptanceCriterion(ac, patterns);

      expect(result.passed).toBe(false);
      expect(result.issues[0].problem).toContain("magic");
    });
  });
});
