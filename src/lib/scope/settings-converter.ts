/**
 * Settings to Config Converter
 *
 * Converts ScopeAssessmentSettings (from .sequant/settings.json)
 * to ScopeAssessmentConfig (used by performScopeAssessment).
 *
 * This enables users to configure custom scope thresholds
 * via their project settings file.
 */

import type { ScopeAssessmentSettings } from "../settings.js";
import type { ScopeAssessmentConfig, MetricThreshold } from "./types.js";
import { DEFAULT_SCOPE_CONFIG } from "./types.js";

/**
 * Convert ScopeAssessmentSettings to ScopeAssessmentConfig
 *
 * Merges user settings with defaults to produce a valid config.
 * Any missing fields are filled from DEFAULT_SCOPE_CONFIG.
 *
 * @param settings - User settings from .sequant/settings.json
 * @returns Complete config ready for performScopeAssessment
 *
 * @example
 * ```typescript
 * const settings = await getSettings();
 * const config = convertSettingsToConfig(settings.scopeAssessment);
 * const assessment = performScopeAssessment(criteria, body, title, config);
 * ```
 */
export function convertSettingsToConfig(
  settings?: Partial<ScopeAssessmentSettings>,
): ScopeAssessmentConfig {
  // Handle undefined/null settings
  if (!settings) {
    return DEFAULT_SCOPE_CONFIG;
  }

  // Helper to merge threshold with defaults
  const mergeThreshold = (
    userThreshold?: Partial<{ yellow: number; red: number }>,
    defaultThreshold?: MetricThreshold,
  ): MetricThreshold => ({
    yellow: userThreshold?.yellow ?? defaultThreshold?.yellow ?? 0,
    red: userThreshold?.red ?? defaultThreshold?.red ?? 0,
  });

  return {
    enabled: settings.enabled ?? DEFAULT_SCOPE_CONFIG.enabled,
    skipIfSimple: settings.skipIfSimple ?? DEFAULT_SCOPE_CONFIG.skipIfSimple,
    trivialThresholds: {
      maxACItems:
        settings.trivialThresholds?.maxACItems ??
        DEFAULT_SCOPE_CONFIG.trivialThresholds.maxACItems,
      maxDirectories:
        settings.trivialThresholds?.maxDirectories ??
        DEFAULT_SCOPE_CONFIG.trivialThresholds.maxDirectories,
    },
    thresholds: {
      featureCount: mergeThreshold(
        settings.thresholds?.featureCount,
        DEFAULT_SCOPE_CONFIG.thresholds.featureCount,
      ),
      acItems: mergeThreshold(
        settings.thresholds?.acItems,
        DEFAULT_SCOPE_CONFIG.thresholds.acItems,
      ),
      fileEstimate: mergeThreshold(
        settings.thresholds?.fileEstimate,
        DEFAULT_SCOPE_CONFIG.thresholds.fileEstimate,
      ),
      directorySpread: mergeThreshold(
        settings.thresholds?.directorySpread,
        DEFAULT_SCOPE_CONFIG.thresholds.directorySpread,
      ),
    },
  };
}
