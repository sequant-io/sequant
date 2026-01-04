/**
 * Sequant - Quantize your development workflow
 *
 * Sequential AI phases with quality gates for any codebase.
 */

export { initCommand } from "./commands/init.js";
export { updateCommand } from "./commands/update.js";
export { doctorCommand } from "./commands/doctor.js";
export { statusCommand } from "./commands/status.js";

export { detectStack, getStackConfig, STACKS } from "./lib/stacks.js";
export { getManifest, createManifest, updateManifest } from "./lib/manifest.js";
export {
  copyTemplates,
  listTemplateFiles,
  getTemplateContent,
} from "./lib/templates.js";

export type { StackConfig } from "./lib/stacks.js";
export type { Manifest } from "./lib/manifest.js";
