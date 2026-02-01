/**
 * Sequant - Quantize your development workflow
 *
 * Sequential AI phases with quality gates for any codebase.
 */

export { initCommand } from "./commands/init.js";
export { updateCommand } from "./commands/update.js";
export { doctorCommand } from "./commands/doctor.js";
export { statusCommand } from "./commands/status.js";
export type { StatusCommandOptions } from "./commands/status.js";

export { detectStack, getStackConfig, STACKS } from "./lib/stacks.js";
export { getManifest, createManifest, updateManifest } from "./lib/manifest.js";
export { getConfig, saveConfig } from "./lib/config.js";
export {
  copyTemplates,
  listTemplateFiles,
  getTemplateContent,
  processTemplate,
} from "./lib/templates.js";

export type { StackConfig } from "./lib/stacks.js";
export type { Manifest } from "./lib/manifest.js";
export type { SequantConfig } from "./lib/config.js";

// Workflow state exports
export { StateManager, getStateManager } from "./lib/workflow/state-manager.js";
export type { StateManagerOptions } from "./lib/workflow/state-manager.js";
export {
  createEmptyState,
  createIssueState,
  createPhaseState,
  STATE_FILE_PATH,
  WORKFLOW_PHASES,
} from "./lib/workflow/state-schema.js";
export type {
  WorkflowState,
  IssueState,
  PhaseState,
  Phase,
  PhaseStatus,
  IssueStatus,
  PRInfo,
  LoopState,
} from "./lib/workflow/state-schema.js";
export {
  createStateHook,
  isOrchestrated,
  getOrchestrationContext,
} from "./lib/workflow/state-hook.js";
export type { StateHook, StateHookOptions } from "./lib/workflow/state-hook.js";
export {
  rebuildStateFromLogs,
  cleanupStaleEntries,
} from "./lib/workflow/state-utils.js";
export type {
  RebuildOptions,
  RebuildResult,
  CleanupOptions,
  CleanupResult,
} from "./lib/workflow/state-utils.js";

// Content analysis exports
export {
  analyzeTitleForPhases,
  analyzeBodyForPhases,
  analyzeContentForPhases,
  isTrivialWork,
  formatContentAnalysis,
} from "./lib/content-analyzer.js";
export type {
  ContentSignal,
  ContentAnalysisResult,
} from "./lib/content-analyzer.js";

export {
  mergePhaseSignals,
  signalFromLabel,
  signalsFromLabels,
  formatMergedPhases,
  SIGNAL_PRIORITY,
} from "./lib/phase-signal.js";
export type {
  SignalSource,
  SignalConfidence,
  PhaseSignal,
  MergedPhaseResult,
} from "./lib/phase-signal.js";

export {
  isSolveComment,
  findSolveComment,
  parseSolveWorkflow,
  solveWorkflowToSignals,
  solveCoversIssue,
} from "./lib/solve-comment-parser.js";
export type {
  SolveWorkflowResult,
  IssueComment,
} from "./lib/solve-comment-parser.js";
