/**
 * Residual pattern detection (AC-3)
 *
 * Extracts removed/replaced patterns from each PR's diff,
 * generates literal search strings, and greps the codebase
 * for remaining instances (excluding already-modified files).
 */

import { spawnSync } from "child_process";
import type {
  BranchInfo,
  CheckResult,
  BranchCheckResult,
  CheckFinding,
  ExtractedPattern,
  ResidualMatch,
} from "./types.js";
import { getBranchRef } from "./types.js";

/**
 * Minimum pattern length to avoid false positives from trivial removals
 */
const MIN_PATTERN_LENGTH = 8;

/**
 * Maximum number of patterns to scan per branch (avoid explosion)
 */
const MAX_PATTERNS_PER_BRANCH = 50;

/**
 * Lines that should be ignored when extracting patterns
 * (import statements, blank lines, comments, etc.)
 */
const IGNORE_PATTERNS = [
  /^\s*$/,
  /^\s*\/\//,
  /^\s*\/?\*/, // Single-line comment or multi-line comment line
  /^\s*import\s/,
  /^\s*export\s/,
  /^\s*\{?\s*\}?\s*$/,
  /^\s*\)\s*;?\s*$/,
  /^\s*\]\s*;?\s*$/,
];

/**
 * Extract removed patterns from a git diff for a branch.
 *
 * Looks at lines removed (prefixed with -) in the diff and extracts
 * significant literal strings that might indicate incomplete migration.
 */
export function extractPatternsFromDiff(
  branch: BranchInfo,
  repoRoot: string,
): ExtractedPattern[] {
  const diffResult = spawnSync(
    "git",
    [
      "-C",
      repoRoot,
      "diff",
      `origin/main...${getBranchRef(branch)}`,
      "--unified=0",
    ],
    { stdio: "pipe", encoding: "utf-8" },
  );

  if (diffResult.status !== 0 || !diffResult.stdout) {
    return [];
  }

  const patterns: ExtractedPattern[] = [];
  const seenPatterns = new Set<string>();
  let currentFile = "";

  for (const line of diffResult.stdout.split("\n")) {
    // Track current file from diff header
    if (line.startsWith("--- a/")) {
      currentFile = line.slice(6);
      continue;
    }

    // Only look at removed lines (not additions)
    if (!line.startsWith("-") || line.startsWith("---")) {
      continue;
    }

    const content = line.slice(1).trim();

    // Skip trivial lines
    if (content.length < MIN_PATTERN_LENGTH) continue;
    if (IGNORE_PATTERNS.some((p) => p.test(content))) continue;

    // Deduplicate
    if (seenPatterns.has(content)) continue;
    seenPatterns.add(content);

    patterns.push({
      pattern: content,
      sourceFile: currentFile,
      issueNumber: branch.issueNumber,
    });

    if (patterns.length >= MAX_PATTERNS_PER_BRANCH) break;
  }

  return patterns;
}

/**
 * Search the codebase for remaining instances of extracted patterns.
 *
 * Uses git grep for literal string matching. Excludes files that were
 * already modified by the branch (they've already been addressed).
 */
export function findResiduals(
  patterns: ExtractedPattern[],
  excludeFiles: string[],
  repoRoot: string,
): ResidualMatch[] {
  const matches: ResidualMatch[] = [];
  const excludeSet = new Set(excludeFiles);

  for (const pattern of patterns) {
    // Use git grep for literal search (fast, respects .gitignore)
    const grepResult = spawnSync(
      "git",
      [
        "-C",
        repoRoot,
        "grep",
        "-n",
        "--fixed-strings",
        pattern.pattern,
        "--",
        "*.ts",
        "*.tsx",
        "*.js",
        "*.jsx",
        "*.md",
        "*.sh",
      ],
      { stdio: "pipe", encoding: "utf-8", timeout: 10_000 },
    );

    if (grepResult.status !== 0 || !grepResult.stdout) {
      continue;
    }

    for (const line of grepResult.stdout.split("\n")) {
      if (!line.trim()) continue;

      // Format: file:line:content
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const file = line.slice(0, colonIdx);
      const rest = line.slice(colonIdx + 1);
      const secondColon = rest.indexOf(":");
      const lineNum =
        secondColon > -1 ? parseInt(rest.slice(0, secondColon), 10) : 0;
      const content =
        secondColon > -1 ? rest.slice(secondColon + 1).trim() : rest.trim();

      // Skip files that were already modified by this branch
      if (excludeSet.has(file)) continue;

      // Skip test files and node_modules
      if (
        file.includes("node_modules/") ||
        file.includes(".test.") ||
        file.includes(".spec.")
      ) {
        continue;
      }

      matches.push({
        pattern: pattern.pattern,
        file,
        line: lineNum,
        content: content.slice(0, 200), // Truncate long lines
        issueNumber: pattern.issueNumber,
      });
    }
  }

  return matches;
}

/**
 * Run residual pattern scan across all branches.
 */
export function runResidualPatternScan(
  branches: BranchInfo[],
  repoRoot: string,
): CheckResult {
  const startTime = Date.now();
  const branchResults: BranchCheckResult[] = [];
  const batchFindings: CheckFinding[] = [];

  for (const branch of branches) {
    const findings: CheckFinding[] = [];

    // Extract patterns from this branch's diff
    const patterns = extractPatternsFromDiff(branch, repoRoot);

    if (patterns.length === 0) {
      branchResults.push({
        issueNumber: branch.issueNumber,
        verdict: "PASS",
        findings: [
          {
            check: "residual-pattern-scan",
            severity: "info",
            message: "No significant patterns extracted from diff",
            issueNumber: branch.issueNumber,
          },
        ],
      });
      continue;
    }

    // Search for residuals, excluding files already modified
    const residuals = findResiduals(patterns, branch.filesModified, repoRoot);

    if (residuals.length === 0) {
      branchResults.push({
        issueNumber: branch.issueNumber,
        verdict: "PASS",
        findings: [
          {
            check: "residual-pattern-scan",
            severity: "info",
            message: `Scanned ${patterns.length} patterns — no residuals found`,
            issueNumber: branch.issueNumber,
          },
        ],
      });
      continue;
    }

    // Group residuals by pattern for cleaner reporting
    const byPattern = new Map<string, ResidualMatch[]>();
    for (const match of residuals) {
      const existing = byPattern.get(match.pattern) ?? [];
      existing.push(match);
      byPattern.set(match.pattern, existing);
    }

    for (const [pattern, matches] of byPattern) {
      findings.push({
        check: "residual-pattern-scan",
        severity: "warning",
        message: `Pattern "${pattern.slice(0, 60)}${pattern.length > 60 ? "..." : ""}" still found in ${matches.length} file(s): ${matches.map((m) => m.file).join(", ")}`,
        issueNumber: branch.issueNumber,
      });
    }

    branchResults.push({
      issueNumber: branch.issueNumber,
      verdict: "WARN",
      findings,
    });

    // Also add to batch findings for the summary
    batchFindings.push({
      check: "residual-pattern-scan",
      severity: "warning",
      message: `Issue #${branch.issueNumber}: ${residuals.length} residual match(es) across ${byPattern.size} pattern(s)`,
      issueNumber: branch.issueNumber,
    });
  }

  const hasResiduals = branchResults.some((r) => r.verdict !== "PASS");
  return {
    name: "residual-pattern-scan",
    passed: !hasResiduals,
    branchResults,
    batchFindings,
    durationMs: Date.now() - startTime,
  };
}
