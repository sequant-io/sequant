/**
 * Main assessment module for upstream analysis
 * Coordinates release fetching, analysis, and output generation
 */

import { spawn } from "node:child_process";
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AssessmentOptions,
  Baseline,
  BatchedAssessment,
  ReleaseData,
  UpstreamAssessment,
} from "./types.js";
import { analyzeRelease, getActionableFindings } from "./relevance.js";
import {
  calculateSummary,
  generateAssessmentReport,
  generateBatchedSummaryReport,
  generateLocalReport,
} from "./report.js";
import { createAssessmentIssue, createOrLinkFinding } from "./issues.js";

/**
 * Regex pattern for valid semantic version strings
 * Matches: v1.2.3, 1.2.3, v1.2.3-beta.1, v1.2.3-rc1, etc.
 */
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(-[\w.]+)?$/;

/**
 * Validate a version string to prevent command injection
 * @throws Error if version format is invalid
 */
export function validateVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      `Invalid version format: "${version}". Expected semver format (e.g., v1.2.3 or 1.2.3-beta.1)`,
    );
  }
}

/**
 * Execute a command safely using spawn with argument arrays
 * This prevents command injection by not using shell interpolation
 */
async function execCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Check if gh CLI is available and authenticated
 * @returns Object with availability status and error message if not available
 */
export async function checkGhCliAvailable(): Promise<{
  available: boolean;
  authenticated: boolean;
  error?: string;
}> {
  try {
    // Check if gh is installed
    await execCommand("gh", ["--version"]);
  } catch {
    return {
      available: false,
      authenticated: false,
      error:
        "GitHub CLI (gh) is not installed. Install from: https://cli.github.com/",
    };
  }

  try {
    // Check if gh is authenticated
    await execCommand("gh", ["auth", "status"]);
    return { available: true, authenticated: true };
  } catch {
    return {
      available: true,
      authenticated: false,
      error: "GitHub CLI is not authenticated. Run: gh auth login",
    };
  }
}

/**
 * Default paths for upstream files
 */
const BASELINE_PATH = ".sequant/upstream/baseline.json";
const REPORTS_DIR = ".sequant/upstream";

/**
 * Fetch release data from Claude Code repository
 */
export async function fetchRelease(
  version?: string,
): Promise<ReleaseData | null> {
  try {
    // Validate version if provided to prevent injection
    if (version) {
      validateVersion(version);
    }

    // Build args array safely - no shell interpolation
    const args = ["release", "view"];
    if (version) {
      args.push(version);
    }
    args.push(
      "--repo",
      "anthropics/claude-code",
      "--json",
      "tagName,name,body,publishedAt",
    );

    const { stdout } = await execCommand("gh", args);
    return JSON.parse(stdout) as ReleaseData;
  } catch (error) {
    console.error("Error fetching release:", error);
    return null;
  }
}

/**
 * List releases from Claude Code repository
 */
export async function listReleases(
  limit: number = 50,
): Promise<Array<{ tagName: string; publishedAt: string }>> {
  try {
    // Validate limit is a reasonable positive integer
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Limit must be an integer between 1 and 100");
    }

    const { stdout } = await execCommand("gh", [
      "release",
      "list",
      "--repo",
      "anthropics/claude-code",
      "--limit",
      String(limit),
      "--json",
      "tagName,publishedAt",
    ]);

    return JSON.parse(stdout) as Array<{
      tagName: string;
      publishedAt: string;
    }>;
  } catch (error) {
    console.error("Error listing releases:", error);
    return [];
  }
}

/**
 * Get releases since a specific version
 */
export async function getReleasesSince(
  sinceVersion: string,
): Promise<string[]> {
  const releases = await listReleases();

  const versions: string[] = [];
  for (const release of releases) {
    if (release.tagName === sinceVersion) {
      break;
    }
    versions.push(release.tagName);
  }

  return versions.reverse(); // Oldest first
}

/**
 * Load baseline from file
 */
export async function loadBaseline(
  path: string = BASELINE_PATH,
): Promise<Baseline> {
  try {
    const content = await readFile(path, "utf-8");
    return JSON.parse(content) as Baseline;
  } catch {
    // Return default baseline if file doesn't exist
    console.warn("Baseline not found, using defaults");
    return getDefaultBaseline();
  }
}

/**
 * Save baseline to file
 */
export async function saveBaseline(
  baseline: Baseline,
  path: string = BASELINE_PATH,
): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify(baseline, null, 2));
}

/**
 * Update baseline with new assessed version
 */
export async function updateBaseline(
  version: string,
  path: string = BASELINE_PATH,
): Promise<void> {
  const baseline = await loadBaseline(path);
  baseline.lastAssessedVersion = version;
  await saveBaseline(baseline, path);
}

/**
 * Check if a version has already been assessed
 */
