/**
 * Tests for settings-converter.ts
 *
 * Verifies that ScopeAssessmentSettings are correctly converted
 * to ScopeAssessmentConfig with proper default merging.
 */

import { describe, it, expect } from "vitest";
import { convertSettingsToConfig } from "./settings-converter.js";
import { DEFAULT_SCOPE_CONFIG } from "./types.js";
import type { ScopeAssessmentSettings } from "../settings.js";

describe("convertSettingsToConfig", () => {
  describe("undefined/null handling", () => {
    it("should return DEFAULT_SCOPE_CONFIG when settings is undefined", () => {
      const result = convertSettingsToConfig(undefined);
      expect(result).toEqual(DEFAULT_SCOPE_CONFIG);
    });

    it("should return DEFAULT_SCOPE_CONFIG when settings is empty object", () => {
      const result = convertSettingsToConfig({});
      expect(result).toEqual(DEFAULT_SCOPE_CONFIG);
    });
  });

  describe("full settings conversion", () => {
    it("should convert full settings correctly", () => {
      const fullSettings: ScopeAssessmentSettings = {
        enabled: false,
        skipIfSimple: false,
        trivialThresholds: {
          maxACItems: 5,
          maxDirectories: 2,
        },
        thresholds: {
          featureCount: { yellow: 3, red: 5 },
          acItems: { yellow: 8, red: 12 },
          fileEstimate: { yellow: 10, red: 15 },
          directorySpread: { yellow: 4, red: 6 },
        },
      };

      const result = convertSettingsToConfig(fullSettings);

      expect(result.enabled).toBe(false);
      expect(result.skipIfSimple).toBe(false);
      expect(result.trivialThresholds.maxACItems).toBe(5);
      expect(result.trivialThresholds.maxDirectories).toBe(2);
      expect(result.thresholds.featureCount).toEqual({ yellow: 3, red: 5 });
      expect(result.thresholds.acItems).toEqual({ yellow: 8, red: 12 });
      expect(result.thresholds.fileEstimate).toEqual({ yellow: 10, red: 15 });
      expect(result.thresholds.directorySpread).toEqual({ yellow: 4, red: 6 });
    });
  });

  describe("partial settings with defaults", () => {
    it("should merge partial settings with defaults", () => {
      const partialSettings: Partial<ScopeAssessmentSettings> = {
        enabled: false,
        // skipIfSimple missing - should default
        // trivialThresholds missing - should default
        thresholds: {
          featureCount: { yellow: 2, red: 3 },
          acItems: { yellow: 10, red: 15 }, // Custom values
          fileEstimate: { yellow: 8, red: 13 },
          directorySpread: { yellow: 3, red: 5 },
        },
      };

      const result = convertSettingsToConfig(partialSettings);

      expect(result.enabled).toBe(false);
      expect(result.skipIfSimple).toBe(DEFAULT_SCOPE_CONFIG.skipIfSimple);
      expect(result.trivialThresholds).toEqual(
        DEFAULT_SCOPE_CONFIG.trivialThresholds,
      );
      expect(result.thresholds.acItems).toEqual({ yellow: 10, red: 15 });
    });

    it("should handle partial trivialThresholds", () => {
      const partialSettings: Partial<ScopeAssessmentSettings> = {
        trivialThresholds: {
          maxACItems: 10,
          // maxDirectories missing - should default
        } as ScopeAssessmentSettings["trivialThresholds"],
      };

      const result = convertSettingsToConfig(partialSettings);

      expect(result.trivialThresholds.maxACItems).toBe(10);
      expect(result.trivialThresholds.maxDirectories).toBe(
        DEFAULT_SCOPE_CONFIG.trivialThresholds.maxDirectories,
      );
    });

    it("should handle partial threshold values", () => {
      const partialSettings: Partial<ScopeAssessmentSettings> = {
        thresholds: {
          featureCount: { yellow: 5, red: 3 }, // Custom
          // acItems missing - should default
          // fileEstimate missing - should default
          // directorySpread missing - should default
        } as ScopeAssessmentSettings["thresholds"],
      };

      const result = convertSettingsToConfig(partialSettings);

      expect(result.thresholds.featureCount).toEqual({ yellow: 5, red: 3 });
      expect(result.thresholds.acItems).toEqual(
        DEFAULT_SCOPE_CONFIG.thresholds.acItems,
      );
      expect(result.thresholds.fileEstimate).toEqual(
        DEFAULT_SCOPE_CONFIG.thresholds.fileEstimate,
      );
      expect(result.thresholds.directorySpread).toEqual(
        DEFAULT_SCOPE_CONFIG.thresholds.directorySpread,
      );
    });
  });

  describe("edge values", () => {
    it("should handle zero values (not treat as falsy)", () => {
      const settings: Partial<ScopeAssessmentSettings> = {
        trivialThresholds: {
          maxACItems: 0,
          maxDirectories: 0,
        },
        thresholds: {
          featureCount: { yellow: 0, red: 0 },
          acItems: { yellow: 0, red: 0 },
          fileEstimate: { yellow: 0, red: 0 },
          directorySpread: { yellow: 0, red: 0 },
        },
      };

      const result = convertSettingsToConfig(settings);

      expect(result.trivialThresholds.maxACItems).toBe(0);
      expect(result.trivialThresholds.maxDirectories).toBe(0);
      expect(result.thresholds.featureCount).toEqual({ yellow: 0, red: 0 });
    });

    it("should handle large values", () => {
      const settings: Partial<ScopeAssessmentSettings> = {
        thresholds: {
          featureCount: { yellow: 100, red: 200 },
          acItems: { yellow: 50, red: 100 },
          fileEstimate: { yellow: 1000, red: 2000 },
          directorySpread: { yellow: 20, red: 50 },
        },
      };

      const result = convertSettingsToConfig(settings);

      expect(result.thresholds.featureCount).toEqual({ yellow: 100, red: 200 });
      expect(result.thresholds.acItems).toEqual({ yellow: 50, red: 100 });
    });
  });

  describe("type safety", () => {
    it("should produce valid ScopeAssessmentConfig", () => {
      const result = convertSettingsToConfig({});

      // Verify all required fields exist
      expect(typeof result.enabled).toBe("boolean");
      expect(typeof result.skipIfSimple).toBe("boolean");
      expect(typeof result.trivialThresholds.maxACItems).toBe("number");
      expect(typeof result.trivialThresholds.maxDirectories).toBe("number");
      expect(typeof result.thresholds.featureCount.yellow).toBe("number");
      expect(typeof result.thresholds.featureCount.red).toBe("number");
      expect(typeof result.thresholds.acItems.yellow).toBe("number");
      expect(typeof result.thresholds.acItems.red).toBe("number");
      expect(typeof result.thresholds.fileEstimate.yellow).toBe("number");
      expect(typeof result.thresholds.fileEstimate.red).toBe("number");
      expect(typeof result.thresholds.directorySpread.yellow).toBe("number");
      expect(typeof result.thresholds.directorySpread.red).toBe("number");
    });
  });
});
