/**
 * Merge readiness report generation (AC-5)
 *
 * Produces structured Markdown report with per-PR verdicts and
 * batch-level verdict. Optionally posts to GitHub as PR comment.
 */

import { spawnSync } from "child_process";
import type {
  MergeReport,
  CheckResult,
  CheckVerdict,
  BatchVerdict,
  BranchInfo,
  CheckFinding,
} from "./types.js";

/**
 * Compute per-issue verdicts from check results
 */
export function computeIssueVerdicts(
  branches: BranchInfo[],
  checks: CheckResult[],
): Map<number, CheckVerdict> {
  const verdicts = new Map<number, CheckVerdict>();

  for (const branch of branches) {
    let worstVerdict: CheckVerdict = "PASS";

    for (const check of checks) {
      const branchResult = check.branchResults.find(
        (r) => r.issueNumber === branch.issueNumber,
      );
      if (!branchResult) continue;

      if (branchResult.verdict === "FAIL") {
        worstVerdict = "FAIL";
      } else if (branchResult.verdict === "WARN" && worstVerdict !== "FAIL") {
        worstVerdict = "WARN";
      }
    }

    verdicts.set(branch.issueNumber, worstVerdict);
  }

  return verdicts;
}

/**
 * Compute batch-level verdict from per-issue verdicts and check results.
 *
 * Checks that fail at the batch level (e.g., combined-branch-test can't
 * create temp branch) may have no branch results but still indicate a
 * problem. These are reflected via the checks parameter.
 */
export function computeBatchVerdict(
  issueVerdicts: Map<number, CheckVerdict>,
  checks?: CheckResult[],
): BatchVerdict {
  // Check for batch-level failures (checks that failed without branch results)
  if (
    checks?.some(
      (c) => !c.passed && c.batchFindings.some((f) => f.severity === "error"),
    )
  ) {
    return "BLOCKED";
  }

  const verdicts = Array.from(issueVerdicts.values());

  if (verdicts.some((v) => v === "FAIL")) {
    return "BLOCKED";
  }
  if (verdicts.some((v) => v === "WARN")) {
    return "NEEDS_ATTENTION";
  }

  // Check for batch-level warnings
  if (checks?.some((c) => !c.passed)) {
    return "NEEDS_ATTENTION";
  }

  return "READY";
}

/**
 * Collect all findings from check results
 */
function collectFindings(checks: CheckResult[]): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const check of checks) {
    findings.push(...check.batchFindings);
    for (const br of check.branchResults) {
      findings.push(...br.findings);
    }
  }
  return findings;
}

/**
 * Build a MergeReport from check results
 */
export function buildReport(
  branches: BranchInfo[],
  checks: CheckResult[],
  runId?: string,
): MergeReport {
  const issueVerdicts = computeIssueVerdicts(branches, checks);
  const batchVerdict = computeBatchVerdict(issueVerdicts, checks);
  const findings = collectFindings(checks);

  return {
    runId,
    timestamp: new Date().toISOString(),
    branches,
    checks,
    issueVerdicts,
    batchVerdict,
    findings,
  };
}

/**
 * Verdict emoji
 */
function verdictIcon(v: CheckVerdict | BatchVerdict): string {
  switch (v) {
    case "PASS":
    case "READY":
      return "\u2705";
    case "WARN":
    case "NEEDS_ATTENTION":
      return "\u26a0\ufe0f";
    case "FAIL":
    case "BLOCKED":
      return "\u274c";
  }
}

/**
 * Format a MergeReport as Markdown
 */
