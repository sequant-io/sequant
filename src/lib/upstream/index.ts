/**
 * Upstream Assessment Module
 *
 * Monitors Claude Code releases and assesses compatibility with sequant.
 * Auto-creates GitHub issues for feature opportunities and breaking changes.
 */

// Main exports
export {
  runUpstream,
  assessVersion,
  assessLatest,
  assessSince,
  fetchRelease,
  listReleases,
  getReleasesSince,
  loadBaseline,
  saveBaseline,
  updateBaseline,
  isAlreadyAssessed,
  saveLocalReport,
  validateVersion,
  checkGhCliAvailable,
} from "./assessment.js";

// Relevance detection
export {
  extractChanges,
  matchKeywords,
  matchPatterns,
  categorizeChange,
  determineImpact,
  getImpactFiles,
  generateTitle,
  analyzeChange,
  analyzeRelease,
  getActionableFindings,
  DEFAULT_PATTERNS,
} from "./relevance.js";

// Report generation
export {
  calculateSummary,
  generateAssessmentReport,
  generateFindingIssue,
  generateBatchedSummaryReport,
  generateLocalReport,
} from "./report.js";

// Issue management
export {
  checkForDuplicate,
  createIssue,
  addIssueComment,
  createOrLinkFinding,
  createAssessmentIssue,
  extractSearchTerms,
  isSimilarTitle,
} from "./issues.js";

// Types
export type {
  FindingCategory,
  ImpactLevel,
  Finding,
  AssessmentSummary,
  UpstreamAssessment,
  ReleaseData,
  ToolsConfig,
  HooksConfig,
  McpServersConfig,
  PermissionsConfig,
  Baseline,
  DetectionPatterns,
  AssessmentOptions,
  DuplicateCheckResult,
  IssueParams,
  IssueResult,
  BatchedAssessment,
} from "./types.js";
