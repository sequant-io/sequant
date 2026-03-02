/**
 * Report generation for upstream assessments
 * Creates markdown reports for GitHub issues and local files
 */

import type {
  AssessmentSummary,
  Finding,
  FindingCategory,
  UpstreamAssessment,
  BatchedAssessment,
} from "./types.js";

/**
 * Calculate summary counts from findings
 */
export function calculateSummary(findings: Finding[]): AssessmentSummary {
  const summary: AssessmentSummary = {
    breakingChanges: 0,
    deprecations: 0,
    newTools: 0,
    hookChanges: 0,
    opportunities: 0,
    noAction: 0,
  };

  for (const finding of findings) {
    switch (finding.category) {
      case "breaking":
        summary.breakingChanges++;
        break;
      case "deprecation":
        summary.deprecations++;
        break;
      case "new-tool":
        summary.newTools++;
        break;
      case "hook-change":
        summary.hookChanges++;
        break;
      case "opportunity":
        summary.opportunities++;
        break;
      case "no-action":
        summary.noAction++;
        break;
    }
  }

  return summary;
}

/**
 * Get action status text for summary table
 */
function getActionStatus(count: number, category: FindingCategory): string {
  if (count === 0) {
    return "None";
  }

  switch (category) {
    case "breaking":
      return "Review required";
    case "deprecation":
      return "Review needed";
    case "new-tool":
    case "hook-change":
      return "Issues created";
    case "opportunity":
      return "Noted for review";
    default:
      return "None";
  }
}

/**
 * Format a finding for the assessment report
 */