export function formatReportMarkdown(report: MergeReport): string {
  const lines: string[] = [];

  lines.push("# Merge Readiness Report");
  lines.push("");
  if (report.runId) {
    lines.push(`**Run:** ${report.runId}`);
  }
  lines.push(`**Generated:** ${report.timestamp}`);
  lines.push(
    `**Batch Verdict:** ${verdictIcon(report.batchVerdict)} **${report.batchVerdict}**`,
  );
  lines.push("");

  // Per-issue verdicts table
  lines.push("## Per-Issue Verdicts");
  lines.push("");
  lines.push("| Issue | Title | Verdict |");
  lines.push("|-------|-------|---------|");
  for (const branch of report.branches) {
    const verdict = report.issueVerdicts.get(branch.issueNumber) ?? "PASS";
    lines.push(
      `| #${branch.issueNumber} | ${branch.title} | ${verdictIcon(verdict)} ${verdict} |`,
    );
  }
  lines.push("");

  // Check results
  for (const check of report.checks) {
    lines.push(`## ${formatCheckName(check.name)}`);
    lines.push("");
    lines.push(
      `**Status:** ${check.passed ? "\u2705 Passed" : "\u274c Issues found"} (${Math.round(check.durationMs / 1000)}s)`,
    );
    lines.push("");

    // Batch findings
    if (check.batchFindings.length > 0) {
      for (const finding of check.batchFindings) {
        lines.push(`- ${severityIcon(finding.severity)} ${finding.message}`);
      }
      lines.push("");
    }

    // Per-branch findings (only show non-info)
    for (const br of check.branchResults) {
      const significant = br.findings.filter((f) => f.severity !== "info");
      if (significant.length > 0) {
        lines.push(`### Issue #${br.issueNumber}`);
        lines.push("");
        for (const finding of significant) {
          lines.push(`- ${severityIcon(finding.severity)} ${finding.message}`);
        }
        lines.push("");
      }
    }
  }

  // Summary
  const errors = report.findings.filter((f) => f.severity === "error");
  const warnings = report.findings.filter((f) => f.severity === "warning");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Errors:** ${errors.length}`);
  lines.push(`- **Warnings:** ${warnings.length}`);
  lines.push(`- **Issues in batch:** ${report.branches.length}`);
  lines.push(`- **Checks run:** ${report.checks.length}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Format a report scoped to a single issue/PR.
 *
 * Includes batch verdict header, the issue's own findings, and any
 * cross-issue findings that mention this issue (e.g. overlap warnings).
 */
export function formatBranchReportMarkdown(
  report: MergeReport,
  issueNumber: number,
): string {
  const lines: string[] = [];
  const branch = report.branches.find((b) => b.issueNumber === issueNumber);
  if (!branch) {
    return `No data for issue #${issueNumber} in this report.`;
  }

  const issueVerdict = report.issueVerdicts.get(issueNumber) ?? "PASS";

  lines.push("# Merge Readiness — Per-Issue Report");
  lines.push("");
  lines.push(`**Issue:** #${issueNumber} — ${branch.title}`);
  lines.push(`**Branch:** \`${branch.branch}\``);
  lines.push(
    `**Batch Verdict:** ${verdictIcon(report.batchVerdict)} **${report.batchVerdict}**`,
  );
  lines.push(
    `**Issue Verdict:** ${verdictIcon(issueVerdict)} **${issueVerdict}**`,
  );
  lines.push("");

  for (const check of report.checks) {
    const branchResult = check.branchResults.find(
      (r) => r.issueNumber === issueNumber,
    );
    if (!branchResult) continue;

    const significant = branchResult.findings.filter(
      (f) => f.severity !== "info",
    );
    const relevantBatch = check.batchFindings.filter(
      (f) =>
        f.issueNumber === issueNumber || f.message.includes(`#${issueNumber}`),
    );

    if (significant.length === 0 && relevantBatch.length === 0) {
      continue;
    }

    lines.push(`## ${formatCheckName(check.name)}`);
    lines.push("");

    for (const finding of relevantBatch) {
      lines.push(`- ${severityIcon(finding.severity)} ${finding.message}`);
    }
    for (const finding of significant) {
      lines.push(`- ${severityIcon(finding.severity)} ${finding.message}`);
    }
    lines.push("");
  }

  if (lines.length <= 7) {
    lines.push("All checks passed for this issue.");
    lines.push("");
  }

  return lines.join("\n");
}

function formatCheckName(name: string): string {
  return name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function severityIcon(severity: string): string {
  switch (severity) {
    case "error":
      return "\u274c";
    case "warning":
      return "\u26a0\ufe0f";
    case "info":
      return "\u2139\ufe0f";
    default:
      return "";
  }
}

/**
 * Post report to GitHub as PR comments (AC-5 --post flag)
 */
export function postReportToGitHub(report: MergeReport): void {
  for (const branch of report.branches) {
    if (!branch.prNumber) continue;

    const markdown = formatBranchReportMarkdown(report, branch.issueNumber);

    const result = spawnSync(
      "gh",
      ["pr", "comment", String(branch.prNumber), "--body", markdown],
      { stdio: "pipe", encoding: "utf-8" },
    );

    if (result.status !== 0) {
      console.error(
        `Failed to post comment on PR #${branch.prNumber}: ${result.stderr}`,
      );
    }
  }
}
