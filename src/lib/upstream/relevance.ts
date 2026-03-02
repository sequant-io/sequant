/**
 * Relevance detection for upstream release changes
 * Matches changes against sequant's baseline to identify relevant items
 */

import type {
  Baseline,
  DetectionPatterns,
  Finding,
  FindingCategory,
  ImpactLevel,
} from "./types.js";

/**
 * Default detection patterns for categorizing changes
 */
export const DEFAULT_PATTERNS: DetectionPatterns = {
  newTool: /\b(added?|new|introduc(e|ing|ed))\b.*\btool\b/i,
  deprecation: /\b(deprecat(e|ed|ing|ion)|remov(e|ed|ing)|no longer support)/i,
  breaking: /\b(breaking|incompatible|must update|require(s|d) migration)/i,
  hook: /\b(hook|PreToolUse|PostToolUse|pre-tool|post-tool)\b/i,
  permission:
    /\b(permission|allow(ed)?|deny|denied|ask|consent|approve|reject)\b/i,
  mcp: /\b(MCP|model context protocol|mcp server)\b/i,
};

/**
 * Extract individual change items from release body
 * Handles various markdown formats
 */
export function extractChanges(releaseBody: string): string[] {
  const changes: string[] = [];
  const lines = releaseBody.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and headers
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Match bullet points (-, *, +)
    const bulletMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bulletMatch) {
      changes.push(bulletMatch[1].trim());
      continue;
    }

    // Match numbered items
    const numberedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (numberedMatch) {
      changes.push(numberedMatch[1].trim());
    }
  }

  return changes;
}

/**
 * Check if a change matches any keywords from baseline
 */
export function matchKeywords(change: string, keywords: string[]): string[] {
  const matched: string[] = [];

  for (const keyword of keywords) {
    // Create word boundary regex for keyword
    const pattern = new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i");
    if (pattern.test(change)) {
      matched.push(keyword);
    }
  }

  return matched;
}

/**
 * Check which detection patterns match a change
 */
export function matchPatterns(
  change: string,
  patterns: DetectionPatterns = DEFAULT_PATTERNS,
): string[] {
  const matched: string[] = [];

  for (const [name, pattern] of Object.entries(patterns)) {
    if (pattern.test(change)) {
      matched.push(name);
    }
  }

  return matched;
}

/**
 * Determine the category of a change based on matched patterns
 */
export function categorizeChange(matchedPatterns: string[]): FindingCategory {
  // Priority order: breaking > deprecation > new-tool > hook > opportunity > no-action
  if (matchedPatterns.includes("breaking")) {
    return "breaking";
  }
  if (matchedPatterns.includes("deprecation")) {
    return "deprecation";
  }
  if (matchedPatterns.includes("newTool")) {
    return "new-tool";
  }
  if (matchedPatterns.includes("hook")) {
    return "hook-change";
  }
  // If any keywords matched but no specific pattern, it's an opportunity
  if (matchedPatterns.length > 0) {
    return "opportunity";
  }
  return "no-action";
}

/**
 * Determine impact level based on category and matched keywords
 */
export function determineImpact(
  category: FindingCategory,
  matchedKeywords: string[],
): ImpactLevel {
  // Breaking changes are always high impact
  if (category === "breaking") {
    return "high";
  }

  // Deprecations are medium to high depending on what's affected
  if (category === "deprecation") {
    const criticalKeywords = [
      "hook",
      "PreToolUse",
      "PostToolUse",
      "permission",
    ];
    if (matchedKeywords.some((k) => criticalKeywords.includes(k))) {
      return "high";
    }
    return "medium";
  }

  // Hook changes can be significant
  if (category === "hook-change") {
    return "medium";
  }

  // New tools and opportunities are lower priority
  if (category === "new-tool" || category === "opportunity") {
    return "low";
  }

  return "none";
}

/**
 * Get affected sequant files from dependency map
 */
export function getImpactFiles(
  matchedKeywords: string[],
  dependencyMap: Record<string, string[]>,
): string[] {
  const files = new Set<string>();

  for (const keyword of matchedKeywords) {
    const mappedFiles = dependencyMap[keyword];
    if (mappedFiles) {
      for (const file of mappedFiles) {
        files.add(file);
      }
    }
  }

  return Array.from(files);
}

/**
 * Generate a title for a finding
 */
export function generateTitle(
  category: FindingCategory,
  change: string,
): string {
  // Truncate long changes
  const maxLength = 80;
  const title =
    change.length > maxLength ? change.slice(0, maxLength) + "..." : change;

  // Add prefix based on category
  switch (category) {
    case "breaking":
      return `BREAKING: ${title}`;
    case "deprecation":
      return `Deprecated: ${title}`;
    case "new-tool":
      return `New tool: ${title}`;
    case "hook-change":
      return `Hook change: ${title}`;
    case "opportunity":
      return title;
    default:
      return title;
  }
}

/**
 * Check if a change matches any out-of-scope patterns from the baseline.
 * Out-of-scope changes are skipped entirely during analysis.
 */
export function isOutOfScope(
  change: string,
  outOfScope: string[] = [],
): boolean {
  const changeLower = change.toLowerCase();
  return outOfScope.some((pattern) => {
    // Use the descriptive part before " - " as the match pattern
    const matchPart = pattern.split(" - ")[0].toLowerCase();
    return changeLower.includes(matchPart);
  });
}

/**
 * Analyze a single change against the baseline
 */
export function analyzeChange(change: string, baseline: Baseline): Finding {
  // Skip out-of-scope changes early
  if (isOutOfScope(change, baseline.outOfScope)) {
    return {
      category: "no-action",
      title: change,
      description: change,
      impact: "none",
      matchedKeywords: [],
      matchedPatterns: [],
      sequantFiles: [],
    };
  }

  // Match keywords and patterns
  const matchedKeywords = matchKeywords(change, baseline.keywords);
  const matchedPatterns = matchPatterns(change);

  // Combine for categorization (keywords count as pattern matches for opportunity detection)
  const allMatches = [
    ...matchedPatterns,
    ...(matchedKeywords.length > 0 ? ["keywords"] : []),
  ];

  // Categorize
  const category = categorizeChange(allMatches);

  // Determine impact
  const impact = determineImpact(category, matchedKeywords);

  // Get affected files
  const sequantFiles = getImpactFiles(matchedKeywords, baseline.dependencyMap);

  // Generate title
  const title = generateTitle(category, change);

  return {
    category,
    title,
    description: change,
    impact,
    matchedKeywords,
    matchedPatterns,
    sequantFiles,
  };
}

/**
 * Analyze all changes from a release
 */
export function analyzeRelease(
  releaseBody: string,
  baseline: Baseline,
): Finding[] {
  const changes = extractChanges(releaseBody);
  return changes.map((change) => analyzeChange(change, baseline));
}

/**
 * Filter findings to only actionable ones (not no-action)
 */
export function getActionableFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.category !== "no-action");
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