export async function isAlreadyAssessed(version: string): Promise<boolean> {
  const reportPath = join(REPORTS_DIR, `${version}.md`);
  try {
    await access(reportPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save local report
 */
export async function saveLocalReport(
  assessment: UpstreamAssessment,
): Promise<string> {
  const reportPath = join(REPORTS_DIR, `${assessment.version}.md`);
  await ensureDir(REPORTS_DIR);

  const content = generateLocalReport(assessment);
  await writeFile(reportPath, content);

  return reportPath;
}

/**
 * Run a single version assessment
 */
export async function assessVersion(
  version: string,
  options: AssessmentOptions = {},
): Promise<UpstreamAssessment | null> {
  const { dryRun = false, force = false } = options;

  // Check if already assessed
  if (!force && (await isAlreadyAssessed(version))) {
    console.log(`Already assessed: ${version}. Use --force to re-assess.`);
    return null;
  }

  // Fetch release
  const release = await fetchRelease(version);
  if (!release) {
    console.error(`Failed to fetch release: ${version}`);
    return null;
  }

  // Load baseline
  const baseline = await loadBaseline();

  // Analyze
  const findings = analyzeRelease(release.body, baseline);
  const actionableFindings = getActionableFindings(findings);

  // Create assessment object
  const assessment: UpstreamAssessment = {
    version: release.tagName,
    releaseDate: release.publishedAt.split("T")[0],
    assessmentDate: new Date().toISOString().split("T")[0],
    previousVersion: baseline.lastAssessedVersion,
    findings,
    issuesCreated: [],
    summary: calculateSummary(findings),
    dryRun,
  };

  // Create assessment issue first (to get issue number for linking)
  const assessmentBody = generateAssessmentReport(assessment);
  const assessmentIssueNumber = await createAssessmentIssue(
    `Upstream: Claude Code ${release.tagName} Assessment`,
    assessmentBody,
    dryRun,
  );

  // Create issues for actionable findings
  for (let i = 0; i < actionableFindings.length; i++) {
    const updatedFinding = await createOrLinkFinding(
      actionableFindings[i],
      release.tagName,
      assessmentIssueNumber,
      dryRun,
    );

    // Update in original findings array
    const originalIndex = findings.findIndex(
      (f) => f.description === updatedFinding.description,
    );
    if (originalIndex >= 0) {
      findings[originalIndex] = updatedFinding;
    }

    if (updatedFinding.issueNumber) {
      assessment.issuesCreated.push(updatedFinding.issueNumber);
    }
  }

  // Save local report
  await saveLocalReport(assessment);

  // Update baseline
  if (!dryRun) {
    await updateBaseline(release.tagName);
  }

  return assessment;
}

/**
 * Run assessment for latest release
 */
export async function assessLatest(
  options: AssessmentOptions = {},
): Promise<UpstreamAssessment | null> {
  const release = await fetchRelease();
  if (!release) {
    console.error("Failed to fetch latest release");
    return null;
  }

  return assessVersion(release.tagName, options);
}

/**
 * Run batched assessment for multiple versions
 */
export async function assessSince(
  sinceVersion: string,
  options: AssessmentOptions = {},
): Promise<BatchedAssessment | null> {
  const { dryRun = false } = options;

  const versions = await getReleasesSince(sinceVersion);
  if (versions.length === 0) {
    console.log(`No new versions since ${sinceVersion}`);
    return null;
  }

  console.log(
    `Found ${versions.length} versions to assess: ${versions.join(", ")}`,
  );

  const assessments: UpstreamAssessment[] = [];

  for (const version of versions) {
    const assessment = await assessVersion(version, {
      ...options,
      force: true,
    });
    if (assessment) {
      assessments.push(assessment);
    }
  }

  if (assessments.length === 0) {
    return null;
  }

  const batched: BatchedAssessment = {
    versions,
    assessments,
    sinceVersion,
    toVersion: versions[versions.length - 1],
  };

  // Create summary issue
  if (!dryRun) {
    const summaryBody = generateBatchedSummaryReport(batched);
    const summaryIssue = await createAssessmentIssue(
      `Upstream: Claude Code Assessment (${sinceVersion} → ${batched.toVersion})`,
      summaryBody,
      dryRun,
    );
    batched.summaryIssueNumber = summaryIssue;
  }

  return batched;
}

/**
 * Main entry point for upstream assessment
 */
export async function runUpstream(
  options: AssessmentOptions = {},
): Promise<UpstreamAssessment | BatchedAssessment | null> {
  const { version, since } = options;

  if (since) {
    return assessSince(since, options);
  }

  if (version) {
    return assessVersion(version, options);
  }

  return assessLatest(options);
}

/**
 * Get default baseline when none exists
 */
function getDefaultBaseline(): Baseline {
  return {
    lastAssessedVersion: null,
    schemaVersion: "1.0.0",
    tools: {
      core: [
        "Task",
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "TodoWrite",
      ],
      optional: ["WebFetch", "WebSearch", "NotebookEdit", "AskUserQuestion"],
    },
    hooks: {
      used: ["PreToolUse"],
      files: ["src/hooks/pre-tool-hook.ts"],
    },
    mcpServers: {
      required: [],
      optional: ["chrome-devtools", "context7", "sequential-thinking"],
    },
    permissions: {
      patterns: ["Bash(*)", "Task(*)", "Edit(*)"],
      files: [".claude/settings.json"],
    },
    keywords: [
      "Task",
      "Bash",
      "hook",
      "PreToolUse",
      "PostToolUse",
      "MCP",
      "permission",
      "allow",
      "deny",
      "tool",
      "background",
      "parallel",
      "agent",
      "subagent",
    ],
    dependencyMap: {
      permission: [".claude/settings.json"],
      hook: ["src/hooks/pre-tool-hook.ts"],
      Task: [".claude/skills/**/*.md"],
      MCP: [".claude/settings.json"],
    },
  };
}

/**
 * Ensure directory exists
 */
async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Directory may already exist
  }
}
