/**
 * Scope Assessment Formatter
 *
 * Formats scope assessment results as markdown for /spec output
 * and GitHub issue comments.
 *
 * @example
 * ```typescript
 * import { formatScopeAssessment } from './formatter';
 *
 * const assessment = performScopeAssessment(criteria, issueBody, title);
 * console.log(formatScopeAssessment(assessment));
 * ```
 */

import type { ScopeAssessment, NonGoals } from "./types.js";
import { getVerdictEmoji, getStatusEmoji } from "./verdict.js";

/**
 * Format non-goals section for output
 *
 * @param nonGoals - Non-goals parsing result
 * @returns Formatted markdown string
 */
export function formatNonGoals(nonGoals: NonGoals): string {
  const lines: string[] = ["### Non-Goals (Required)", ""];

  if (!nonGoals.found) {
    lines.push(
      "⚠️ **Non-Goals section not found.** Consider adding scope boundaries.",
    );
    lines.push("");
    lines.push("Example format:");
    lines.push("```markdown");
    lines.push("## Non-Goals");
    lines.push("");
    lines.push("What this issue explicitly will NOT do:");
    lines.push("- [ ] [Adjacent feature we're deferring]");
    lines.push("- [ ] [Scope boundary we're respecting]");
    lines.push("- [ ] [Future work that's out of scope]");
    lines.push("```");
    return lines.join("\n");
  }

  if (nonGoals.items.length === 0) {
    lines.push(
      "⚠️ **Non-Goals section is empty.** Add explicit scope boundaries.",
    );
    return lines.join("\n");
  }

  lines.push(`✅ ${nonGoals.items.length} non-goal(s) defined:`);
  lines.push("");
  for (const item of nonGoals.items) {
    lines.push(`- ${item}`);
  }

  return lines.join("\n");
}

/**
 * Format scope metrics table
 *
 * @param assessment - Complete scope assessment
 * @returns Formatted markdown table
 */
export function formatMetricsTable(assessment: ScopeAssessment): string {
  const lines: string[] = [
    "### Scope Metrics",
    "",
    "| Metric | Value | Status |",
    "|--------|-------|--------|",
  ];

  for (const metric of assessment.metrics) {
    const emoji = getStatusEmoji(metric.status);
    lines.push(`| ${metric.name} | ${metric.value} | ${emoji} |`);
  }

  return lines.join("\n");
}

/**
 * Format scope verdict section
 *
 * @param assessment - Complete scope assessment
 * @returns Formatted markdown string
 */
export function formatVerdict(assessment: ScopeAssessment): string {
  const emoji = getVerdictEmoji(assessment.verdict);
  const lines: string[] = [
    "### Scope Verdict",
    "",
    `${emoji} **${assessment.verdict}** - ${assessment.recommendation}`,
  ];

  // Add split recommendation details if needed
  if (assessment.verdict === "SCOPE_SPLIT_RECOMMENDED") {
    lines.push("");
    lines.push("**Suggested splits:**");

    // Group ACs by cluster for split suggestions
    const significantClusters = assessment.featureDetection.clusters.filter(
      (c) => c.count >= 2,
    );

    if (significantClusters.length > 1) {
      for (const cluster of significantClusters) {
        lines.push(
          `- Issue for **${cluster.keyword}**: ${cluster.acIds.join(", ")}`,
        );
      }
    } else {
      lines.push("- Consider separating by functional area");
      lines.push("- Each issue should have a single deployable outcome");
    }
  }

  return lines.join("\n");
}

/**
 * Format complete scope assessment section
 *
 * @param assessment - Complete scope assessment
 * @returns Formatted markdown string
 */
export function formatScopeAssessment(assessment: ScopeAssessment): string {
  if (assessment.skipped) {
    return [
      "## Scope Assessment",
      "",
      `*Skipped: ${assessment.skipReason}*`,
    ].join("\n");
  }

  const sections: string[] = [
    "## Scope Assessment",
    "",
    formatNonGoals(assessment.nonGoals),
    "",
    formatMetricsTable(assessment),
    "",
    formatVerdict(assessment),
  ];

  // Add quality loop recommendation if needed
  if (
    assessment.verdict === "SCOPE_WARNING" ||
    assessment.verdict === "SCOPE_SPLIT_RECOMMENDED"
  ) {
    sections.push("");
    sections.push("---");
    sections.push("");
    sections.push(
      "**Quality Loop:** Will be auto-enabled due to scope concerns.",
    );
  }

  return sections.join("\n");
}

/**
 * Format condensed scope assessment for issue comments
 *
 * A shorter version suitable for GitHub issue comments.
 *
 * @param assessment - Complete scope assessment
 * @returns Condensed markdown string
 */
export function formatCondensedAssessment(assessment: ScopeAssessment): string {
  if (assessment.skipped) {
    return `**Scope Assessment:** Skipped (${assessment.skipReason})`;
  }

  const emoji = getVerdictEmoji(assessment.verdict);
  const lines: string[] = [
    `### Scope Assessment: ${emoji} ${assessment.verdict}`,
  ];

  // Metrics in single line
  const metricsLine = assessment.metrics
    .map((m) => `${m.name}: ${m.value} ${getStatusEmoji(m.status)}`)
    .join(" | ");
  lines.push("");
  lines.push(metricsLine);

  // Non-goals summary
  if (!assessment.nonGoals.found || assessment.nonGoals.items.length === 0) {
    lines.push("");
    lines.push("⚠️ Non-Goals: Not defined");
  } else {
    lines.push("");
    lines.push(`✅ Non-Goals: ${assessment.nonGoals.items.length} defined`);
  }

  // Recommendation if not OK
  if (assessment.verdict !== "SCOPE_OK") {
    lines.push("");
    lines.push(`*${assessment.recommendation}*`);
  }

  return lines.join("\n");
}
