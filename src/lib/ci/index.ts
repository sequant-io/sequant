/**
 * CI integration module — provides everything needed to run sequant
 * workflows from GitHub Actions or other CI/CD systems.
 */

export { loadCIConfig, resolveConfig } from "./config.js";
export { parseInputs, validateInputs } from "./inputs.js";
export type { RawActionInputs } from "./inputs.js";
export {
  getFailureLabels,
  getStartLabels,
  getStartRemoveLabels,
  getSuccessLabels,
  labelCommands,
} from "./labels.js";
export {
  formatMultiOutputs,
  formatOutputs,
  formatSummary,
  outputCommands,
} from "./outputs.js";
export { detectTrigger } from "./triggers.js";
export {
  CI_DEFAULTS,
  COMMENT_TRIGGER_PATTERN,
  LIFECYCLE_LABELS,
  TRIGGER_LABELS,
} from "./types.js";
export type {
  ActionInputs,
  ActionOutputs,
  CIConfig,
  GitHubContext,
  GitHubEventPayload,
  TriggerResult,
  TriggerType,
} from "./types.js";
