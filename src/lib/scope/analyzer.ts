/**
 * Scope Analyzer
 *
 * Detects bundled features and analyzes issue scope using heuristics:
 * - AC clustering by functional area
 * - Title verb detection (multiple verbs = multiple features)
 * - Directory spread analysis
 *
 * @example
 * ```typescript
 * import { detectFeatures, analyzeScope } from './analyzer';
 *
 * const criteria = parseAcceptanceCriteria(issueBody);
 * const detection = detectFeatures(criteria, issueTitle);
 * console.log(`Feature count: ${detection.featureCount}`);
 * ```
 */

import type { AcceptanceCriterion } from "../workflow/state-schema.js";
import type {
  ACCluster,
  FeatureDetection,
  NonGoals,
  ScopeAssessmentConfig,
} from "./types.js";
import { DEFAULT_SCOPE_CONFIG } from "./types.js";

/**
 * Keywords for clustering AC items by functional area
 */
const CLUSTER_KEYWORDS: Record<string, string[]> = {
  auth: [
    "auth",
    "login",
    "logout",
    "session",
    "password",
    "token",
    "jwt",
    "oauth",
    "sso",
  ],
  ui: [
    "display",
    "show",
    "render",
    "button",
    "form",
    "modal",
    "page",
    "component",
    "ui",
    "dashboard",
  ],
  api: [
    "api",
    "endpoint",
    "route",
    "request",
    "response",
    "http",
    "rest",
    "graphql",
  ],
  data: [
    "database",
    "db",
    "query",
    "store",
    "save",
    "persist",
    "cache",
    "storage",
  ],
  perf: [
    "performance",
    "optimize",
    "speed",
    "fast",
    "slow",
    "latency",
    "throughput",
  ],
  config: ["config", "setting", "option", "preference", "environment", "env"],
  test: ["test", "spec", "coverage", "mock", "stub", "fixture"],
  docs: ["document", "readme", "guide", "tutorial", "example"],
  error: ["error", "exception", "fail", "handle", "catch", "throw"],
  validation: ["valid", "invalid", "check", "verify", "sanitize"],
};

/**
 * Action verbs that indicate distinct features when multiple are present
 */
const ACTION_VERBS = [
  "add",
  "create",
  "implement",
  "build",
  "fix",
  "update",
  "refactor",
  "remove",
  "delete",
  "improve",
  "optimize",
  "migrate",
  "convert",
  "integrate",
  "enable",
  "disable",
];

/**
 * Cluster AC items by functional area based on keywords
 *
 * @param criteria - Parsed acceptance criteria
 * @returns Array of AC clusters
 */
export function clusterACByKeyword(
  criteria: AcceptanceCriterion[],
): ACCluster[] {
  const clusters: Map<string, string[]> = new Map();
  const unclassified: string[] = [];

  for (const ac of criteria) {
    const descLower = ac.description.toLowerCase();
    let matched = false;

    for (const [keyword, patterns] of Object.entries(CLUSTER_KEYWORDS)) {
      if (patterns.some((p) => descLower.includes(p))) {
        const existing = clusters.get(keyword) ?? [];
        existing.push(ac.id);
        clusters.set(keyword, existing);
        matched = true;
        break; // Only assign to first matching cluster
      }
    }

    if (!matched) {
      unclassified.push(ac.id);
    }
  }

  // Add unclassified as a separate cluster if not empty
  if (unclassified.length > 0) {
    clusters.set("other", unclassified);
  }

  // Convert to array format
  return Array.from(clusters.entries()).map(([keyword, acIds]) => ({
    keyword,
    acIds,
    count: acIds.length,
  }));
}

/**
 * Detect action verbs in issue title
 *
 * @param title - Issue title
 * @returns Array of detected verbs
 */
export function detectTitleVerbs(title: string): string[] {
  const titleLower = title.toLowerCase();
  const detected: string[] = [];

  for (const verb of ACTION_VERBS) {
    // Match word boundaries to avoid partial matches
    const regex = new RegExp(`\\b${verb}\\b`, "i");
    if (regex.test(titleLower)) {
      detected.push(verb);
    }
  }

  return detected;
}

/**
 * Estimate directory spread from AC descriptions
 *
 * Looks for patterns that suggest different areas of the codebase:
 * - File path mentions (src/, lib/, components/)
 * - Module references
 * - Component type mentions
 *
 * @param criteria - Parsed acceptance criteria
 * @returns Estimated number of distinct directories
 */
