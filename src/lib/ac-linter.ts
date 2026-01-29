/**
 * Acceptance Criteria Linter
 *
 * Static analysis of acceptance criteria to flag vague, untestable,
 * or incomplete requirements before implementation begins.
 *
 * @example
 * ```typescript
 * import { lintAcceptanceCriteria } from './ac-linter';
 * import { parseAcceptanceCriteria } from './ac-parser';
 *
 * const criteria = parseAcceptanceCriteria(issueBody);
 * const lintResults = lintAcceptanceCriteria(criteria);
 *
 * console.log(formatACLintResults(lintResults));
 * ```
 */

import type { AcceptanceCriterion } from "./workflow/state-schema.js";

/**
 * Types of issues that can be flagged in AC
 */
export type ACLintIssueType =
  | "vague"
  | "unmeasurable"
  | "incomplete"
  | "open_ended";

/**
 * A lint issue found in an acceptance criterion
 */
export interface ACLintIssue {
  /** Type of issue detected */
  type: ACLintIssueType;
  /** The matched pattern that triggered this issue */
  matchedPattern: string;
  /** Human-readable description of the problem */
  problem: string;
  /** Suggested improvement */
  suggestion: string;
}

/**
 * Lint result for a single acceptance criterion
 */
export interface ACLintResult {
  /** The AC being linted */
  ac: AcceptanceCriterion;
  /** Issues found (empty if AC is clear) */
  issues: ACLintIssue[];
  /** Whether this AC passed linting (no issues) */
  passed: boolean;
}

/**
 * Overall lint results for all acceptance criteria
 */
export interface ACLintResults {
  /** Results for each AC */
  results: ACLintResult[];
  /** Summary counts */
  summary: {
    total: number;
    passed: number;
    flagged: number;
  };
  /** Whether any issues were found */
  hasIssues: boolean;
}

/**
 * Pattern definition for detecting issues
 */
interface LintPattern {
  /** Regular expression to match (case-insensitive) */
  regex: RegExp;
  /** Type of issue this pattern indicates */
  type: ACLintIssueType;
  /** Problem description */
  problem: string;
  /** Suggested fix */
  suggestion: string;
}

/**
 * Default lint patterns organized by issue type
 *
 * Patterns are checked in order, with longer/more specific patterns first
 */
