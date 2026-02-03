/**
 * Scope Assessment Module
 *
 * Provides scope analysis for /spec to catch overscoped issues early.
 *
 * @example
 * ```typescript
 * import { performScopeAssessment, formatScopeAssessment } from './scope';
 *
 * const criteria = parseAcceptanceCriteria(issueBody);
 * const assessment = performScopeAssessment(criteria, issueBody, issueTitle);
 *
 * if (assessment.verdict !== 'SCOPE_OK') {
 *   console.log(formatScopeAssessment(assessment));
 * }
 * ```
 */

import type { AcceptanceCriterion } from "../workflow/state-schema.js";
import type { ScopeAssessment, ScopeAssessmentConfig } from "./types.js";
import { DEFAULT_SCOPE_CONFIG } from "./types.js";
import {
  detectFeatures,
  parseNonGoals,
  shouldSkipAssessment,
} from "./analyzer.js";
import {
  createScopeMetrics,
  calculateVerdict,
  generateRecommendation,
} from "./verdict.js";

// Re-export types
export type {
  ScopeVerdict,
  ScopeMetricStatus,
  ScopeMetric,
  ScopeAssessment,
  ScopeAssessmentConfig,
  MetricThreshold,
  ACCluster,
  FeatureDetection,
  NonGoals,
} from "./types.js";

export { DEFAULT_SCOPE_CONFIG, ScopeAssessmentSchema } from "./types.js";

// Re-export analyzer functions
export {
  clusterACByKeyword,
  detectTitleVerbs,
  estimateDirectorySpread,
  calculateFeatureCount,
  detectFeatures,
  parseNonGoals,
  shouldSkipAssessment,
} from "./analyzer.js";

// Re-export verdict functions
export {
  getMetricStatus,
  createScopeMetrics,
  calculateVerdict,
  generateRecommendation,
  getVerdictEmoji,
  getStatusEmoji,
  shouldEnableQualityLoop,
} from "./verdict.js";

// Re-export formatter functions
export {
  formatNonGoals,
  formatMetricsTable,
  formatVerdict,
  formatScopeAssessment,
  formatCondensedAssessment,
} from "./formatter.js";

/**
 * Perform complete scope assessment
 *
 * This is the main entry point for scope assessment.
 *
 * @param criteria - Parsed acceptance criteria
 * @param issueBody - Full issue body markdown
 * @param title - Issue title
 * @param config - Optional custom configuration
 * @returns Complete scope assessment result
 */
export function performScopeAssessment(
  criteria: AcceptanceCriterion[],
  issueBody: string,
  title: string,
  config: ScopeAssessmentConfig = DEFAULT_SCOPE_CONFIG,
): ScopeAssessment {
  // Parse non-goals first
  const nonGoals = parseNonGoals(issueBody);

  // Detect features
  const featureDetection = detectFeatures(criteria, title);

  // Check if we should skip (trivial issue)
  const skipResult = shouldSkipAssessment(
    criteria.length,
    featureDetection.directorySpread,
    config,
  );

  if (skipResult.skip) {
    return {
      assessedAt: new Date().toISOString(),
      skipped: true,
      skipReason: skipResult.reason,
      verdict: "SCOPE_OK",
      metrics: [],
      featureDetection,
      nonGoals,
      recommendation: "Trivial issue - scope assessment skipped.",
    };
  }

  // Calculate metrics
  const metrics = createScopeMetrics(featureDetection, criteria.length, config);

  // Determine verdict
  const verdict = calculateVerdict(metrics, nonGoals);

  // Generate recommendation
  const recommendation = generateRecommendation(
    verdict,
    metrics,
    featureDetection,
    nonGoals,
  );

  return {
    assessedAt: new Date().toISOString(),
    skipped: false,
    verdict,
    metrics,
    featureDetection,
    nonGoals,
    recommendation,
  };
}
