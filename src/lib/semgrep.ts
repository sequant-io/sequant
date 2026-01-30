/**
 * Semgrep integration for static analysis
 *
 * Provides stack-aware ruleset mapping and execution utilities
 * for integrating Semgrep into the /qa workflow.
 */

import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

/**
 * Semgrep finding severity levels
 */
export type SemgrepSeverity = "error" | "warning" | "info";

/**
 * A single Semgrep finding
 */
export interface SemgrepFinding {
  path: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  ruleId: string;
  severity: SemgrepSeverity;
  category?: string;
}

/**
 * Result of a Semgrep scan
 */
export interface SemgrepResult {
  success: boolean;
  findings: SemgrepFinding[];
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

/**
 * Semgrep ruleset configuration
 */
export interface SemgrepRuleset {
  name: string;
  description: string;
  rules: string[]; // Semgrep rule identifiers (e.g., "p/typescript", "p/security-audit")
}

/**
 * Stack-to-ruleset mapping
 *
 * Maps detected stacks to appropriate Semgrep rulesets.
 * Uses Semgrep's public rule registry identifiers.
 */
export const STACK_RULESETS: Record<string, SemgrepRuleset> = {
  nextjs: {
    name: "Next.js",
    description:
      "TypeScript/JavaScript security and best practices for Next.js",
    rules: [
      "p/typescript",
      "p/javascript",
      "p/react",
      "p/security-audit",
      "p/secrets",
    ],
  },
  astro: {
    name: "Astro",
    description: "TypeScript/JavaScript security for Astro projects",
    rules: ["p/typescript", "p/javascript", "p/security-audit", "p/secrets"],
  },
  sveltekit: {
    name: "SvelteKit",
    description: "TypeScript/JavaScript security for SvelteKit",
    rules: ["p/typescript", "p/javascript", "p/security-audit", "p/secrets"],
  },
  remix: {
    name: "Remix",
    description: "TypeScript/JavaScript security for Remix",
    rules: [
      "p/typescript",
      "p/javascript",
      "p/react",
      "p/security-audit",
      "p/secrets",
    ],
  },
  nuxt: {
    name: "Nuxt",
    description: "TypeScript/JavaScript security for Nuxt/Vue",
    rules: ["p/typescript", "p/javascript", "p/security-audit", "p/secrets"],
  },
  rust: {
    name: "Rust",
    description: "Rust security and best practices",
    rules: ["p/rust", "p/security-audit", "p/secrets"],
  },
  python: {
    name: "Python",
    description: "Python security and best practices",
    rules: ["p/python", "p/django", "p/flask", "p/security-audit", "p/secrets"],
  },
  go: {
    name: "Go",
    description: "Go security and best practices",
    rules: ["p/golang", "p/security-audit", "p/secrets"],
  },
  generic: {
    name: "Generic",
    description: "General security rules for any codebase",
    rules: ["p/security-audit", "p/secrets"],
  },
};

/**
 * Get the appropriate Semgrep ruleset for a detected stack
 *
 * @param stack - The detected stack name (e.g., "nextjs", "python")
 * @returns The ruleset configuration for the stack
 */
export function getRulesForStack(stack: string | null): SemgrepRuleset {
  if (!stack) {
    return STACK_RULESETS.generic;
  }
  return STACK_RULESETS[stack] || STACK_RULESETS.generic;
}

/**
 * Path to custom rules file
 */
export const CUSTOM_RULES_PATH = ".sequant/semgrep-rules.yaml";

/**
 * Check if custom rules file exists
 *
 * @param projectRoot - Root directory of the project
 * @returns true if custom rules file exists
 */
export function hasCustomRules(projectRoot: string = process.cwd()): boolean {
  return existsSync(join(projectRoot, CUSTOM_RULES_PATH));
}

/**
 * Get path to custom rules file if it exists
 *
 * @param projectRoot - Root directory of the project
 * @returns Path to custom rules file, or null if it doesn't exist
 */
export function getCustomRulesPath(
  projectRoot: string = process.cwd(),
): string | null {
  const customPath = join(projectRoot, CUSTOM_RULES_PATH);
  return existsSync(customPath) ? customPath : null;
}

/**
 * Check if Semgrep is available
 *
 * Checks for both 'semgrep' command and 'npx semgrep' fallback
 *
 * @returns Object with availability info and command to use
 */
export async function checkSemgrepAvailability(): Promise<{
  available: boolean;
  command: string;
  useNpx: boolean;
}> {
  // First try native semgrep
  try {
    await executeCommand("semgrep", ["--version"]);
    return { available: true, command: "semgrep", useNpx: false };
  } catch {
    // Native semgrep not available, try npx
  }

  // Try npx semgrep
  try {
    await executeCommand("npx", ["semgrep", "--version"]);
    return { available: true, command: "npx", useNpx: true };
  } catch {
    // npx semgrep also not available
  }

  return { available: false, command: "", useNpx: false };
}

/**
 * Execute a command and return stdout
 *
 * @param command - Command to execute
 * @param args - Command arguments
 * @returns stdout from the command
 */
function executeCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr || `Command exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Parse Semgrep JSON output into findings
 *
 * @param output - Raw JSON output from Semgrep
 * @returns Array of parsed findings
 */
export function parseSemgrepOutput(output: string): SemgrepFinding[] {
  try {
    const data = JSON.parse(output);
    const results = data.results || [];

    return results.map(
      (result: {
        path: string;
        start: { line: number; col?: number };
        end?: { line: number; col?: number };
        extra: {
          message: string;
          severity?: string;
          metadata?: { category?: string };
        };
        check_id: string;
      }) => ({
        path: result.path,
        line: result.start.line,
        column: result.start.col,
        endLine: result.end?.line,
        endColumn: result.end?.col,
        message: result.extra.message,
        ruleId: result.check_id,
        severity: mapSeverity(result.extra.severity || "warning"),
        category: result.extra.metadata?.category,
      }),
    );
  } catch {
    return [];
  }
}

/**
 * Map Semgrep severity to our internal severity type
 */
function mapSeverity(severity: string): SemgrepSeverity {
  const lower = severity.toLowerCase();
  if (lower === "error" || lower === "critical" || lower === "high") {
    return "error";
  }
  if (lower === "warning" || lower === "medium") {
    return "warning";
  }
  return "info";
}

/**
 * Count findings by severity
 *
 * @param findings - Array of Semgrep findings
 * @returns Object with counts by severity
 */
export function countFindingsBySeverity(findings: SemgrepFinding[]): {
  critical: number;
  warning: number;
  info: number;
} {
  return findings.reduce(
    (acc, finding) => {
      if (finding.severity === "error") {
        acc.critical++;
      } else if (finding.severity === "warning") {
        acc.warning++;
      } else {
        acc.info++;
      }
      return acc;
    },
    { critical: 0, warning: 0, info: 0 },
  );
}

/**
 * Run Semgrep scan on specified files or directories
 *
 * @param options - Scan options
 * @returns Scan result with findings
 */
export async function runSemgrepScan(options: {
  targets: string[];
  stack?: string | null;
  projectRoot?: string;
  useCustomRules?: boolean;
}): Promise<SemgrepResult> {
  const { targets, stack = null, projectRoot = process.cwd() } = options;
  const useCustomRules = options.useCustomRules ?? true;

  // Check availability
  const availability = await checkSemgrepAvailability();
  if (!availability.available) {
    return {
      success: true,
      findings: [],
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      skipped: true,
      skipReason: "Semgrep not installed (install with: pip install semgrep)",
    };
  }

  // Build command arguments
  const args: string[] = [];

  // If using npx, prepend 'semgrep' to args
  if (availability.useNpx) {
    args.push("semgrep");
  }

  // Add output format
  args.push("--json");

  // Add rules from stack
  const ruleset = getRulesForStack(stack);
  for (const rule of ruleset.rules) {
    args.push("--config", rule);
  }

  // Add custom rules if available
  if (useCustomRules) {
    const customRulesPath = getCustomRulesPath(projectRoot);
    if (customRulesPath) {
      args.push("--config", customRulesPath);
    }
  }

  // Add targets
  args.push(...targets);

  try {
    const output = await executeCommand(availability.command, args);
    const findings = parseSemgrepOutput(output);
    const counts = countFindingsBySeverity(findings);

    return {
      success: true,
      findings,
      criticalCount: counts.critical,
      warningCount: counts.warning,
      infoCount: counts.info,
    };
  } catch (error) {
    // Semgrep returns non-zero exit code when findings are present
    // Try to parse the output anyway
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if this is just findings being reported (exit code 1 with JSON output)
    try {
      const findings = parseSemgrepOutput(errorMessage);
      if (findings.length > 0) {
        const counts = countFindingsBySeverity(findings);
        return {
          success: true,
          findings,
          criticalCount: counts.critical,
          warningCount: counts.warning,
          infoCount: counts.info,
        };
      }
    } catch {
      // Not valid JSON output, real error
    }

    return {
      success: false,
      findings: [],
      criticalCount: 0,
      warningCount: 0,
      infoCount: 0,
      error: errorMessage,
    };
  }
}

/**
 * Format findings for display in QA output
 *
 * @param findings - Array of findings to format
 * @returns Formatted markdown string
 */
export function formatFindingsForDisplay(findings: SemgrepFinding[]): string {
  if (findings.length === 0) {
    return "✅ No findings";
  }

  const lines: string[] = [];
  const grouped = groupFindingsBySeverity(findings);

  if (grouped.critical.length > 0) {
    lines.push("### ❌ Critical Issues");
    lines.push("");
    for (const finding of grouped.critical) {
      lines.push(formatSingleFinding(finding));
    }
    lines.push("");
  }

  if (grouped.warning.length > 0) {
    lines.push("### ⚠️ Warnings");
    lines.push("");
    for (const finding of grouped.warning) {
      lines.push(formatSingleFinding(finding));
    }
    lines.push("");
  }

  if (grouped.info.length > 0) {
    lines.push("### ℹ️ Info");
    lines.push("");
    for (const finding of grouped.info) {
      lines.push(formatSingleFinding(finding));
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Group findings by severity
 */
function groupFindingsBySeverity(findings: SemgrepFinding[]): {
  critical: SemgrepFinding[];
  warning: SemgrepFinding[];
  info: SemgrepFinding[];
} {
  return {
    critical: findings.filter((f) => f.severity === "error"),
    warning: findings.filter((f) => f.severity === "warning"),
    info: findings.filter((f) => f.severity === "info"),
  };
}

/**
 * Format a single finding for display
 */
function formatSingleFinding(finding: SemgrepFinding): string {
  const location = `${finding.path}:${finding.line}`;
  return `- \`${location}\` - ${finding.message} (${finding.ruleId})`;
}

/**
 * Generate QA verdict contribution from Semgrep results
 *
 * @param result - Semgrep scan result
 * @returns Verdict contribution (blocking if critical findings)
 */
export function getSemgrepVerdictContribution(result: SemgrepResult): {
  blocking: boolean;
  reason: string;
} {
  if (result.skipped) {
    return {
      blocking: false,
      reason: `Semgrep skipped: ${result.skipReason}`,
    };
  }

  if (!result.success) {
    return {
      blocking: false,
      reason: `Semgrep error: ${result.error}`,
    };
  }

  if (result.criticalCount > 0) {
    return {
      blocking: true,
      reason: `${result.criticalCount} critical security finding(s) detected`,
    };
  }

  if (result.warningCount > 0) {
    return {
      blocking: false,
      reason: `${result.warningCount} warning(s) detected (review recommended)`,
    };
  }

  return {
    blocking: false,
    reason: "No security issues detected",
  };
}
