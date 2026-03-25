/**
 * Solve Comment Parser — Backward Compatibility Re-exports
 *
 * @deprecated This module is deprecated. Use `assess-comment-parser` instead.
 * All exports are re-exported from the unified assess-comment-parser module.
 *
 * Migration:
 * ```typescript
 * // Before (deprecated):
 * import { findSolveComment, parseSolveWorkflow } from './solve-comment-parser';
 *
 * // After:
 * import { findAssessComment, parseAssessWorkflow } from './assess-comment-parser';
 * ```
 */

// Re-export everything from the unified assess-comment-parser
export {
  // New names (preferred)
  isAssessComment,
  findAssessComment,
  parseAssessMarkers,
  parseAssessWorkflow,
  assessWorkflowToSignals,
  assessCoversIssue,
  // Legacy names (deprecated but still functional)
  isSolveComment,
  findSolveComment,
  parseSolveMarkers,
  parseSolveWorkflow,
  solveWorkflowToSignals,
  solveCoversIssue,
} from "./assess-comment-parser.js";

// Re-export types
export type {
  AssessWorkflowResult,
  AssessMarkers,
  AssessAction,
  // Backward-compatible type aliases
  SolveWorkflowResult,
  SolveMarkers,
  IssueComment,
} from "./assess-comment-parser.js";
