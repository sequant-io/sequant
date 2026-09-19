/**
 * sequant doctor - Check installation health
 */

import chalk from "chalk";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { readdir } from "fs/promises";
import { join as pathJoin, dirname, relative, isAbsolute } from "path";
import { ui, colors } from "../lib/cli-ui.js";
import { GitHubProvider } from "../lib/workflow/platforms/github.js";
import {
  fileExists,
  isExecutable,
  isSymlink,
  getSymlinkTarget,
} from "../lib/fs.js";
import { checkSkillsInstalled } from "../lib/skills-check.js";
import { getManifest } from "../lib/manifest.js";
import {
  commandExists,
  isGhAuthenticated,
  isNativeWindows,
  isWSL,
  checkOptionalMcpServers,
  OPTIONAL_MCP_SERVERS,
} from "../lib/system.js";
import { getPhaseMcpServersConfig } from "../lib/mcp-config.js";
import { OPENCODE_MIN_VERSION } from "../lib/workflow/drivers/opencode.js";
import { CODEX_MIN_VERSION } from "../lib/workflow/drivers/codex.js";
import { getSettings, DEFAULT_AGENT_SETTINGS } from "../lib/settings.js";
import {
  checkVersionThorough,
  getVersionWarning,
  resolveCliInvocation,
} from "../lib/version-check.js";
import { areSkillsOutdated } from "./sync.js";
import {
  readAgentsMd,
  isAgentsMdSequantOwned,
  AGENTS_MD_PATH,
} from "../lib/agents-md.js";

interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: () => Promise<void>;
}

/**
 * Wall-clock bound for the `--version` probes (#1075).
 *
 * These shell out to a local binary that should answer immediately; a probe
 * still running after this long is hung, not slow. On timeout Node kills the
 * child and throws into each probe's existing `catch`, which already reports
 * "not installed" with its install hint — so the bound needs no new handling.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Wall-clock bound for `codex login status` (#1075).
 *
 * Longer than PROBE_TIMEOUT_MS because this probe reaches the network: a
 * legitimately slow login check over a poor link must not be misreported as
 * unauthenticated. 10s bounds the hang while leaving real headroom.
 */
const AUTH_PROBE_TIMEOUT_MS = 10_000;

export interface DoctorOptions {
  skipIssueCheck?: boolean;
  /** Suppress informational warnings (e.g., upstream subagent routing notice) */
  quiet?: boolean;
}

/**
 * Warn on any `scripts/dev/*.sh` symlink whose target is missing, or resolves
 * outside both `node_modules/sequant` and the project tree — either shape
 * only worked on the machine that ran `sync` (#990).
 */
async function checkScriptsDevLinks(): Promise<Check[]> {
  const results: Check[] = [];
  const scriptsDevDir = "scripts/dev";
  if (!(await fileExists(scriptsDevDir))) return results;

  let entries: string[];
  try {
    entries = await readdir(scriptsDevDir);
  } catch {
    return results;
  }

  const projectRoot = process.cwd();
  const nodeModulesSequant = pathJoin(projectRoot, "node_modules", "sequant");

  for (const name of entries) {
    if (!name.endsWith(".sh")) continue;
    const linkPath = pathJoin(scriptsDevDir, name);
    if (!(await isSymlink(linkPath))) continue;

    const target = await getSymlinkTarget(linkPath);
    if (!target) continue;
    const resolvedTarget = isAbsolute(target)
      ? target
      : pathJoin(dirname(linkPath), target);

    if (!existsSync(resolvedTarget)) {
      results.push({
        name: "scripts/dev links",
        status: "warn",
        // #990 F4: plain `sync` already replaces an existing symlink; `--force`
        // would also overwrite a user-owned AGENTS.md — the issue's motivating bug.
        message: `${linkPath} is a dead symlink (target missing) - run: sequant sync (re-links scripts/dev without touching a user-owned AGENTS.md)`,
      });
      continue;
    }

    const insideNodeModulesSequant = !relative(
      nodeModulesSequant,
      resolvedTarget,
    ).startsWith("..");
    const insideProjectTree = !relative(projectRoot, resolvedTarget).startsWith(
      "..",
    );
    if (!insideNodeModulesSequant && !insideProjectTree) {
      results.push({
        name: "scripts/dev links",
        status: "warn",
        message: `${linkPath} points outside the project (machine-specific target) - run: sequant sync (re-links scripts/dev without touching a user-owned AGENTS.md)`,
      });
    }
  }

  return results;
}