const DEFAULT_LINT_PATTERNS: LintPattern[] = [
  // Vague patterns
  {
    regex: /\bshould work\b/i,
    type: "vague",
    problem: 'Vague: "should work" is not specific',
    suggestion: "Specify the expected behavior and success criteria",
  },
  {
    regex: /\bwork(?:s|ing)? (?:properly|correctly|well|nicely)\b/i,
    type: "vague",
    problem: "Vague: adverb does not define expected behavior",
    suggestion: "Define specific, measurable outcomes",
  },
  {
    regex: /\bproperly\b/i,
    type: "vague",
    problem: 'Vague: "properly" is subjective',
    suggestion: "Specify what correct behavior looks like",
  },
  {
    regex: /\bcorrectly\b/i,
    type: "vague",
    problem: 'Vague: "correctly" is subjective',
    suggestion: "Define the expected output or behavior",
  },
  {
    regex: /\bnicely\b/i,
    type: "vague",
    problem: 'Vague: "nicely" is subjective',
    suggestion: "Specify concrete UX requirements",
  },
  {
    regex: /\bgood\b(?!\s+(?:practice|pattern|reason))/i,
    type: "vague",
    problem: 'Vague: "good" is subjective without context',
    suggestion: "Define measurable quality criteria",
  },
  {
    regex: /\bas expected\b/i,
    type: "vague",
    problem: 'Vague: "as expected" requires explicit expectations',
    suggestion: "Define what the expected behavior is",
  },
  {
    regex: /\bshould be fine\b/i,
    type: "vague",
    problem: 'Vague: "should be fine" is not a testable criterion',
    suggestion: "Specify the acceptance threshold",
  },

  // Unmeasurable patterns (performance-related)
  {
    regex: /\bfast(?:er)?\b(?!\s+forward)/i,
    type: "unmeasurable",
    problem: 'Unmeasurable: "fast" has no threshold',
    suggestion: "Add latency threshold (e.g., <2 seconds, <100ms)",
  },
  {
    regex: /\bslow(?:er)?\b/i,
    type: "unmeasurable",
    problem: 'Unmeasurable: "slow" has no threshold',
    suggestion: "Define specific timing or threshold",
  },
  {
    regex: /\bperformant\b/i,
    type: "unmeasurable",
    problem: 'Unmeasurable: "performant" has no threshold',
    suggestion: "Add specific performance metrics (latency, throughput)",
  },
  {
    regex: /\befficient(?:ly)?\b/i,
    type: "unmeasurable",
    problem: 'Unmeasurable: "efficient" has no threshold',
    suggestion: "Define resource usage limits or benchmarks",
  },
  {
    regex: /\bresponsive\b/i,
    type: "unmeasurable",
    problem: 'Unmeasurable: "responsive" has no threshold',
    suggestion: "Add response time target (e.g., <100ms interaction, <3s load)",
  },
  {
    regex: /\bquick(?:ly)?\b/i,
    type: "unmeasurable",
    problem: 'Unmeasurable: "quickly" has no threshold',
    suggestion: "Specify time limit (e.g., completes in <5 seconds)",
  },
  {
    regex: /\bscalable\b/i,
    type: "unmeasurable",
    problem: 'Unmeasurable: "scalable" needs concrete bounds',
    suggestion: "Define load targets (e.g., handles 1000 concurrent users)",
  },

  // Incomplete patterns (error handling, edge cases)
  {
    regex: /\bhandle(?:s)? errors?\b/i,
    type: "incomplete",
    problem: "Incomplete: error types not specified",
    suggestion:
      "List specific error types and expected responses (e.g., 400 for invalid input, 503 for service unavailable)",
  },
  {
    regex: /\berror handling\b/i,
    type: "incomplete",
    problem: "Incomplete: error scenarios not specified",
    suggestion: "Enumerate error conditions and recovery behaviors",
  },
  {
    regex: /\bedge cases?\b/i,
    type: "incomplete",
    problem: "Incomplete: edge cases not enumerated",
    suggestion: "List the specific edge cases to handle",
  },
  {
    regex: /\bcorner cases?\b/i,
    type: "incomplete",
    problem: "Incomplete: corner cases not enumerated",
    suggestion: "List the specific corner cases to handle",
  },
  {
    regex: /\ball (?:cases|scenarios|situations)\b/i,
    type: "incomplete",
    problem: 'Incomplete: "all" cases cannot be verified',
    suggestion: "Enumerate the specific cases to test",
  },
  {
    regex: /\bappropriate(?:ly)?\b/i,
    type: "incomplete",
    problem: 'Incomplete: "appropriate" behavior not defined',
    suggestion: "Specify what the appropriate response is",
  },

  // Open-ended patterns
  {
    regex: /\betc\.?\b/i,
    type: "open_ended",
    problem: 'Open-ended: "etc." leaves scope undefined',
    suggestion: "Enumerate all items explicitly",
  },
  {
    regex: /\band more\b/i,
    type: "open_ended",
    problem: 'Open-ended: "and more" leaves scope undefined',
    suggestion: "List all items explicitly",
  },
  {
    regex: /\bsuch as\b/i,
    type: "open_ended",
    problem: 'Open-ended: "such as" implies incomplete list',
    suggestion: "Provide exhaustive list or define boundaries",
  },
  {
    regex: /\bincluding but not limited to\b/i,
    type: "open_ended",
    problem: "Open-ended: scope is unbounded",
    suggestion: "Define explicit boundaries or enumerate all items",
  },
  {
    regex: /\bfor example\b/i,
    type: "open_ended",
    problem: 'Open-ended: "for example" implies other cases exist',
    suggestion: "List all cases or define scope boundaries",
  },
  {
    regex: /\bvarious\b/i,
    type: "open_ended",
    problem: 'Open-ended: "various" items not specified',
    suggestion: "Enumerate the specific items",
  },
  {
    regex: /\bother(?:s)?\b(?!\s+(?:than|hand|words|side))/i,
    type: "open_ended",
    problem: 'Open-ended: "other" items not specified',
    suggestion: "List all items explicitly or define boundaries",
  },
];

