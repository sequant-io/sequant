/**
 * sequant doctor - Check installation health
 */

import chalk from "chalk";
import { execSync } from "child_process";
import { ui, colors } from "../lib/cli-ui.js";
import { fileExists, isExecutable } from "../lib/fs.js";
import { getManifest } from "../lib/manifest.js";
import {
  commandExists,
  isGhAuthenticated,
  isNativeWindows,
  isWSL,
  checkOptionalMcpServers,
  getMcpServersConfig,
  OPTIONAL_MCP_SERVERS,
} from "../lib/system.js";
import {
  checkVersionThorough,
  getVersionWarning,
} from "../lib/version-check.js";

interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: () => Promise<void>;
}

export interface DoctorOptions {
  skipIssueCheck?: boolean;
}

/**
 * Labels that indicate an issue should be skipped from closed-issue verification
 * (case-insensitive matching)
 */
const SKIP_ISSUE_LABELS = [
  "wontfix",
  "won't fix",
  "duplicate",
  "invalid",
  "question",
  "documentation",
  "docs",
];

interface ClosedIssue {
  number: number;
  title: string;
  closedAt: string;
  labels: Array<{ name: string }>;
}

/**
 * Check recently closed issues for missing commits in main branch
 * Returns issues that were closed but have no commit referencing them
 */
