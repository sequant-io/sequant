/**
 * Types for the upstream assessment module
 * Tracks Claude Code releases and compatibility with sequant
 */

/**
 * Categories for classifying changes from upstream releases
 */
export type FindingCategory =
  | "breaking"
  | "deprecation"
  | "new-tool"
  | "hook-change"
  | "opportunity"
  | "no-action";

/**
 * Impact level for a finding
 */
export type ImpactLevel = "high" | "medium" | "low" | "none";

/**
 * A single finding from release analysis
 */
export interface Finding {
  /** Category of the change */
  category: FindingCategory;
  /** Brief title describing the change */
  title: string;
  /** Full description from release notes */
  description: string;
  /** Impact level on sequant */
  impact: ImpactLevel;
  /** Keywords that triggered detection */
  matchedKeywords: string[];
  /** Regex patterns that matched */
  matchedPatterns: string[];
  /** Affected sequant files from dependency map */
  sequantFiles: string[];
  /** GitHub issue number if created */
  issueNumber?: number;
  /** Existing issue number if duplicate found */
  existingIssue?: number;
}

/**
 * Summary counts for an assessment
 */
export interface AssessmentSummary {
  breakingChanges: number;
  deprecations: number;
  newTools: number;
  hookChanges: number;
  opportunities: number;
  noAction: number;
}

/**
 * Complete assessment result for a release
 */
export interface UpstreamAssessment {
  /** Version tag (e.g., "v2.1.29") */
  version: string;
  /** Release date from GitHub */
  releaseDate: string;
  /** Date when assessment was performed */
  assessmentDate: string;
  /** Previous version (for --since support) */
  previousVersion: string | null;
  /** All findings from the assessment */
  findings: Finding[];
  /** Issue numbers created during assessment */
  issuesCreated: number[];
  /** Summary counts by category */
  summary: AssessmentSummary;
  /** Whether this was a dry run */
  dryRun: boolean;
}

/**
 * Release data from GitHub API
 */
export interface ReleaseData {
  /** Version tag name (e.g., "v2.1.29") */
  tagName: string;
  /** Release title */
  name: string;
  /** Release body/changelog content */
  body: string;
  /** Publication date */
  publishedAt: string;
}

/**
 * Tools configuration in baseline
 */
export interface ToolsConfig {
  /** Core tools sequant relies on */
  core: string[];
  /** Optional tools that enhance functionality */
  optional: string[];
}

/**
 * Hooks configuration in baseline
 */
export interface HooksConfig {
  /** Hook types sequant uses */
  used: string[];
  /** Files that implement hooks */
  files: string[];
}

/**
 * MCP servers configuration in baseline
 */
export interface McpServersConfig {
  /** Required MCP servers */
  required: string[];
  /** Optional MCP servers */
  optional: string[];
}

/**
 * Permissions configuration in baseline
 */
export interface PermissionsConfig {
  /** Permission patterns used */
  patterns: string[];
  /** Files containing permission configs */
  files: string[];
}

/**
 * Baseline configuration for sequant capabilities
 */
export interface Baseline {
  /** Last assessed version (null if never assessed) */
  lastAssessedVersion: string | null;
  /** Schema version for migration support */
  schemaVersion: string;
  /** Tools configuration */
  tools: ToolsConfig;
  /** Hooks configuration */
  hooks: HooksConfig;
  /** MCP servers configuration */
  mcpServers: McpServersConfig;
  /** Permissions configuration */
  permissions: PermissionsConfig;
  /** Keywords to match in release notes */
  keywords: string[];
  /** Map of keywords to affected sequant files */
  dependencyMap: Record<string, string[]>;
}

/**
 * Regex patterns for detecting change types
 */
export interface DetectionPatterns {
  newTool: RegExp;
  deprecation: RegExp;
  breaking: RegExp;
  hook: RegExp;
  permission: RegExp;
  mcp: RegExp;
}

/**
 * Options for running an upstream assessment
 */
export interface AssessmentOptions {
  /** Specific version to assess (default: latest) */
  version?: string;
  /** Assess all versions since this version */
  since?: string;
  /** Skip issue creation */
  dryRun?: boolean;
  /** Force re-assessment even if already done */
  force?: boolean;
}

/**
 * Result of checking for duplicate issues
 */
export interface DuplicateCheckResult {
  /** Whether a duplicate was found */
  isDuplicate: boolean;
  /** Existing issue number if duplicate */
  existingIssue?: number;
  /** Existing issue title if duplicate */
  existingTitle?: string;
}

/**
 * GitHub issue creation parameters
 */
export interface IssueParams {
  /** Issue title */
  title: string;
  /** Issue body in markdown */
  body: string;
  /** Labels to apply */
  labels: string[];
}

/**
 * Result of creating an issue
 */
export interface IssueResult {
  /** Created issue number */
  number: number;
  /** Issue URL */
  url: string;
}

/**
 * Batched assessment for multiple versions
 */
export interface BatchedAssessment {
  /** All versions assessed */
  versions: string[];
  /** Individual assessments */
  assessments: UpstreamAssessment[];
  /** Summary issue number */
  summaryIssueNumber?: number;
  /** Start version (from --since) */
  sinceVersion: string;
  /** End version (latest assessed) */
  toVersion: string;
}
