/**
 * Deterministic rendering for `/assess` output (#823).
 *
 * `types.ts` owns the contract, `renderer.ts` owns the geometry. Neither touches
 * TTY state, ANSI, or I/O — see the header comment in `renderer.ts` for why that
 * rules out the `cli-ui.ts` helpers.
 */

export {
  AssessActionSchema,
  AssessChainSchema,
  AssessCleanupSchema,
  AssessCommandSchema,
  AssessFlagSchema,
  AssessIssueSchema,
  AssessResultSchema,
  AssessResultValidationError,
  AssessWarningSchema,
  parseAssessResult,
} from "./types.js";

export type {
  AssessAction,
  AssessChain,
  AssessCleanup,
  AssessCommand,
  AssessFlag,
  AssessIssue,
  AssessResult,
  AssessWarning,
} from "./types.js";

export { GEOMETRY, render, renderBatch, renderSingle } from "./renderer.js";