// TODO: remove when anthropics/claude-code#43869 closes
/**
 * Upstream subagent routing bug notice (anthropics/claude-code#43869).
 * Subagent `model:` declarations are silently ignored; agents run on the
 * parent session's model. Exported as a constant so tests can match it.
 */
export const UPSTREAM_SUBAGENT_WARNING = {
  primary:
    "WARN: Claude Code #43869 — subagent model: declarations are ignored. Agents currently run on parent model.",
  url: "https://github.com/anthropics/claude-code/issues/43869",
  inertFieldNote: "Note: agents.model is currently inert (see #43869).",
} as const;

/**
 * Emit the upstream subagent-routing bug notice and (when applicable) the
 * `agents.model` inert-field note. Honors `--quiet`.
 *
 * AC-2: primary line + link, suppressible via `quiet`.
 * AC-4: when the user's `agents.model` differs from the shipped default,
 * append a second-line note flagging the field as inert.
 */
export function emitUpstreamWarning(opts: {
  quiet?: boolean;
  agentsModel: string;
  defaultAgentsModel: string;
}): void {
  if (opts.quiet) return;
  console.log("");
  console.log(chalk.yellow(`  !  ${UPSTREAM_SUBAGENT_WARNING.primary}`));
  console.log(chalk.yellow(`     ${UPSTREAM_SUBAGENT_WARNING.url}`));
  if (opts.agentsModel !== opts.defaultAgentsModel) {
    console.log(
      chalk.yellow(`     ${UPSTREAM_SUBAGENT_WARNING.inertFieldNote}`),
    );
  }
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
  const github = new GitHubProvider();
  const closedIssues = github.listClosedIssuesSync(100) as ClosedIssue[];

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
          timeout: PROBE_TIMEOUT_MS,
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

/**
 * Candidate locations for the opencode hook shim (#996 AC-2).
 *
 * `init` writes the singular `plugin/` (opencode's own convention); the plural
 * also loads on 1.18.27, so a hand-placed copy there is accepted rather than
 * reported missing.
 */
export const OPENCODE_SHIM_PATHS = [
  ".opencode/plugin/sequant-hooks.ts",
  ".opencode/plugins/sequant-hooks.ts",
] as const;

/** First shim path that exists under `projectDir`, or undefined. */
export function findOpencodeShim(projectDir: string): string | undefined {
  return OPENCODE_SHIM_PATHS.find((rel) =>
    existsSync(pathJoin(projectDir, rel)),
  );
}

/**
 * Read `opencode --version`, returning the bare semver or undefined (#862 AC-7).
 *
 * opencode prints just the version on stdout; anything else (an error, a
 * banner-only build) is reported as unknown rather than guessed at, so a
 * parse failure warns instead of blocking a working install.
 */
export function getOpencodeVersion(): string | undefined {
  try {
    const raw = execSync("opencode --version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: PROBE_TIMEOUT_MS,
    });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
    return match?.[0];
  } catch {
    return undefined;
  }
}

/**
 * Read `codex --version`, returning the bare semver or undefined (#1059 AC-4).
 * Mirrors `getOpencodeVersion`'s shape: a parse failure warns rather than
 * blocking a working install.
 */
export function getCodexVersion(): string | undefined {
  try {
    const raw = execSync("codex --version", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: PROBE_TIMEOUT_MS,
    });
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
    return match?.[0];
  } catch {
    return undefined;
  }
}

/**
 * Is codex authenticated, per #1059 AC-4(c)?
 *
 * Either `CODEX_API_KEY` is set, or `codex login status` reports a logged-in
 * session. Never logs the key's value — only whether it is set.
 */
export function isCodexAuthenticated(): boolean {
  if (process.env.CODEX_API_KEY) return true;
  try {
    const raw = execSync("codex login status", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: AUTH_PROBE_TIMEOUT_MS,
    });
    return !/not logged in/i.test(raw);
  } catch {
    return false;
  }
}