/**
 * Lint a single acceptance criterion against all patterns
 *
 * @param ac - The acceptance criterion to lint
 * @param patterns - Optional custom patterns (defaults to DEFAULT_LINT_PATTERNS)
 * @returns Lint result with any issues found
 */
export function lintAcceptanceCriterion(
  ac: AcceptanceCriterion,
  patterns: LintPattern[] = DEFAULT_LINT_PATTERNS,
): ACLintResult {
  const issues: ACLintIssue[] = [];
  const description = ac.description;

  for (const pattern of patterns) {
    const match = description.match(pattern.regex);
    if (match) {
      issues.push({
        type: pattern.type,
        matchedPattern: match[0],
        problem: pattern.problem,
        suggestion: pattern.suggestion,
      });
    }
  }

  return {
    ac,
    issues,
    passed: issues.length === 0,
  };
}

/**
 * Lint all acceptance criteria
 *
 * @param criteria - Array of acceptance criteria to lint
 * @param patterns - Optional custom patterns
 * @returns Complete lint results with summary
 */
export function lintAcceptanceCriteria(
  criteria: AcceptanceCriterion[],
  patterns?: LintPattern[],
): ACLintResults {
  const results = criteria.map((ac) => lintAcceptanceCriterion(ac, patterns));

  const passed = results.filter((r) => r.passed).length;
  const flagged = results.filter((r) => !r.passed).length;

  return {
    results,
    summary: {
      total: criteria.length,
      passed,
      flagged,
    },
    hasIssues: flagged > 0,
  };
}

/**
 * Format lint results as markdown for the spec output
 *
 * @param results - Lint results to format
 * @returns Markdown-formatted output string
 */
export function formatACLintResults(results: ACLintResults): string {
  if (results.summary.total === 0) {
    return "## AC Quality Check\n\nNo acceptance criteria found to lint.";
  }

  const lines: string[] = ["## AC Quality Check", ""];

  // Add summary line
  if (!results.hasIssues) {
    lines.push(
      `✅ All ${results.summary.total} acceptance criteria are clear and testable.`,
    );
    lines.push("");
    return lines.join("\n");
  }

  // Add issues
  for (const result of results.results) {
    if (!result.passed) {
      lines.push(`⚠️ **${result.ac.id}:** "${result.ac.description}"`);
      for (const issue of result.issues) {
        lines.push(`   → ${issue.problem}`);
        lines.push(`   → Suggest: ${issue.suggestion}`);
      }
      lines.push("");
    }
  }

  // Add passed ACs summary
  const passedIds = results.results.filter((r) => r.passed).map((r) => r.ac.id);

  if (passedIds.length > 0) {
    lines.push(`✅ ${passedIds.join(", ")}: Clear and testable`);
    lines.push("");
  }

  // Add summary
  lines.push(
    `**Summary:** ${results.summary.flagged}/${results.summary.total} AC items flagged for review`,
  );

  return lines.join("\n");
}

/**
 * Get the default lint patterns
 *
 * @returns Copy of the default lint patterns
 */
export function getDefaultLintPatterns(): LintPattern[] {
  return [...DEFAULT_LINT_PATTERNS];
}

/**
 * Create custom lint patterns from a simplified configuration
 *
 * @param config - Array of pattern configurations
 * @returns Array of LintPattern objects
 */
export function createLintPatterns(
  config: Array<{
    pattern: string;
    type: ACLintIssueType;
    problem: string;
    suggestion: string;
  }>,
): LintPattern[] {
  return config.map((c) => ({
    regex: new RegExp(c.pattern, "i"),
    type: c.type,
    problem: c.problem,
    suggestion: c.suggestion,
  }));
}