export function estimateDirectorySpread(criteria: AcceptanceCriterion[]): {
  spread: number;
  directories: string[];
} {
  const directories = new Set<string>();

  // Common directory patterns
  const dirPatterns = [
    /\b(src|lib|utils|helpers)\b/i,
    /\b(components|pages|views|layouts)\b/i,
    /\b(api|routes|handlers|controllers)\b/i,
    /\b(models|schemas|types|interfaces)\b/i,
    /\b(tests?|__tests__|specs?)\b/i,
    /\b(scripts|bin|cli)\b/i,
    /\b(config|settings)\b/i,
    /\b(docs|documentation)\b/i,
    /\b(styles|css|scss)\b/i,
    /\b(hooks|contexts?|providers?)\b/i,
    /\b(services|queries|mutations)\b/i,
    /\b(middleware|plugins?)\b/i,
  ];

  for (const ac of criteria) {
    const desc = ac.description;
    for (const pattern of dirPatterns) {
      const match = desc.match(pattern);
      if (match) {
        directories.add(match[1].toLowerCase());
      }
    }
  }

  return {
    spread: directories.size,
    directories: Array.from(directories),
  };
}

/**
 * Calculate feature count based on multiple signals
 *
 * Algorithm:
 * 1. Count distinct AC clusters (if >1, suggests multiple features)
 * 2. Count action verbs in title (multiple verbs = multiple features)
 * 3. Consider directory spread (wide spread suggests complexity)
 *
 * @param clusters - AC clusters from keyword analysis
 * @param titleVerbs - Detected verbs from title
 * @param directorySpread - Number of directories touched
 * @returns Estimated feature count
 */
export function calculateFeatureCount(
  clusters: ACCluster[],
  titleVerbs: string[],
  directorySpread: number,
): number {
  // Base: number of distinct clusters with >1 AC items
  const significantClusters = clusters.filter((c) => c.count >= 2).length;

  // Additional signal: multiple verbs in title
  const verbSignal = Math.max(0, titleVerbs.length - 1);

  // Directory spread signal (normalized)
  const dirSignal = directorySpread >= 4 ? 1 : 0;

  // Combine signals with weights
  // Clusters are primary signal, title and directories are secondary
  const rawCount = significantClusters + verbSignal * 0.5 + dirSignal * 0.5;

  // Minimum is 1 feature, round to nearest integer
  return Math.max(1, Math.round(rawCount));
}

/**
 * Detect features in issue based on AC items and title
 *
 * @param criteria - Parsed acceptance criteria
 * @param title - Issue title
 * @returns Feature detection result
 */
export function detectFeatures(
  criteria: AcceptanceCriterion[],
  title: string,
): FeatureDetection {
  const clusters = clusterACByKeyword(criteria);
  const titleVerbs = detectTitleVerbs(title);
  const { spread, directories } = estimateDirectorySpread(criteria);

  const featureCount = calculateFeatureCount(clusters, titleVerbs, spread);

  return {
    featureCount,
    clusters,
    multipleVerbs: titleVerbs.length > 1,
    titleVerbs,
    directorySpread: spread,
    directories,
  };
}

/**
 * Parse non-goals section from issue body
 *
 * Looks for a "Non-Goals" or "Out of Scope" section with checkbox items.
 *
 * @param issueBody - Full issue body markdown
 * @returns Non-goals extraction result
 */
export function parseNonGoals(issueBody: string): NonGoals {
  const items: string[] = [];

  // Find Non-Goals section (case-insensitive)
  const sectionPattern =
    /##\s*(?:Non[- ]?Goals|Out\s+of\s+Scope|Scope\s+Boundaries)\s*\n([\s\S]*?)(?=\n##|\n---|$)/i;
  const sectionMatch = issueBody.match(sectionPattern);

  if (!sectionMatch) {
    return {
      items: [],
      found: false,
      warning: "Non-Goals section not found. Consider adding scope boundaries.",
    };
  }

  const sectionContent = sectionMatch[1];

  // Extract checkbox items or list items
  const itemPattern = /^[-*]\s*(?:\[[ x]\]\s*)?(.+)$/gim;
  let match;

  while ((match = itemPattern.exec(sectionContent)) !== null) {
    const item = match[1].trim();
    if (item && !item.startsWith("#")) {
      items.push(item);
    }
  }

  if (items.length === 0) {
    return {
      items: [],
      found: true,
      warning: "Non-Goals section is empty. Add explicit scope boundaries.",
    };
  }

  return {
    items,
    found: true,
  };
}

/**
 * Check if an issue should skip scope assessment (trivial issue)
 *
 * @param acCount - Number of acceptance criteria
 * @param directorySpread - Estimated directory spread
 * @param config - Scope assessment configuration
 * @returns Whether to skip assessment
 */
export function shouldSkipAssessment(
  acCount: number,
  directorySpread: number,
  config: ScopeAssessmentConfig = DEFAULT_SCOPE_CONFIG,
): { skip: boolean; reason?: string } {
  if (!config.enabled) {
    return { skip: true, reason: "Scope assessment disabled in config" };
  }

  if (!config.skipIfSimple) {
    return { skip: false };
  }

  const { maxACItems, maxDirectories } = config.trivialThresholds;

  if (acCount <= maxACItems && directorySpread <= maxDirectories) {
    return {
      skip: true,
      reason: `Trivial issue (${acCount} AC items, ${directorySpread} directories)`,
    };
  }

  return { skip: false };
}
