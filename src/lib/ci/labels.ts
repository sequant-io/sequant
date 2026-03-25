/**
 * Label lifecycle management for CI-triggered workflows.
 *
 * Manages the sequant:solving → sequant:done / sequant:failed label
 * transitions on GitHub issues during and after workflow execution.
 */

import { LIFECYCLE_LABELS, TRIGGER_LABELS } from "./types.js";

/**
 * All trigger labels that should be removed when a run starts.
 */
const TRIGGER_LABEL_SET: Set<string> = new Set(Object.values(TRIGGER_LABELS));

/**
 * Trigger label aliases — labels that trigger the same workflow.
 * When one is used, all aliases should also be removed to prevent
 * stale labels during migration (e.g. sequant:solve → sequant:assess).
 */
const TRIGGER_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  [TRIGGER_LABELS.ASSESS, [TRIGGER_LABELS.SOLVE]],
  [TRIGGER_LABELS.SOLVE, [TRIGGER_LABELS.ASSESS]],
]);

/**
 * Get labels to add when a workflow run starts.
 */
export function getStartLabels(): string[] {
  return [LIFECYCLE_LABELS.SOLVING];
}

/**
 * Get labels to remove when a workflow run starts.
 * Removes the trigger label that initiated the run.
 */
export function getStartRemoveLabels(triggerLabel?: string): string[] {
  const labels: string[] = [];

  // Remove the trigger label and any aliases (e.g. assess ↔ solve)
  if (triggerLabel && TRIGGER_LABEL_SET.has(triggerLabel)) {
    labels.push(triggerLabel);
    const aliases = TRIGGER_ALIASES.get(triggerLabel);
    if (aliases) {
      labels.push(...aliases);
    }
  }

  // Remove any stale outcome labels from prior runs
  labels.push(LIFECYCLE_LABELS.DONE, LIFECYCLE_LABELS.FAILED);

  return labels;
}

/**
 * Get labels to apply when a workflow completes successfully.
 */
export function getSuccessLabels(): { add: string[]; remove: string[] } {
  return {
    add: [LIFECYCLE_LABELS.DONE],
    remove: [LIFECYCLE_LABELS.SOLVING],
  };
}

/**
 * Get labels to apply when a workflow fails.
 */
export function getFailureLabels(): { add: string[]; remove: string[] } {
  return {
    add: [LIFECYCLE_LABELS.FAILED],
    remove: [LIFECYCLE_LABELS.SOLVING],
  };
}

/**
 * Generate gh CLI commands for label transitions.
 * Useful for composite action shell steps.
 */
export function labelCommands(
  issueNumber: number,
  transition: "start" | "success" | "failure",
  triggerLabel?: string,
): string[] {
  const commands: string[] = [];

  switch (transition) {
    case "start": {
      for (const label of getStartLabels()) {
        commands.push(`gh issue edit ${issueNumber} --add-label "${label}"`);
      }
      for (const label of getStartRemoveLabels(triggerLabel)) {
        commands.push(
          `gh issue edit ${issueNumber} --remove-label "${label}" 2>/dev/null || true`,
        );
      }
      break;
    }
    case "success": {
      const { add, remove } = getSuccessLabels();
      for (const label of add) {
        commands.push(`gh issue edit ${issueNumber} --add-label "${label}"`);
      }
      for (const label of remove) {
        commands.push(
          `gh issue edit ${issueNumber} --remove-label "${label}" 2>/dev/null || true`,
        );
      }
      break;
    }
    case "failure": {
      const { add, remove } = getFailureLabels();
      for (const label of add) {
        commands.push(`gh issue edit ${issueNumber} --add-label "${label}"`);
      }
      for (const label of remove) {
        commands.push(
          `gh issue edit ${issueNumber} --remove-label "${label}" 2>/dev/null || true`,
        );
      }
      break;
    }
  }

  return commands;
}