export function checkClosedIssues(): ClosedIssue[] {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoISO = sevenDaysAgo.toISOString();

  // Fetch closed issues from last 7 days
  let closedIssues: ClosedIssue[];
  try {
    const output = execSync(
      `gh issue list --state closed --json number,title,closedAt,labels --limit 100`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    closedIssues = JSON.parse(output) as ClosedIssue[];
  } catch {
    // gh command failed - return empty (graceful degradation)
    return [];
  }

  // Filter to last 7 days
  const recentIssues = closedIssues.filter(
    (issue) => issue.closedAt >= sevenDaysAgoISO,
  );

  // Filter out issues with skip labels
  const issuesToCheck = recentIssues.filter((issue) => {
    const labels = issue.labels.map((l) => l.name.toLowerCase());
    return !SKIP_ISSUE_LABELS.some((skipLabel) =>
      labels.some((label) => label.includes(skipLabel.toLowerCase())),
    );
  });

  // Check each issue for a commit in main
  const missingCommitIssues: ClosedIssue[] = [];
  for (const issue of issuesToCheck) {
    try {
      // Look for commit mentioning this issue number
      const result = execSync(
        `git log --oneline --grep="#${issue.number}" -1`,
        {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      // If no output, no commit found
      if (!result.trim()) {
        missingCommitIssues.push(issue);
      }
    } catch {
      // git log failed or no match - treat as missing
      missingCommitIssues.push(issue);
    }
  }

  return missingCommitIssues;
}

export async function doctorCommand(
  options: DoctorOptions = {},
): Promise<void> {
  console.log(ui.headerBox("SEQUANT HEALTH CHECK"));
  console.log();

  const checks: Check[] = [];
  // Track gh availability and auth for conditional checks later
  let ghAvailable = false;
  let ghAuthenticated = false;

  // Check 0: Version freshness
  const versionResult = await checkVersionThorough();
  if (versionResult.latestVersion) {
    if (versionResult.isOutdated) {
      checks.push({
        name: "Version",
        status: "warn",
        message: `Outdated: ${versionResult.currentVersion} → ${versionResult.latestVersion} available`,
      });
      // Show remediation steps
      console.log(
        chalk.yellow(
          `  ⚠️  ${getVersionWarning(versionResult.currentVersion, versionResult.latestVersion, versionResult.isLocalInstall)}`,
        ),
      );
      console.log("");
    } else {
      checks.push({
        name: "Version",
        status: "pass",
        message: `Up to date (${versionResult.currentVersion})`,
      });
    }
  } else {
    // Could not fetch version - skip this check silently (graceful degradation)
    checks.push({
      name: "Version",
      status: "pass",
      message: `${versionResult.currentVersion} (could not verify latest)`,
    });
  }

  // Check 1: Manifest exists
  const manifest = await getManifest();
  if (manifest) {
    checks.push({
      name: "Manifest",
      status: "pass",
      message: `Found .sequant-manifest.json (v${manifest.version})`,
    });
  } else {
    checks.push({
      name: "Manifest",
      status: "fail",
      message: "Missing .sequant-manifest.json - run `sequant init`",
    });
  }

  // Check 2: Skills directory
  const skillsExist = await fileExists(".claude/skills");
  if (skillsExist) {
    checks.push({
      name: "Skills",
      status: "pass",
      message: "Skills directory exists",
    });
  } else {
    checks.push({
      name: "Skills",
      status: "fail",
      message: "Missing .claude/skills/ directory",
    });
  }

  // Check 3: Core skills present
  const coreSkills = ["spec", "exec", "qa"];
  const missingSkills: string[] = [];
  for (const skill of coreSkills) {
    if (!(await fileExists(`.claude/skills/${skill}/SKILL.md`))) {
      missingSkills.push(skill);
    }
  }
  if (missingSkills.length === 0) {
    checks.push({
      name: "Core Skills",
      status: "pass",
      message: "All core skills present (spec, exec, qa)",
    });
  } else {
    checks.push({
      name: "Core Skills",
      status: "fail",
      message: `Missing skills: ${missingSkills.join(", ")}`,
    });
  }

  // Check 4: Hooks directory
  const hooksExist = await fileExists(".claude/hooks");
  if (hooksExist) {
    checks.push({
      name: "Hooks",
      status: "pass",
      message: "Hooks directory exists",
    });
  } else {
    checks.push({
      name: "Hooks",
      status: "warn",
      message: "No hooks directory (optional but recommended)",
    });
  }

  // Check 5: Hook scripts executable
  const preToolHook = ".claude/hooks/pre-tool.sh";
  if (await fileExists(preToolHook)) {
    if (await isExecutable(preToolHook)) {
      checks.push({
        name: "Hook Permissions",
        status: "pass",
        message: "Hook scripts are executable",
      });
    } else {
      checks.push({
        name: "Hook Permissions",
        status: "warn",
        message:
          "Hook scripts not executable - run: chmod +x .claude/hooks/*.sh",
      });
    }
  }

  // Check 6: Settings.json
  const settingsExist = await fileExists(".claude/settings.json");
  if (settingsExist) {
    checks.push({
      name: "Settings",
      status: "pass",
      message: "Settings file exists",
    });
  } else {
    checks.push({
      name: "Settings",
      status: "warn",
      message: "No settings.json (hooks won't be triggered)",
    });
  }

  // Check 7: Git repo
  const gitExists = await fileExists(".git");
  if (gitExists) {
    checks.push({
      name: "Git Repository",
      status: "pass",
      message: "Git repository detected",
    });
  } else {
    checks.push({
      name: "Git Repository",
      status: "warn",
      message: "Not a git repository (worktree features won't work)",
    });
  }

  // Check 8: GitHub CLI installed
  if (commandExists("gh")) {
    ghAvailable = true;
    checks.push({
      name: "GitHub CLI",
      status: "pass",
      message: "gh CLI is installed",
    });

    // Check 9: GitHub CLI authenticated (only if gh exists)
    if (isGhAuthenticated()) {
      ghAuthenticated = true;
      checks.push({
        name: "GitHub Auth",
        status: "pass",
        message: "gh CLI is authenticated",
      });
    } else {
      checks.push({
        name: "GitHub Auth",
        status: "fail",
        message: "gh CLI not authenticated - run: gh auth login",
      });
    }
  } else {
    checks.push({
      name: "GitHub CLI",
      status: "fail",
      message: "gh CLI not installed - see: https://cli.github.com",
    });
  }

  // Check 10: Claude Code CLI installed (critical)
  if (commandExists("claude")) {
    checks.push({
      name: "Claude Code CLI",
      status: "pass",
      message: "claude CLI is installed",
    });
  } else {
    checks.push({
      name: "Claude Code CLI",
      status: "fail",
      message:
        "claude CLI not installed - see: https://docs.anthropic.com/en/docs/claude-code",
    });
  }

  // Check 12: jq installed (optional but recommended)
  if (commandExists("jq")) {
    checks.push({
      name: "jq",
      status: "pass",
      message: "jq is installed (faster JSON parsing in hooks)",
    });
  } else {
    checks.push({
      name: "jq",
      status: "warn",
      message: "jq not installed (optional, hooks will use grep fallback)",
    });
  }

  // Check 13: Windows platform detection
  if (isNativeWindows()) {
    checks.push({
      name: "Platform",
      status: "warn",
      message:
        "Running on native Windows - WSL recommended for full functionality (hooks, scripts)",
    });
  } else if (isWSL()) {
    checks.push({
      name: "Platform",
      status: "pass",
      message: "Running in WSL - full functionality available",
    });
  }
  // On macOS/Linux, don't add a platform check (not relevant)

  // Check 12: Optional MCP servers
  const mcpStatus = checkOptionalMcpServers();
  const configuredMcps = OPTIONAL_MCP_SERVERS.filter(
    (s) => mcpStatus[s.name],
  ).map((s) => s.name);
  const missingMcps = OPTIONAL_MCP_SERVERS.filter((s) => !mcpStatus[s.name]);

  if (configuredMcps.length === OPTIONAL_MCP_SERVERS.length) {
    checks.push({
      name: "MCP Servers",
      status: "pass",
      message: `All optional MCPs configured (${configuredMcps.join(", ")})`,
    });
  } else if (configuredMcps.length > 0) {
    checks.push({
      name: "MCP Servers",
      status: "pass",
      message: `Some MCPs configured: ${configuredMcps.join(", ")}`,
    });
    for (const mcp of missingMcps) {
      checks.push({
        name: `MCP: ${mcp.name}`,
        status: "warn",
        message: `Not configured (optional, enhances ${mcp.skills.join(", ")})`,
      });
    }
  } else {
    checks.push({
      name: "MCP Servers",
      status: "warn",
      message:
        "No optional MCPs configured (Sequant works without them, but they enhance functionality)",
    });
  }

  // Check: MCP availability for headless mode (sequant run)
  const mcpServersConfig = getMcpServersConfig();
  if (mcpServersConfig) {
    const serverCount = Object.keys(mcpServersConfig).length;
    checks.push({
      name: "MCP Servers (headless)",
      status: "pass",
      message: `Available for sequant run (${serverCount} server${serverCount !== 1 ? "s" : ""} configured)`,
    });
  } else {
    checks.push({
      name: "MCP Servers (headless)",
      status: "warn",
      message:
        "Not available for sequant run (no Claude Desktop config found or empty mcpServers)",
    });
  }

  // Check: Closed issue verification (only if gh available, authenticated, and not skipped)
  if (!options.skipIssueCheck && ghAvailable && ghAuthenticated && gitExists) {
    const missingCommitIssues = checkClosedIssues();
    if (missingCommitIssues.length === 0) {
      checks.push({
        name: "Closed Issues",
        status: "pass",
        message: "All recently closed issues have commits in main",
      });
    } else {
      // Add a warning for each issue missing commits
      for (const issue of missingCommitIssues) {
        checks.push({
          name: `Issue #${issue.number}`,
          status: "warn",
          message: `Closed but no commit found in main: "${issue.title}"`,
        });
      }
    }
  }

  // Display results with status icons
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;

  for (const check of checks) {
    const statusType =
      check.status === "pass"
        ? "success"
        : check.status === "warn"
          ? "warning"
          : "error";
    const color =
      check.status === "pass"
        ? colors.success
        : check.status === "warn"
          ? colors.warning
          : colors.error;

    console.log(
      `  ${ui.statusIcon(statusType as "success" | "warning" | "error")} ${chalk.bold(check.name)}: ${color(check.message)}`,
    );

    if (check.status === "pass") passCount++;
    else if (check.status === "warn") warnCount++;
    else failCount++;
  }

  // Summary with boxed output
  const totalChecks = passCount + warnCount + failCount;
  let summaryTitle: string;
  let summaryMessage: string;

  if (failCount > 0) {
    summaryTitle = `${failCount} check${failCount > 1 ? "s" : ""} failed`;
    summaryMessage = `Passed: ${passCount}/${totalChecks}\nWarnings: ${warnCount}\nFailed: ${failCount}\n\nRun \`sequant init\` to fix issues.`;
    console.log("\n" + ui.errorBox(summaryTitle, summaryMessage));
    process.exit(1);
  } else if (warnCount > 0) {
    summaryTitle = `All checks passed (${warnCount} warning${warnCount > 1 ? "s" : ""})`;
    summaryMessage = `Passed: ${passCount}/${totalChecks}\nWarnings: ${warnCount}\n\nSequant should work correctly.`;
    console.log("\n" + ui.warningBox(summaryTitle, summaryMessage));
  } else {
    summaryTitle = `All ${totalChecks} checks passed!`;
    summaryMessage = `Your Sequant installation is healthy.`;
    console.log("\n" + ui.successBox(summaryTitle, summaryMessage));
  }
}