/** Numeric semver comparison — `1.9.0 < 1.18.27`, which a string compare gets wrong. */
export function isVersionBelow(version: string, floor: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10));
  const a = parse(version);
  const b = parse(floor);
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
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
          `  !  ${getVersionWarning(versionResult.currentVersion, versionResult.latestVersion, versionResult.isLocalInstall)}`,
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

  // Checks 2+3: Skills directory + core skills. Shared with the `run`
  // pre-flight via checkSkillsInstalled (#813) so the layout cannot drift.
  const coreSkills = ["spec", "exec", "qa"];
  const { skillsDirExists, missingSkills } =
    await checkSkillsInstalled(coreSkills);
  if (skillsDirExists) {
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

  // Check 3.5: Skills version (are skills in sync with package?)
  const skillsStatus = await areSkillsOutdated();
  if (skillsStatus.outdated) {
    checks.push({
      name: "Skills Version",
      status: "warn",
      message: `Outdated (${skillsStatus.currentVersion || "unknown"} → ${skillsStatus.packageVersion}) - run: ${resolveCliInvocation()} sync`,
    });
  } else {
    checks.push({
      name: "Skills Version",
      status: "pass",
      message: `Up to date (${skillsStatus.packageVersion})`,
    });
  }

  // Check: AGENTS.md presence and ownership (#990). Ownership is determined
  // by the marker `generateAgentsMd` writes, not by diffing against
  // CLAUDE.md — see agents-md.ts's `decideAgentsMdSync` design note.
  const agentsMdContent = await readAgentsMd();
  if (agentsMdContent) {
    if (isAgentsMdSequantOwned(agentsMdContent)) {
      checks.push({
        name: "AGENTS.md",
        status: "pass",
        message: "Present and up to date",
      });
    } else {
      checks.push({
        name: "AGENTS.md",
        status: "warn",
        message:
          "user-owned (preserved by sync) - customized or predates the ownership marker",
      });
    }
  } else if (manifest) {
    checks.push({
      name: "AGENTS.md",
      status: "warn",
      // `sync` never creates a missing AGENTS.md (decideAgentsMdSync → "none"), so
      // only init can restore it.
      message: `Missing ${AGENTS_MD_PATH} - run: sequant init --force (sync never creates a missing AGENTS.md)`,
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

  // Check 5.5: scripts/dev symlink health (#990) - a link whose target is
  // missing or resolves outside both node_modules/sequant and the project
  // tree only worked on the machine that ran `sync`.
  for (const linkCheck of await checkScriptsDevLinks()) {
    checks.push(linkCheck);
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

  // Check: Aider CLI (when configured as agent)
  const settings = await getSettings();
  if (settings.run.agent === "aider") {
    if (commandExists("aider")) {
      checks.push({
        name: "Aider CLI",
        status: "pass",
        message: "aider CLI is installed (configured as default agent)",
      });
    } else {
      checks.push({
        name: "Aider CLI",
        status: "fail",
        message:
          "aider CLI not installed but configured as default agent - install: pip install aider-chat",
      });
    }
  }

  // Check: opencode CLI + pinned minimum version (when configured as agent).
  // The floor is not cosmetic — opencode ships 800+ releases and several
  // load-bearing surfaces this driver depends on (`run --command`, the skill
  // tool's `state.metadata`) were undocumented at the version it was verified
  // against (#862, #992).
  if (settings.run.agent === "opencode") {
    if (!commandExists("opencode")) {
      checks.push({
        name: "opencode CLI",
        status: "fail",
        message:
          "opencode CLI not installed but configured as default agent - install: npm i -g opencode-ai",
      });
    } else {
      const version = getOpencodeVersion();
      if (!version) {
        checks.push({
          name: "opencode CLI",
          status: "warn",
          message: `opencode is installed but its version could not be read (sequant verified against ${OPENCODE_MIN_VERSION})`,
        });
      } else if (isVersionBelow(version, OPENCODE_MIN_VERSION)) {
        checks.push({
          name: "opencode CLI",
          status: "fail",
          message: `opencode ${version} is below the minimum supported ${OPENCODE_MIN_VERSION} - upgrade: npm i -g opencode-ai@latest`,
        });
      } else {
        checks.push({
          name: "opencode CLI",
          status: "pass",
          message: `opencode ${version} is installed (configured as default agent, minimum ${OPENCODE_MIN_VERSION})`,
        });
      }
    }

    // #996 AC-2: the hook shim is the only thing giving an opencode phase the
    // same force-push/commit/worktree guards a Claude Code phase gets. Without
    // it the phase runs unguarded and silently, so its absence is a fail.
    const pluginPath = findOpencodeShim(".");
    if (!pluginPath) {
      checks.push({
        name: "opencode hook shim",
        status: "fail",
        message:
          `${OPENCODE_SHIM_PATHS[0]} not found - opencode phases would run with no ` +
          `force-push, commit, or worktree guards. Install: sequant init --agent opencode`,
      });
    } else {
      checks.push({
        name: "opencode hook shim",
        status: "pass",
        message: `hook shim present at ${pluginPath}`,
      });
    }

    // `--pure` runs opencode without external plugins, which disables the shim
    // above along with it — the guards would be off while the file is still on
    // disk, so the check above alone cannot catch this.
    const extraArgs = settings.run.opencode?.extraArgs ?? [];
    if (extraArgs.includes("--pure")) {
      checks.push({
        name: "opencode --pure",
        status: "fail",
        message:
          "run.opencode.extraArgs contains --pure, which runs opencode without external " +
          "plugins. The sequant hook shim would not load and every guard would be off. " +
          "Remove --pure from extraArgs.",
      });
    }
  }

  // Check: codex CLI + pinned minimum version + auth (when configured as
  // agent) (#1059 AC-4). Mirrors the opencode block above in structure.
  if (settings.run.agent === "codex") {
    if (!commandExists("codex")) {
      checks.push({
        name: "codex CLI",
        status: "fail",
        message:
          "codex CLI not installed but configured as default agent - install: npm i -g @openai/codex",
      });
    } else {
      const version = getCodexVersion();
      if (!version) {
        checks.push({
          name: "codex CLI",
          status: "warn",
          message: `codex is installed but its version could not be read (sequant verified against ${CODEX_MIN_VERSION})`,
        });
      } else if (isVersionBelow(version, CODEX_MIN_VERSION)) {
        checks.push({
          name: "codex CLI",
          status: "fail",
          message: `codex ${version} is below the minimum supported ${CODEX_MIN_VERSION} - upgrade: npm i -g @openai/codex`,
        });
      } else {
        checks.push({
          name: "codex CLI",
          status: "pass",
          message: `codex ${version} is installed (configured as default agent, minimum ${CODEX_MIN_VERSION})`,
        });
      }
    }

    // Never log CODEX_API_KEY's value — only whether an authenticated path
    // was found at all.
    if (isCodexAuthenticated()) {
      checks.push({
        name: "codex auth",
        status: "pass",
        message:
          "codex is authenticated (CODEX_API_KEY set or codex login status reports logged in)",
      });
    } else {
      checks.push({
        name: "codex auth",
        status: "fail",
        message:
          "codex is not authenticated - set CODEX_API_KEY, or run: codex login",
      });
    }
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

  // Check: MCP availability for headless mode (sequant run) (#936)
  //
  // Phase agents read the project's .mcp.json + settings.run.mcpAllowlist,
  // never Claude Desktop config wholesale — see getPhaseMcpServersConfig.
  // The sequant server is always guaranteed, so this check reports what a
  // phase will actually receive rather than pass/warn on presence.
  const phaseServersConfig = getPhaseMcpServersConfig(process.cwd(), {
    desktopAllowlist: settings.run.mcpAllowlist,
  });
  const phaseServerCount = Object.keys(phaseServersConfig).length;
  const extraServerCount = phaseServerCount - 1; // minus the guaranteed sequant entry
  checks.push({
    name: "MCP Servers (headless)",
    status: "pass",
    message:
      extraServerCount > 0
        ? `Available for sequant run (${phaseServerCount} servers: sequant + ${extraServerCount} from .mcp.json${settings.run.mcpAllowlist?.length ? "/mcpAllowlist" : ""})`
        : "Available for sequant run (sequant only — add servers to .mcp.json, or settings.run.mcpAllowlist for desktop servers, for more)",
  });

  // Check: Sequant MCP server health
  try {
    // Verify MCP server can be created (validates SDK availability)
    const { createServer } = await import("../mcp/server.js");
    const { getVersion } = await import("../lib/version.js");
    const mcpServerInstance = createServer(getVersion());
    await mcpServerInstance.close();
    checks.push({
      name: "MCP Server",
      status: "pass",
      message: "Sequant MCP server can be started (sequant serve)",
    });
  } catch (error) {
    checks.push({
      name: "MCP Server",
      status: "warn",
      message: `Sequant MCP server unavailable: ${error instanceof Error ? error.message : String(error)}`,
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

  // Upstream subagent routing notice (AC-2/AC-4)
  emitUpstreamWarning({
    quiet: options.quiet,
    agentsModel: settings.agents.model,
    defaultAgentsModel: DEFAULT_AGENT_SETTINGS.model,
  });

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
