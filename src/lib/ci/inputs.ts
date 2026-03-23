/**
 * Input parsing and validation for the GitHub Action.
 *
 * Parses raw string inputs from action.yml into validated ActionInputs,
 * applying defaults and merging with repo-level configuration.
 */

import type { Phase } from "../workflow/types.js";
import type { ActionInputs, CIConfig } from "./types.js";
import { CI_DEFAULTS } from "./types.js";

const VALID_PHASES = new Set<string>([
  "spec",
  "security-review",
  "testgen",
  "exec",
  "test",
  "qa",
  "loop",
]);

const VALID_AGENTS = new Set(["claude-code", "aider", "codex"]);

/**
 * Raw inputs as received from GitHub Actions (all strings).
 */
export interface RawActionInputs {
  issues?: string;
  phases?: string;
  agent?: string;
  timeout?: string;
  "quality-loop"?: string;
  "api-key"?: string;
}

/**
 * Parse and validate action inputs, merging with repo config.
 *
 * Merge precedence: workflow inputs > config file > action defaults
 */
export function parseInputs(
  raw: RawActionInputs,
  config: CIConfig = {},
): ActionInputs {
  const issues = parseIssueNumbers(raw.issues ?? "");
  const phases = parsePhases(raw.phases, config.phases ?? CI_DEFAULTS.phases);
  const agent = parseAgent(raw.agent, config.agent ?? CI_DEFAULTS.agent);
  const timeout = parseTimeout(
    raw.timeout,
    config.timeout ?? CI_DEFAULTS.timeout,
  );
  const qualityLoop = parseBool(
    raw["quality-loop"],
    config.qualityLoop ?? CI_DEFAULTS.qualityLoop,
  );
  const apiKey = raw["api-key"] ?? "";

  return { issues, phases, agent, timeout, qualityLoop, apiKey };
}

/**
 * Validate that required inputs are present and well-formed.
 * Returns an array of error messages (empty = valid).
 */
export function validateInputs(inputs: ActionInputs): string[] {
  const errors: string[] = [];

  if (inputs.issues.length === 0) {
    errors.push("No valid issue numbers provided");
  }

  if (inputs.phases.length === 0) {
    errors.push("No valid phases provided");
  }

  if (!inputs.apiKey) {
    errors.push(
      "API key is required — pass via api-key input mapped from a secret",
    );
  }

  if (inputs.timeout < 60) {
    errors.push("Timeout must be at least 60 seconds");
  }

  if (inputs.timeout > 7200) {
    errors.push("Timeout must not exceed 7200 seconds (2 hours)");
  }

  return errors;
}

/**
 * Parse space-separated issue numbers.
 */
function parseIssueNumbers(input: string): number[] {
  if (!input.trim()) return [];

  return input
    .split(/[\s,]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
}

/**
 * Parse comma-separated phase names, falling back to default.
 */
function parsePhases(input: string | undefined, fallback: Phase[]): Phase[] {
  if (!input?.trim()) return fallback;

  const parsed = input
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is Phase => VALID_PHASES.has(p));

  return parsed.length > 0 ? parsed : fallback;
}

/**
 * Parse agent name with validation.
 */
function parseAgent(input: string | undefined, fallback: string): string {
  if (!input?.trim()) return fallback;
  const agent = input.trim();
  return VALID_AGENTS.has(agent) ? agent : fallback;
}

/**
 * Parse timeout string to number with bounds check.
 */
function parseTimeout(input: string | undefined, fallback: number): number {
  if (!input?.trim()) return fallback;
  const n = parseInt(input.trim(), 10);
  return isNaN(n) ? fallback : n;
}

/**
 * Parse boolean string.
 */
function parseBool(input: string | undefined, fallback: boolean): boolean {
  if (!input?.trim()) return fallback;
  return input.trim().toLowerCase() === "true";
}
