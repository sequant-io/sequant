import { describe, it, expect } from "vitest";
import {
  mergePhaseSignals,
  signalFromLabel,
  signalsFromLabels,
  formatMergedPhases,
  SIGNAL_PRIORITY,
  type PhaseSignal,
} from "./phase-signal.js";

describe("phase-signal", () => {
  describe("SIGNAL_PRIORITY", () => {
    it("should have labels as highest priority", () => {
      expect(SIGNAL_PRIORITY.label).toBeGreaterThan(SIGNAL_PRIORITY.solve);
      expect(SIGNAL_PRIORITY.label).toBeGreaterThan(SIGNAL_PRIORITY.title);
      expect(SIGNAL_PRIORITY.label).toBeGreaterThan(SIGNAL_PRIORITY.body);
    });

    it("should have solve higher than content", () => {
      expect(SIGNAL_PRIORITY.solve).toBeGreaterThan(SIGNAL_PRIORITY.title);
      expect(SIGNAL_PRIORITY.solve).toBeGreaterThan(SIGNAL_PRIORITY.body);
    });

    it("should have title higher than body", () => {
      expect(SIGNAL_PRIORITY.title).toBeGreaterThan(SIGNAL_PRIORITY.body);
    });
  });

  describe("mergePhaseSignals", () => {
    it("should deduplicate phases", () => {
      const signals: PhaseSignal[] = [
        { phase: "test", source: "title", confidence: "high" },
        { phase: "test", source: "body", confidence: "medium" },
      ];

      const result = mergePhaseSignals(signals);

      expect(result.phases).toEqual(["test"]);
    });

    it("should keep highest priority signal for each phase", () => {
      const signals: PhaseSignal[] = [
        {
          phase: "test",
          source: "body",
          confidence: "high",
          reason: "From body",
        },
        {
          phase: "test",
          source: "label",
          confidence: "high",
          reason: "From label",
        },
      ];

      const result = mergePhaseSignals(signals);

      expect(result.phaseSignals.get("test")?.source).toBe("label");
    });

    it("should keep first signal when priorities are equal", () => {
      const signals: PhaseSignal[] = [
        {
          phase: "test",
          source: "title",
          confidence: "high",
          reason: "First",
        },
        {
          phase: "test",
          source: "title",
          confidence: "high",
          reason: "Second",
        },
      ];

      const result = mergePhaseSignals(signals);

      expect(result.phaseSignals.get("test")?.reason).toBe("First");
    });

    it("should separate quality-loop from phases", () => {
      const signals: PhaseSignal[] = [
        { phase: "test", source: "title", confidence: "high" },
        { phase: "quality-loop", source: "title", confidence: "high" },
      ];

      const result = mergePhaseSignals(signals);

      expect(result.phases).toEqual(["test"]);
      expect(result.qualityLoop).toBe(true);
    });

    it("should return empty result for empty signals", () => {
      const result = mergePhaseSignals([]);

      expect(result.phases).toEqual([]);
      expect(result.qualityLoop).toBe(false);
      expect(result.allSignals).toEqual([]);
    });

    it("should preserve all signals in allSignals", () => {
      const signals: PhaseSignal[] = [
        { phase: "test", source: "title", confidence: "high" },
        { phase: "test", source: "body", confidence: "medium" },
        { phase: "security-review", source: "label", confidence: "high" },
      ];

      const result = mergePhaseSignals(signals);

      expect(result.allSignals).toHaveLength(3);
    });
  });

  describe("signalFromLabel", () => {
    describe("UI labels", () => {
      it("should return test phase for 'ui' label", () => {
        const signal = signalFromLabel("ui");

        expect(signal).toMatchObject({
          phase: "test",
          source: "label",
          confidence: "high",
        });
      });

      it("should return test phase for 'frontend' label", () => {
        const signal = signalFromLabel("frontend");

        expect(signal).toMatchObject({
          phase: "test",
          source: "label",
          confidence: "high",
        });
      });

      it("should return test phase for 'admin' label", () => {
        const signal = signalFromLabel("admin");

        expect(signal).toMatchObject({
          phase: "test",
          source: "label",
          confidence: "high",
        });
      });
    });

    describe("Security labels", () => {
      it("should return security-review phase for 'security' label", () => {
        const signal = signalFromLabel("security");

        expect(signal).toMatchObject({
          phase: "security-review",
          source: "label",
          confidence: "high",
        });
      });

      it("should return security-review phase for 'auth' label", () => {
        const signal = signalFromLabel("auth");

        expect(signal).toMatchObject({
          phase: "security-review",
          source: "label",
          confidence: "high",
        });
      });
    });

    describe("Complex work labels", () => {
      it("should return quality-loop for 'refactor' label", () => {
        const signal = signalFromLabel("refactor");

        expect(signal).toMatchObject({
          phase: "quality-loop",
          source: "label",
          confidence: "high",
        });
      });

      it("should return quality-loop for 'complex' label", () => {
        const signal = signalFromLabel("complex");

        expect(signal).toMatchObject({
          phase: "quality-loop",
          source: "label",
          confidence: "high",
        });
      });

      it("should return quality-loop for 'breaking' label", () => {
        const signal = signalFromLabel("breaking");

        expect(signal).toMatchObject({
          phase: "quality-loop",
          source: "label",
          confidence: "high",
        });
      });
    });

    describe("Non-phase labels", () => {
      it("should return null for 'backend' label", () => {
        const signal = signalFromLabel("backend");

        expect(signal).toBeNull();
      });

      it("should return null for unknown labels", () => {
        const signal = signalFromLabel("enhancement");

        expect(signal).toBeNull();
      });
    });

    it("should be case-insensitive", () => {
      const signal = signalFromLabel("UI");

      expect(signal).toMatchObject({
        phase: "test",
        source: "label",
      });
    });
  });

  describe("signalsFromLabels", () => {
    it("should convert multiple labels to signals", () => {
      const signals = signalsFromLabels(["ui", "security", "enhancement"]);

      expect(signals).toHaveLength(2);
      expect(signals).toContainEqual(
        expect.objectContaining({ phase: "test" }),
      );
      expect(signals).toContainEqual(
        expect.objectContaining({ phase: "security-review" }),
      );
    });

    it("should return empty array for no matching labels", () => {
      const signals = signalsFromLabels(["enhancement", "bug"]);

      expect(signals).toHaveLength(0);
    });

    it("should handle empty array", () => {
      const signals = signalsFromLabels([]);

      expect(signals).toHaveLength(0);
    });
  });

  describe("formatMergedPhases", () => {
    it("should format empty result", () => {
      const result = mergePhaseSignals([]);

      const output = formatMergedPhases(result);

      expect(output).toContain("## Phase Signal Summary");
      expect(output).toContain("No phase signals detected");
    });

    it("should format result with signals", () => {
      const signals: PhaseSignal[] = [
        {
          phase: "test",
          source: "label",
          confidence: "high",
          reason: "UI label",
        },
        {
          phase: "security-review",
          source: "body",
          confidence: "medium",
          reason: "Auth reference",
        },
      ];

      const result = mergePhaseSignals(signals);
      const output = formatMergedPhases(result);

      expect(output).toContain("## Phase Signal Summary");
      expect(output).toContain("### Signal Sources");
      expect(output).toContain("| Phase |");
      expect(output).toContain("/test");
      expect(output).toContain("/security-review");
    });

    it("should show quality-loop in output", () => {
      const signals: PhaseSignal[] = [
        {
          phase: "quality-loop",
          source: "label",
          confidence: "high",
          reason: "Complex",
        },
      ];

      const result = mergePhaseSignals(signals);
      const output = formatMergedPhases(result);

      expect(output).toContain("quality-loop");
      expect(output).toContain("**Quality loop:** Enabled");
    });

    it("should show final recommendations", () => {
      const signals: PhaseSignal[] = [
        { phase: "test", source: "label", confidence: "high" },
      ];

      const result = mergePhaseSignals(signals);
      const output = formatMergedPhases(result);

      expect(output).toContain("### Final Recommendations");
      expect(output).toContain("**Phases to add:**");
    });
  });
});
