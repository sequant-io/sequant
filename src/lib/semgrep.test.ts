/**
 * Tests for Semgrep integration
 */

import { describe, expect, it } from "vitest";

import {
  checkSemgrepAvailability,
  countFindingsBySeverity,
  formatFindingsForDisplay,
  getCustomRulesPath,
  getRulesForStack,
  getSemgrepVerdictContribution,
  hasCustomRules,
  parseSemgrepOutput,
  runSemgrepScan,
  SemgrepFinding,
  SemgrepResult,
  STACK_RULESETS,
} from "./semgrep.js";

describe("semgrep", () => {
  describe("getRulesForStack", () => {
    it("returns Next.js rules for nextjs stack", () => {
      const ruleset = getRulesForStack("nextjs");
      expect(ruleset.name).toBe("Next.js");
      expect(ruleset.rules).toContain("p/typescript");
      expect(ruleset.rules).toContain("p/react");
      expect(ruleset.rules).toContain("p/security-audit");
    });

    it("returns Python rules for python stack", () => {
      const ruleset = getRulesForStack("python");
      expect(ruleset.name).toBe("Python");
      expect(ruleset.rules).toContain("p/python");
      expect(ruleset.rules).toContain("p/django");
      expect(ruleset.rules).toContain("p/flask");
    });

    it("returns Go rules for go stack", () => {
      const ruleset = getRulesForStack("go");
      expect(ruleset.name).toBe("Go");
      expect(ruleset.rules).toContain("p/golang");
    });

    it("returns Rust rules for rust stack", () => {
      const ruleset = getRulesForStack("rust");
      expect(ruleset.name).toBe("Rust");
      expect(ruleset.rules).toContain("p/rust");
    });

    it("returns generic rules for unknown stack", () => {
      const ruleset = getRulesForStack("unknown");
      expect(ruleset.name).toBe("Generic");
      expect(ruleset.rules).toContain("p/security-audit");
    });

    it("returns generic rules for null stack", () => {
      const ruleset = getRulesForStack(null);
      expect(ruleset.name).toBe("Generic");
    });

    it("all stacks include security-audit and secrets rules", () => {
      for (const [stackName, ruleset] of Object.entries(STACK_RULESETS)) {
        expect(
          ruleset.rules,
          `${stackName} should include security-audit`,
        ).toContain("p/security-audit");
        expect(ruleset.rules, `${stackName} should include secrets`).toContain(
          "p/secrets",
        );
      }
    });
  });

  describe("parseSemgrepOutput", () => {
    it("parses valid JSON output with results", () => {
      const output = JSON.stringify({
        results: [
          {
            path: "src/app.ts",
            start: { line: 10, col: 5 },
            end: { line: 10, col: 20 },
            extra: {
              message: "Potential SQL injection",
              severity: "error",
              metadata: { category: "security" },
            },
            check_id: "typescript.security.sql-injection",
          },
        ],
      });

      const findings = parseSemgrepOutput(output);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toEqual({
        path: "src/app.ts",
        line: 10,
        column: 5,
        endLine: 10,
        endColumn: 20,
        message: "Potential SQL injection",
        ruleId: "typescript.security.sql-injection",
        severity: "error",
        category: "security",
      });
    });

    it("handles empty results array", () => {
      const output = JSON.stringify({ results: [] });
      const findings = parseSemgrepOutput(output);
      expect(findings).toHaveLength(0);
    });

    it("handles invalid JSON gracefully", () => {
      const findings = parseSemgrepOutput("not valid json");
      expect(findings).toHaveLength(0);
    });

    it("maps severity levels correctly", () => {
      const makeResult = (severity: string) =>
        JSON.stringify({
          results: [
            {
              path: "test.ts",
              start: { line: 1 },
              extra: { message: "test", severity },
              check_id: "test",
            },
          ],
        });

      expect(parseSemgrepOutput(makeResult("error"))[0].severity).toBe("error");
      expect(parseSemgrepOutput(makeResult("critical"))[0].severity).toBe(
        "error",
      );
      expect(parseSemgrepOutput(makeResult("high"))[0].severity).toBe("error");
      expect(parseSemgrepOutput(makeResult("warning"))[0].severity).toBe(
        "warning",
      );
      expect(parseSemgrepOutput(makeResult("medium"))[0].severity).toBe(
        "warning",
      );
      expect(parseSemgrepOutput(makeResult("info"))[0].severity).toBe("info");
      expect(parseSemgrepOutput(makeResult("low"))[0].severity).toBe("info");
    });
  });

  describe("countFindingsBySeverity", () => {
    it("counts findings correctly", () => {
      const findings: SemgrepFinding[] = [
        {
          path: "a.ts",
          line: 1,
          message: "critical",
          ruleId: "r1",
          severity: "error",
        },
        {
          path: "b.ts",
          line: 2,
          message: "critical2",
          ruleId: "r2",
          severity: "error",
        },
        {
          path: "c.ts",
          line: 3,
          message: "warning",
          ruleId: "r3",
          severity: "warning",
        },
        {
          path: "d.ts",
          line: 4,
          message: "info",
          ruleId: "r4",
          severity: "info",
        },
      ];

      const counts = countFindingsBySeverity(findings);
      expect(counts.critical).toBe(2);
      expect(counts.warning).toBe(1);
      expect(counts.info).toBe(1);
    });

    it("returns zeros for empty array", () => {
      const counts = countFindingsBySeverity([]);
      expect(counts.critical).toBe(0);
      expect(counts.warning).toBe(0);
      expect(counts.info).toBe(0);
    });
  });

  describe("formatFindingsForDisplay", () => {
    it("returns success message for no findings", () => {
      const output = formatFindingsForDisplay([]);
      expect(output).toBe("✅ No findings");
    });

    it("formats critical findings with correct heading", () => {
      const findings: SemgrepFinding[] = [
        {
          path: "src/api.ts",
          line: 42,
          message: "SQL injection vulnerability",
          ruleId: "security.sql-injection",
          severity: "error",
        },
      ];

      const output = formatFindingsForDisplay(findings);
      expect(output).toContain("### ❌ Critical Issues");
      expect(output).toContain("`src/api.ts:42`");
      expect(output).toContain("SQL injection vulnerability");
    });

    it("formats warnings with correct heading", () => {
      const findings: SemgrepFinding[] = [
        {
          path: "src/utils.ts",
          line: 10,
          message: "Potential memory leak",
          ruleId: "performance.memory-leak",
          severity: "warning",
        },
      ];

      const output = formatFindingsForDisplay(findings);
      expect(output).toContain("### ⚠️ Warnings");
      expect(output).toContain("`src/utils.ts:10`");
    });

    it("groups findings by severity", () => {
      const findings: SemgrepFinding[] = [
        {
          path: "a.ts",
          line: 1,
          message: "critical",
          ruleId: "r1",
          severity: "error",
        },
        {
          path: "b.ts",
          line: 2,
          message: "warning",
          ruleId: "r2",
          severity: "warning",
        },
        {
          path: "c.ts",
          line: 3,
          message: "info",
          ruleId: "r3",
          severity: "info",
        },
      ];

      const output = formatFindingsForDisplay(findings);
      const criticalIndex = output.indexOf("### ❌ Critical Issues");
      const warningIndex = output.indexOf("### ⚠️ Warnings");
      const infoIndex = output.indexOf("### ℹ️ Info");

      expect(criticalIndex).toBeLessThan(warningIndex);
      expect(warningIndex).toBeLessThan(infoIndex);
    });
  });

  describe("getSemgrepVerdictContribution", () => {
    it("returns blocking for critical findings", () => {
      const result: SemgrepResult = {
        success: true,
        findings: [],
        criticalCount: 2,
        warningCount: 0,
        infoCount: 0,
      };

      const verdict = getSemgrepVerdictContribution(result);
      expect(verdict.blocking).toBe(true);
      expect(verdict.reason).toContain("2 critical");
    });

    it("returns non-blocking for warnings only", () => {
      const result: SemgrepResult = {
        success: true,
        findings: [],
        criticalCount: 0,
        warningCount: 3,
        infoCount: 0,
      };

      const verdict = getSemgrepVerdictContribution(result);
      expect(verdict.blocking).toBe(false);
      expect(verdict.reason).toContain("3 warning(s)");
    });

    it("returns non-blocking when skipped", () => {
      const result: SemgrepResult = {
        success: true,
        findings: [],
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
        skipped: true,
        skipReason: "Semgrep not installed",
      };

      const verdict = getSemgrepVerdictContribution(result);
      expect(verdict.blocking).toBe(false);
      expect(verdict.reason).toContain("skipped");
    });

    it("returns non-blocking on error", () => {
      const result: SemgrepResult = {
        success: false,
        findings: [],
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
        error: "Network error",
      };

      const verdict = getSemgrepVerdictContribution(result);
      expect(verdict.blocking).toBe(false);
      expect(verdict.reason).toContain("error");
    });

    it("returns clean result when no issues", () => {
      const result: SemgrepResult = {
        success: true,
        findings: [],
        criticalCount: 0,
        warningCount: 0,
        infoCount: 0,
      };

      const verdict = getSemgrepVerdictContribution(result);
      expect(verdict.blocking).toBe(false);
      expect(verdict.reason).toContain("No security issues");
    });
  });

  describe("hasCustomRules", () => {
    it("returns false for non-existent path", () => {
      const result = hasCustomRules("/non/existent/path");
      expect(result).toBe(false);
    });
  });

  describe("getCustomRulesPath", () => {
    it("returns null for non-existent path", () => {
      const result = getCustomRulesPath("/non/existent/path");
      expect(result).toBeNull();
    });
  });

  // ============================================================
  // Integration Tests (run only when Semgrep is available)
  // ============================================================

  describe("integration: checkSemgrepAvailability", () => {
    it("returns availability status", async () => {
      const result = await checkSemgrepAvailability();

      // Should always return a valid structure
      expect(result).toHaveProperty("available");
      expect(result).toHaveProperty("command");
      expect(result).toHaveProperty("useNpx");
      expect(typeof result.available).toBe("boolean");
      expect(typeof result.useNpx).toBe("boolean");

      if (result.available) {
        expect(result.command).toBeTruthy();
        console.log(
          `  ✓ Semgrep available via: ${result.useNpx ? "npx" : "native"}`,
        );
      } else {
        expect(result.command).toBe("");
        console.log("  ⚠ Semgrep not installed (skipping integration tests)");
      }
    });
  });

  describe("integration: runSemgrepScan", () => {
    it("returns skipped result when semgrep not available", async () => {
      const availability = await checkSemgrepAvailability();
      if (availability.available) {
        // Skip this test if Semgrep IS available
        console.log("  ⚠ Skipping (Semgrep is available)");
        return;
      }

      const result = await runSemgrepScan({
        targets: ["."],
        stack: "generic",
      });

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.skipReason).toContain("not installed");
      expect(result.findings).toEqual([]);
    });

    it("scans files when semgrep is available", async () => {
      const availability = await checkSemgrepAvailability();
      if (!availability.available) {
        console.log("  ⚠ Skipping (Semgrep not installed)");
        return;
      }

      // Scan this test file itself (should be clean)
      const result = await runSemgrepScan({
        targets: ["src/lib/semgrep.test.ts"],
        stack: "nextjs",
        useCustomRules: false,
      });

      expect(result.success).toBe(true);
      expect(result.skipped).toBeFalsy();
      expect(Array.isArray(result.findings)).toBe(true);
      expect(typeof result.criticalCount).toBe("number");
      expect(typeof result.warningCount).toBe("number");
      expect(typeof result.infoCount).toBe("number");

      console.log(
        `  ✓ Scan complete: ${result.criticalCount} critical, ${result.warningCount} warnings, ${result.infoCount} info`,
      );
    }, 30000);

    it("applies stack-specific rules", async () => {
      const availability = await checkSemgrepAvailability();
      if (!availability.available) {
        console.log("  ⚠ Skipping (Semgrep not installed)");
        return;
      }

      // Scan with different stacks - should not error
      const stacks = ["nextjs", "python", "go", "generic"];

      for (const stack of stacks) {
        const result = await runSemgrepScan({
          targets: ["src/lib/semgrep.ts"],
          stack,
          useCustomRules: false,
        });

        expect(result.success).toBe(true);
        console.log(`  ✓ Stack "${stack}": ${result.findings.length} findings`);
      }
    }, 120000); // 2 minutes for 4 stack scans

    it("handles non-existent target gracefully", async () => {
      const availability = await checkSemgrepAvailability();
      if (!availability.available) {
        console.log("  ⚠ Skipping (Semgrep not installed)");
        return;
      }

      const result = await runSemgrepScan({
        targets: ["non/existent/file.ts"],
        stack: "generic",
      });

      // Semgrep should handle missing files gracefully
      // (either success with no findings, or error)
      expect(typeof result.success).toBe("boolean");
      expect(Array.isArray(result.findings)).toBe(true);
    }, 30000);
  });
});
