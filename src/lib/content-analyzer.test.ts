import { describe, it, expect } from "vitest";
import {
  analyzeTitleForPhases,
  analyzeBodyForPhases,
  analyzeContentForPhases,
  isTrivialWork,
  formatContentAnalysis,
} from "./content-analyzer.js";

describe("content-analyzer", () => {
  describe("analyzeTitleForPhases", () => {
    describe("UI work detection", () => {
      it("should detect 'extract' keyword", () => {
        const signals = analyzeTitleForPhases(
          "Extract header component from main layout",
        );

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "test",
            source: "title",
            confidence: "high",
            pattern: expect.stringContaining("extract"),
          }),
        );
      });

      it("should detect 'component' keyword", () => {
        const signals = analyzeTitleForPhases("Add new UserCard component");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "test",
            source: "title",
            confidence: "medium",
          }),
        );
      });

      it("should detect 'refactor ui' pattern", () => {
        const signals = analyzeTitleForPhases("Refactor UI for dashboard page");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "test",
            source: "title",
            confidence: "high",
          }),
        );
      });

      it("should detect 'dashboard' keyword", () => {
        const signals = analyzeTitleForPhases("Update dashboard metrics");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "test",
            source: "title",
            confidence: "medium",
          }),
        );
      });

      it("should detect 'frontend' keyword", () => {
        const signals = analyzeTitleForPhases("Frontend optimization");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "test",
            source: "title",
            confidence: "medium",
          }),
        );
      });
    });

    describe("Security detection", () => {
      it("should detect 'auth' keyword", () => {
        const signals = analyzeTitleForPhases("Add authentication middleware");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "security-review",
            source: "title",
            confidence: "high",
          }),
        );
      });

      it("should detect 'permission' keyword", () => {
        const signals = analyzeTitleForPhases("Fix permission check bug");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "security-review",
            source: "title",
            confidence: "high",
          }),
        );
      });

      it("should detect 'security' keyword", () => {
        const signals = analyzeTitleForPhases("Security hardening");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "security-review",
            source: "title",
            confidence: "high",
          }),
        );
      });

      it("should detect 'password' keyword", () => {
        const signals = analyzeTitleForPhases("Password reset flow");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "security-review",
            source: "title",
            confidence: "high",
          }),
        );
      });
    });

    describe("Complex work detection", () => {
      it("should detect 'refactor' keyword for quality loop", () => {
        const signals = analyzeTitleForPhases("Refactor database layer");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "quality-loop",
            source: "title",
            confidence: "medium",
          }),
        );
      });

      it("should detect 'migration' keyword", () => {
        const signals = analyzeTitleForPhases("Database migration for users");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "quality-loop",
            source: "title",
            confidence: "high",
          }),
        );
      });

      it("should detect 'breaking change' phrase", () => {
        const signals = analyzeTitleForPhases(
          "Breaking change to API endpoints",
        );

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "quality-loop",
            source: "title",
            confidence: "high",
          }),
        );
      });
    });

    it("should return empty array for unrelated title", () => {
      const signals = analyzeTitleForPhases("Update README documentation");

      expect(signals).toHaveLength(0);
    });
  });

  describe("analyzeBodyForPhases", () => {
    describe("UI work detection", () => {
      it("should detect .tsx file references", () => {
        const signals = analyzeBodyForPhases("Modify the Header.tsx component");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "test",
            source: "body",
            confidence: "medium",
          }),
        );
      });

      it("should detect components/ directory references", () => {
        const signals = analyzeBodyForPhases(
          "Update files in components/admin/",
        );

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "test",
            source: "body",
            confidence: "medium",
          }),
        );
      });

      it("should detect Next.js page references", () => {
        const signals = analyzeBodyForPhases("Edit app/dashboard/page.tsx");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "test",
            source: "body",
            confidence: "high",
          }),
        );
      });
    });

    describe("Security detection", () => {
      it("should detect auth/ directory references", () => {
        const signals = analyzeBodyForPhases("Modify auth/login.ts");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "security-review",
            source: "body",
            confidence: "high",
          }),
        );
      });

      it("should detect middleware.ts references", () => {
        const signals = analyzeBodyForPhases("Update middleware.ts");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "security-review",
            source: "body",
            confidence: "medium",
          }),
        );
      });

      it("should detect RLS policy mentions", () => {
        const signals = analyzeBodyForPhases(
          "Update the RLS policies for users table",
        );

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "security-review",
            source: "body",
            confidence: "high",
          }),
        );
      });
    });

    describe("CLI/Script detection", () => {
      it("should detect scripts/ directory references", () => {
        const signals = analyzeBodyForPhases("Modify scripts/build.sh");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "exec",
            source: "body",
            confidence: "medium",
          }),
        );
      });

      it("should detect bin/ directory references", () => {
        const signals = analyzeBodyForPhases("Update bin/cli.js");

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "exec",
            source: "body",
            confidence: "medium",
          }),
        );
      });
    });

    describe("Complexity detection", () => {
      it("should detect 'breaking change' in body", () => {
        const signals = analyzeBodyForPhases(
          "This is a breaking change that affects the API",
        );

        expect(signals).toContainEqual(
          expect.objectContaining({
            phase: "quality-loop",
            source: "body",
            confidence: "high",
          }),
        );
      });
    });

    it("should return empty array for unrelated body", () => {
      const signals = analyzeBodyForPhases("This updates the documentation");

      expect(signals).toHaveLength(0);
    });
  });

  describe("isTrivialWork", () => {
    it("should detect 'fix unused' pattern", () => {
      expect(isTrivialWork("Fix unused variables", "")).toBe(true);
    });

    it("should detect 'remove variable' pattern", () => {
      expect(isTrivialWork("Remove unused variable from function", "")).toBe(
        true,
      );
    });

    it("should detect 'typo' pattern", () => {
      expect(isTrivialWork("Fix typo in README", "")).toBe(true);
    });

    it("should detect 'whitespace' pattern", () => {
      expect(isTrivialWork("", "Fix whitespace issues")).toBe(true);
    });

    it("should detect 'formatting' pattern", () => {
      expect(isTrivialWork("Code formatting fixes", "")).toBe(true);
    });

    it("should return false for non-trivial work", () => {
      expect(isTrivialWork("Add new feature", "Implement user dashboard")).toBe(
        false,
      );
    });
  });

  describe("analyzeContentForPhases", () => {
    it("should combine title and body signals", () => {
      const result = analyzeContentForPhases(
        "Extract header component",
        "Modify components/admin/Header.tsx",
      );

      expect(result.phases).toContain("test");
      expect(result.signals.length).toBeGreaterThan(0);
    });

    it("should deduplicate phases", () => {
      const result = analyzeContentForPhases(
        "Add dashboard component", // title: test
        "Update components/dashboard.tsx", // body: test
      );

      // Should have test only once
      const testCount = result.phases.filter((p) => p === "test").length;
      expect(testCount).toBe(1);
    });

    it("should keep highest confidence signal for each phase", () => {
      const result = analyzeContentForPhases(
        "Extract component", // high confidence for test
        "Update some page.tsx", // lower confidence
      );

      // Find the test signal in phaseSignals
      const testSignals = result.signals.filter((s) => s.phase === "test");
      const highConfidenceSignal = testSignals.find(
        (s) => s.confidence === "high",
      );

      expect(highConfidenceSignal).toBeDefined();
    });

    it("should set qualityLoop for complex work", () => {
      const result = analyzeContentForPhases(
        "Major refactor of database layer",
        "This is a breaking change",
      );

      expect(result.qualityLoop).toBe(true);
    });

    it("should add note for trivial work", () => {
      const result = analyzeContentForPhases("Fix typo in header", "");

      expect(result.notes).toContainEqual(
        expect.stringContaining("Trivial work"),
      );
    });

    it("should add note for UI work", () => {
      const result = analyzeContentForPhases("Extract component", "");

      expect(result.notes).toContainEqual(
        expect.stringContaining("UI/component work"),
      );
    });

    it("should add note for security-sensitive content", () => {
      const result = analyzeContentForPhases("Update authentication", "");

      expect(result.notes).toContainEqual(
        expect.stringContaining("Security-sensitive"),
      );
    });

    it("should return empty result for unrelated content", () => {
      const result = analyzeContentForPhases(
        "Update docs",
        "Fix documentation typos", // Note: typo is trivial but still returns empty phases
      );

      expect(result.phases).toHaveLength(0);
      expect(result.qualityLoop).toBe(false);
    });
  });

  describe("formatContentAnalysis", () => {
    it("should format empty result", () => {
      const result = {
        phases: [],
        qualityLoop: false,
        signals: [],
        notes: [],
      };

      const output = formatContentAnalysis(result);

      expect(output).toContain("## Content Analysis");
      expect(output).toContain("No phase-relevant patterns detected");
    });

    it("should format result with signals", () => {
      const result = analyzeContentForPhases(
        "Extract header component",
        "Update Header.tsx",
      );

      const output = formatContentAnalysis(result);

      expect(output).toContain("## Content Analysis");
      expect(output).toContain("### Detected Signals");
      expect(output).toContain("| Source |");
      expect(output).toContain("/test");
    });

    it("should show recommendations section when phases exist", () => {
      const result = analyzeContentForPhases(
        "Add authentication",
        "Update auth/login.ts",
      );

      const output = formatContentAnalysis(result);

      expect(output).toContain("### Recommendations");
      expect(output).toContain("**Additional phases:**");
    });

    it("should show quality loop recommendation", () => {
      const result = analyzeContentForPhases(
        "Major refactor",
        "Breaking change to API",
      );

      const output = formatContentAnalysis(result);

      expect(output).toContain("**Quality loop:** Recommended");
    });

    it("should show notes section", () => {
      const result = analyzeContentForPhases(
        "Extract component",
        "Update Header.tsx",
      );

      const output = formatContentAnalysis(result);

      expect(output).toContain("### Notes");
    });
  });
});
