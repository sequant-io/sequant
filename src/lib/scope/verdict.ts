/**
 * Scope Verdict Calculator
 *
 * Determines scope verdict based on metrics and thresholds.
 * Provides recommendations for scope improvement.
 *
 * @example
 * ```typescript
 * import { calculateVerdict, getMetricStatus } from './verdict';
 *
 * const metrics = [
 *   { name: 'featureCount', value: 2, status: 'yellow' },
 *   { name: 'acItems', value: 8, status: 'yellow' },
 * ];
 * const verdict = calculateVerdict(metrics);
 * // Returns: 'SCOPE_WARNING'
 * ```
 */

import type {
  ScopeMetric,
  ScopeMetricStatus,
  ScopeVerdict,
  ScopeAssessmentConfig,
  MetricThreshold,
  FeatureDetection,
  NonGoals,
} from "./types.js";
import { DEFAULT_SCOPE_CONFIG } from "./types.js";

/**
 * Get status for a metric value based on thresholds
 *
 * @param value - Current metric value
 * @param threshold - Threshold configuration
 * @returns Metric status (green/yellow/red)
 */
export function getMetricStatus(
  value: number,
  threshold: MetricThreshold,
): ScopeMetricStatus {
  if (value >= threshold.red) {
    return "red";
  }
  if (value >= threshold.yellow) {
    return "yellow";
  }
  return "green";
}

/**
 * Create scope metrics from feature detection result
 *
 * @param detection - Feature detection result
 * @param acCount - Total AC items count
 * @param config - Scope assessment configuration
 * @returns Array of scope metrics with status
 */
export function createScopeMetrics(
  detection: FeatureDetection,
  acCount: number,
  config: ScopeAssessmentConfig = DEFAULT_SCOPE_CONFIG,
): ScopeMetric[] {
  const { thresholds } = config;

  return [
    {
      name: "Feature count",
      value: detection.featureCount,
      status: getMetricStatus(detection.featureCount, thresholds.featureCount),
    },
    {
      name: "AC items",
      value: acCount,
      status: getMetricStatus(acCount, thresholds.acItems),
    },
    {
      name: "Directory spread",
      value: detection.directorySpread,
      status: getMetricStatus(
        detection.directorySpread,
        thresholds.directorySpread,
      ),
    },
  ];
}

/**
 * Calculate overall verdict from metrics
 *
 * Logic:
 * - Any red metric → SCOPE_SPLIT_RECOMMENDED
 * - Any yellow metric → SCOPE_WARNING
 * - All green → SCOPE_OK
 *
 * @param metrics - Array of scope metrics
 * @param nonGoals - Non-goals parsing result
 * @returns Overall scope verdict
 */
export function calculateVerdict(
  metrics: ScopeMetric[],
  nonGoals: NonGoals,
): ScopeVerdict {
  const hasRed = metrics.some((m) => m.status === "red");
  const hasYellow = metrics.some((m) => m.status === "yellow");

  // Missing non-goals is a warning signal
  const nonGoalsWarning = !nonGoals.found || nonGoals.items.length === 0;

  if (hasRed) {
    return "SCOPE_SPLIT_RECOMMENDED";
  }

  if (hasYellow || nonGoalsWarning) {
    return "SCOPE_WARNING";
  }

  return "SCOPE_OK";
}

/**
 * Generate recommendation message based on verdict and metrics
 *
 * @param verdict - Calculated verdict
 * @param metrics - Scope metrics
 * @param detection - Feature detection result
 * @param nonGoals - Non-goals parsing result
 * @returns Recommendation message
 */
export function generateRecommendation(
  verdict: ScopeVerdict,
  metrics: ScopeMetric[],
  detection: FeatureDetection,
  nonGoals: NonGoals,
): string {
  const issues: string[] = [];

  // Check for feature bundling
  if (detection.featureCount > 1) {
    const clusters = detection.clusters
      .filter((c) => c.count >= 2)
      .map((c) => c.keyword)
      .join(", ");
    issues.push(
      `Multiple features detected (${detection.featureCount}): ${clusters || "mixed concerns"}`,
    );
  }

  // Check for multiple verbs in title
  if (detection.multipleVerbs) {
    issues.push(
      `Title contains multiple action verbs: ${detection.titleVerbs.join(", ")}`,
    );
  }

  // Check for high AC count
  const acMetric = metrics.find((m) => m.name === "AC items");
  if (acMetric && acMetric.status !== "green") {
    issues.push(`High AC count (${acMetric.value})`);
  }

  // Check for missing non-goals
  if (!nonGoals.found) {
    issues.push("Non-Goals section missing");
  } else if (nonGoals.items.length === 0) {
    issues.push("Non-Goals section is empty");
  }

  switch (verdict) {
    case "SCOPE_OK":
      return "Single focused feature with clear boundaries.";

    case "SCOPE_WARNING":
      return `Consider narrowing scope: ${issues.join("; ")}.`;

    case "SCOPE_SPLIT_RECOMMENDED":
      return `Strongly recommend splitting: ${issues.join("; ")}. Create separate issues for each distinct feature.`;
  }
}

/**
 * Get emoji indicator for verdict
 *
 * @param verdict - Scope verdict
 * @returns Emoji string
 */
export function getVerdictEmoji(verdict: ScopeVerdict): string {
  switch (verdict) {
    case "SCOPE_OK":
      return "✅";
    case "SCOPE_WARNING":
      return "⚠️";
    case "SCOPE_SPLIT_RECOMMENDED":
      return "❌";
  }
}

/**
 * Get emoji indicator for metric status
 *
 * @param status - Metric status
 * @returns Emoji string
 */
export function getStatusEmoji(status: ScopeMetricStatus): string {
  switch (status) {
    case "green":
      return "✅";
    case "yellow":
      return "⚠️";
    case "red":
      return "❌";
  }
}

/**
 * Check if quality loop should be auto-enabled based on verdict
 *
 * @param verdict - Scope verdict
 * @returns Whether to enable quality loop
 */
export function shouldEnableQualityLoop(verdict: ScopeVerdict): boolean {
  return verdict === "SCOPE_WARNING" || verdict === "SCOPE_SPLIT_RECOMMENDED";
}
