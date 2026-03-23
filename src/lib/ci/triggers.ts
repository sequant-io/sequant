/**
 * Trigger detection — parses GitHub event payloads into structured
 * trigger results that determine which issues and phases to run.
 */

import type { Phase } from "../workflow/types.js";
import {
  COMMENT_TRIGGER_PATTERN,
  TRIGGER_LABELS,
  type GitHubContext,
  type TriggerResult,
} from "./types.js";

const VALID_PHASES = new Set<string>([
  "spec",
  "security-review",
  "testgen",
  "exec",
  "test",
  "qa",
  "loop",
]);

/**
 * Map trigger labels to their corresponding phase lists.
 */
const LABEL_PHASE_MAP: Record<string, Phase[]> = {
  [TRIGGER_LABELS.SOLVE]: ["spec", "exec", "qa"],
  [TRIGGER_LABELS.SPEC_ONLY]: ["spec"],
  [TRIGGER_LABELS.EXEC]: ["exec"],
  [TRIGGER_LABELS.QA]: ["qa"],
};

/**
 * Detect the trigger type and extract issue/phases from a GitHub event.
 */
export function detectTrigger(context: GitHubContext): TriggerResult {
  switch (context.eventName) {
    case "workflow_dispatch":
      return {
        trigger: "workflow_dispatch",
        phases: ["spec", "exec", "qa"],
        issue: null,
      };

    case "issues":
      return detectLabelTrigger(context);

    case "issue_comment":
      return detectCommentTrigger(context);

    default:
      return { trigger: "unknown", phases: [], issue: null };
  }
}

/**
 * Detect label-based trigger from an issues event.
 */
function detectLabelTrigger(context: GitHubContext): TriggerResult {
  const { payload } = context;

  if (payload.action !== "labeled" || !payload.label) {
    return { trigger: "unknown", phases: [], issue: null };
  }

  const labelName = payload.label.name;
  const phases = LABEL_PHASE_MAP[labelName];

  if (!phases) {
    return { trigger: "unknown", phases: [], issue: null };
  }

  return {
    trigger: "label",
    phases,
    issue: payload.issue?.number ?? null,
    label: labelName,
  };
}

/**
 * Detect @sequant command trigger from an issue comment.
 */
function detectCommentTrigger(context: GitHubContext): TriggerResult {
  const { payload } = context;

  if (payload.action !== "created" || !payload.comment?.body) {
    return { trigger: "unknown", phases: [], issue: null };
  }

  const match = payload.comment.body.match(COMMENT_TRIGGER_PATTERN);
  if (!match) {
    return { trigger: "unknown", phases: [], issue: null };
  }

  const rawPhases = match[1].split(",").map((p) => p.trim());
  const phases = rawPhases.filter((p): p is Phase => VALID_PHASES.has(p));

  if (phases.length === 0) {
    return { trigger: "unknown", phases: [], issue: null };
  }

  return {
    trigger: "comment",
    phases,
    issue: payload.issue?.number ?? null,
  };
}