function formatFinding(finding: Finding, index: number): string {
  const lines: string[] = [];

  lines.push(`#### ${index + 1}. ${finding.title}`);
  lines.push("");

  if (finding.description !== finding.title) {
    lines.push(`> ${finding.description}`);
    lines.push("");
  }

  if (finding.matchedKeywords.length > 0) {
    lines.push(`- **Matched keywords:** ${finding.matchedKeywords.join(", ")}`);
  }

  if (finding.matchedPatterns.length > 0) {
    lines.push(`- **Matched patterns:** ${finding.matchedPatterns.join(", ")}`);
  }

  if (finding.sequantFiles.length > 0) {
    lines.push(`- **Affected files:** ${finding.sequantFiles.join(", ")}`);
  }

  lines.push(`- **Impact:** ${finding.impact}`);

  if (finding.issueNumber) {
    lines.push(`- **Issue created:** #${finding.issueNumber}`);
  }

  if (finding.existingIssue) {
    lines.push(`- **Existing issue:** #${finding.existingIssue}`);
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Generate the assessment issue body
 */
export function generateAssessmentReport(
  assessment: UpstreamAssessment,
): string {
  const { version, releaseDate, assessmentDate, findings, summary, dryRun } =
    assessment;

  const lines: string[] = [];

  // Header
  lines.push(`## Upstream: Claude Code ${version} Assessment`);
  lines.push("");
  lines.push(
    `**Release:** [${version}](https://github.com/anthropics/claude-code/releases/tag/${version})`,
  );
  lines.push(`**Released:** ${releaseDate}`);
  lines.push(`**Assessed:** ${assessmentDate}`);
  if (dryRun) {
    lines.push(`**Mode:** Dry Run (no issues created)`);
  }
  lines.push("");

  // Summary table
  lines.push("### Summary");
  lines.push("");
  lines.push("| Category | Count | Action Required |");
  lines.push("|----------|-------|-----------------|");
  lines.push(
    `| Breaking Changes | ${summary.breakingChanges} | ${getActionStatus(summary.breakingChanges, "breaking")} |`,
  );
  lines.push(
    `| Deprecations | ${summary.deprecations} | ${getActionStatus(summary.deprecations, "deprecation")} |`,
  );
  lines.push(
    `| New Tools | ${summary.newTools} | ${getActionStatus(summary.newTools, "new-tool")} |`,
  );
  lines.push(
    `| Hook Changes | ${summary.hookChanges} | ${getActionStatus(summary.hookChanges, "hook-change")} |`,
  );
  lines.push(
    `| Opportunities | ${summary.opportunities} | ${getActionStatus(summary.opportunities, "opportunity")} |`,
  );
  lines.push(`| No Action | ${summary.noAction} | None |`);
  lines.push("");

  // Actionable section — breaking changes, deprecations, new tools, hook changes
  const actionableCategories: FindingCategory[] = [
    "breaking",
    "deprecation",
    "new-tool",
    "hook-change",
  ];
  const actionableFindings = findings.filter((f) =>
    actionableCategories.includes(f.category),
  );
  lines.push("### Actionable");
  lines.push("");
  lines.push(
    "*Breaking changes, deprecations, and other items that affect sequant.*",
  );
  lines.push("");
  if (actionableFindings.length === 0) {
    lines.push("None detected.");
  } else {
    actionableFindings.forEach((f, i) => {
      lines.push(formatFinding(f, i));
    });
  }
  lines.push("");

  // Informational section — opportunities noted for human triage
  const opportunities = findings.filter((f) => f.category === "opportunity");
  lines.push("### Informational");
  lines.push("");
  lines.push(
    "*Opportunities noted for human triage. No individual issues auto-created.*",
  );
  lines.push("");
  if (opportunities.length === 0) {
    lines.push("None detected.");
  } else {
    opportunities.forEach((f, i) => {
      lines.push(formatFinding(f, i));
    });
  }
  lines.push("");

  // No Action section
  const noAction = findings.filter((f) => f.category === "no-action");
  lines.push("### No Action Required");
  lines.push("");
  if (noAction.length === 0) {
    lines.push("All changes were relevant.");
  } else {
    lines.push(`${noAction.length} changes did not require action:`);
    lines.push("");
    noAction.forEach((f) => {
      lines.push(`- ${f.description}`);
    });
  }
  lines.push("");

  // Footer
  lines.push("---");
  lines.push("");
  lines.push("*Generated by /upstream skill*");

  return lines.join("\n");
}

/**
 * Generate an individual issue body for an actionable finding
 */
export function generateFindingIssue(
  finding: Finding,
  version: string,
  assessmentIssueNumber?: number,
): { title: string; body: string; labels: string[] } {
  const lines: string[] = [];

  // Determine issue type prefix
  let prefix: string;
  switch (finding.category) {
    case "breaking":
      prefix = "fix";
      break;
    case "deprecation":
      prefix = "chore";
      break;
    default:
      prefix = "feat";
  }

  // Generate title
  const title = `${prefix}: ${finding.title} (from Claude Code ${version})`;

  // Body
  lines.push(`**Upstream:** Claude Code ${version}`);
  lines.push(`**Category:** ${formatCategory(finding.category)}`);
  if (assessmentIssueNumber) {
    lines.push(`**Assessment:** #${assessmentIssueNumber}`);
  }
  lines.push("");

  lines.push("### Context");
  lines.push("");
  lines.push(finding.description);
  lines.push("");

  if (finding.sequantFiles.length > 0) {
    lines.push("### Affected Files");
    lines.push("");
    finding.sequantFiles.forEach((f) => {
      lines.push(`- \`${f}\``);
    });
    lines.push("");
  }

  lines.push("### Opportunity");
  lines.push("");
  lines.push("[To be analyzed during /spec phase]");
  lines.push("");

  lines.push("### Proposed Implementation");
  lines.push("");
  lines.push("[To be determined during /spec phase]");
  lines.push("");

  lines.push("### Acceptance Criteria");
  lines.push("");
  lines.push("- [ ] AC-1: [To be defined]");
  lines.push("");

  lines.push("---");
  lines.push("");
  if (assessmentIssueNumber) {
    lines.push(
      `*Auto-created by /upstream assessment #${assessmentIssueNumber}*`,
    );
  } else {
    lines.push("*Auto-created by /upstream skill*");
  }

  // Labels
  const labels = ["upstream", "needs-triage"];
  switch (finding.category) {
    case "breaking":
      labels.push("bug", "priority:high");
      break;
    case "deprecation":
      labels.push("bug");
      break;
    default:
      labels.push("enhancement");
  }

  return {
    title,
    body: lines.join("\n"),
    labels,
  };
}

/**
 * Generate a batched summary issue for multiple versions
 */
export function generateBatchedSummaryReport(
  batched: BatchedAssessment,
): string {
  const lines: string[] = [];

  lines.push(
    `## Upstream: Claude Code Assessment (${batched.sinceVersion} → ${batched.toVersion})`,
  );
  lines.push("");
  lines.push(`**Versions assessed:** ${batched.versions.length}`);
  lines.push(`**From:** ${batched.sinceVersion}`);
  lines.push(`**To:** ${batched.toVersion}`);
  lines.push("");

  // Summary across all versions
  const totals: AssessmentSummary = {
    breakingChanges: 0,
    deprecations: 0,
    newTools: 0,
    hookChanges: 0,
    opportunities: 0,
    noAction: 0,
  };

  for (const assessment of batched.assessments) {
    totals.breakingChanges += assessment.summary.breakingChanges;
    totals.deprecations += assessment.summary.deprecations;
    totals.newTools += assessment.summary.newTools;
    totals.hookChanges += assessment.summary.hookChanges;
    totals.opportunities += assessment.summary.opportunities;
    totals.noAction += assessment.summary.noAction;
  }

  lines.push("### Combined Summary");
  lines.push("");
  lines.push("| Category | Total |");
  lines.push("|----------|-------|");
  lines.push(`| Breaking Changes | ${totals.breakingChanges} |`);
  lines.push(`| Deprecations | ${totals.deprecations} |`);
  lines.push(`| New Tools | ${totals.newTools} |`);
  lines.push(`| Hook Changes | ${totals.hookChanges} |`);
  lines.push(`| Opportunities | ${totals.opportunities} |`);
  lines.push("");

  // Per-version breakdown
  lines.push("### Per-Version Breakdown");
  lines.push("");

  for (const assessment of batched.assessments) {
    const actionable =
      assessment.summary.breakingChanges +
      assessment.summary.deprecations +
      assessment.summary.newTools +
      assessment.summary.hookChanges +
      assessment.summary.opportunities;

    lines.push(`#### ${assessment.version}`);
    lines.push("");
    lines.push(`- Released: ${assessment.releaseDate}`);
    lines.push(`- Actionable findings: ${actionable}`);
    if (assessment.issuesCreated.length > 0) {
      lines.push(
        `- Issues created: ${assessment.issuesCreated.map((n) => `#${n}`).join(", ")}`,
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push("*Generated by /upstream skill*");

  return lines.join("\n");
}

/**
 * Generate local report markdown file
 */
export function generateLocalReport(assessment: UpstreamAssessment): string {
  const lines: string[] = [];

  lines.push(`# Claude Code ${assessment.version} Assessment`);
  lines.push("");
  lines.push(`**Assessed:** ${assessment.assessmentDate}`);
  if (assessment.previousVersion) {
    lines.push(`**Previous:** ${assessment.previousVersion}`);
  }
  lines.push("");

  // Include full assessment report
  lines.push(generateAssessmentReport(assessment));
  lines.push("");

  // Add raw data section for debugging
  lines.push("## Raw Data");
  lines.push("");
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        version: assessment.version,
        releaseDate: assessment.releaseDate,
        assessmentDate: assessment.assessmentDate,
        previousVersion: assessment.previousVersion,
        summary: assessment.summary,
        issuesCreated: assessment.issuesCreated,
        findingCount: assessment.findings.length,
      },
      null,
      2,
    ),
  );
  lines.push("```");

  return lines.join("\n");
}

/**
 * Format category for display
 */
function formatCategory(category: FindingCategory): string {
  switch (category) {
    case "breaking":
      return "Breaking Change";
    case "deprecation":
      return "Deprecation";
    case "new-tool":
      return "New Tool";
    case "hook-change":
      return "Hook Change";
    case "opportunity":
      return "Feature Opportunity";
    case "no-action":
      return "No Action";
  }
}
