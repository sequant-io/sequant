/**
 * Scope Assessment Types
 *
 * Types for the scope assessment system that evaluates issue scope
 * during the /spec phase to catch overscoped issues early.
 */

import { z } from "zod";

/**
 * Scope verdict - overall assessment result
 */
export type ScopeVerdict =
  | "SCOPE_OK"
  | "SCOPE_WARNING"
  | "SCOPE_SPLIT_RECOMMENDED";

/**
 * Scope metric status based on thresholds
 */
export type ScopeMetricStatus = "green" | "yellow" | "red";

/**
 * Threshold configuration for a single metric
 */
export interface MetricThreshold {
  /** Value at which status becomes yellow */
  yellow: number;
  /** Value at which status becomes red */
  red: number;
}

/**
 * Scope assessment configuration
 */
export interface ScopeAssessmentConfig {
  /** Whether scope assessment is enabled */
  enabled: boolean;
  /** Skip assessment for trivial issues */
  skipIfSimple: boolean;
  /** Trivial issue thresholds (skip if below all) */
  trivialThresholds: {
    /** Maximum AC items for trivial classification */
    maxACItems: number;
    /** Maximum directories touched for trivial classification */
    maxDirectories: number;
  };
  /** Thresholds for scope metrics */
  thresholds: {
    /** Feature count thresholds */
    featureCount: MetricThreshold;
    /** AC items thresholds */
    acItems: MetricThreshold;
    /** File estimate thresholds */
    fileEstimate: MetricThreshold;
    /** Directory spread thresholds */
    directorySpread: MetricThreshold;
  };
}

/**
 * Default scope assessment configuration
 */
export const DEFAULT_SCOPE_CONFIG: ScopeAssessmentConfig = {
  enabled: true,
  skipIfSimple: true,
  trivialThresholds: {
    maxACItems: 3,
    maxDirectories: 1,
  },
  thresholds: {
    featureCount: { yellow: 2, red: 3 },
    acItems: { yellow: 6, red: 9 },
    fileEstimate: { yellow: 8, red: 13 },
    directorySpread: { yellow: 3, red: 5 },
  },
};

/**
 * Individual scope metric
 */
export interface ScopeMetric {
  /** Name of the metric */
  name: string;
  /** Current value */
  value: number;
  /** Status based on thresholds */
  status: ScopeMetricStatus;
}

/**
 * Clustering result for AC items
 */
export interface ACCluster {
  /** Cluster identifier (keyword-based) */
  keyword: string;
  /** AC IDs in this cluster */
  acIds: string[];
  /** Number of AC items in cluster */
  count: number;
}

/**
 * Feature detection result
 */
export interface FeatureDetection {
  /** Number of distinct features detected */
  featureCount: number;
  /** AC clusters by functional area */
  clusters: ACCluster[];
  /** Multiple verbs detected in title */
  multipleVerbs: boolean;
  /** Detected verb list from title */
  titleVerbs: string[];
  /** Directory spread detected */
  directorySpread: number;
  /** Detected directories from analysis */
  directories: string[];
}

/**
 * Non-goals section data
 */
export interface NonGoals {
  /** List of non-goal items */
  items: string[];
  /** Whether non-goals section was found */
  found: boolean;
  /** Warning message if empty or missing */
  warning?: string;
}

/**
 * Complete scope assessment result
 */
export interface ScopeAssessment {
  /** Timestamp of assessment */
  assessedAt: string;
  /** Whether assessment was skipped (trivial issue) */
  skipped: boolean;
  /** Reason for skipping (if skipped) */
  skipReason?: string;
  /** Overall verdict */
  verdict: ScopeVerdict;
  /** Individual metrics */
  metrics: ScopeMetric[];
  /** Feature detection details */
  featureDetection: FeatureDetection;
  /** Non-goals section */
  nonGoals: NonGoals;
  /** Recommendation message */
  recommendation: string;
}

/**
 * Zod schema for scope assessment (for state storage)
 */
export const ScopeMetricSchema = z.object({
  name: z.string(),
  value: z.number(),
  status: z.enum(["green", "yellow", "red"]),
});

export const ACClusterSchema = z.object({
  keyword: z.string(),
  acIds: z.array(z.string()),
  count: z.number(),
});

export const FeatureDetectionSchema = z.object({
  featureCount: z.number(),
  clusters: z.array(ACClusterSchema),
  multipleVerbs: z.boolean(),
  titleVerbs: z.array(z.string()),
  directorySpread: z.number(),
  directories: z.array(z.string()),
});

export const NonGoalsSchema = z.object({
  items: z.array(z.string()),
  found: z.boolean(),
  warning: z.string().optional(),
});

export const ScopeAssessmentSchema = z.object({
  assessedAt: z.string().datetime(),
  skipped: z.boolean(),
  skipReason: z.string().optional(),
  verdict: z.enum(["SCOPE_OK", "SCOPE_WARNING", "SCOPE_SPLIT_RECOMMENDED"]),
  metrics: z.array(ScopeMetricSchema),
  featureDetection: FeatureDetectionSchema,
  nonGoals: NonGoalsSchema,
  recommendation: z.string(),
});

export type ScopeMetricType = z.infer<typeof ScopeMetricSchema>;
