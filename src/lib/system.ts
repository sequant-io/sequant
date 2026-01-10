/**
 * System utility functions for checking prerequisites
 */

import { execSync } from "child_process";
import fs from "fs";

/**
 * Check if a command exists on the system
 */
export function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if gh CLI is authenticated
 */
export function isGhAuthenticated(): boolean {
  try {
    execSync("gh auth status", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if running in Windows Subsystem for Linux (WSL)
 */
export function isWSL(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const procVersion = fs.readFileSync("/proc/version", "utf8");
    return (
      procVersion.toLowerCase().includes("microsoft") ||
      procVersion.toLowerCase().includes("wsl")
    );
  } catch {
    return false;
  }
}

/**
 * Check if running on native Windows (not WSL)
 */
export function isNativeWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Get platform-specific install hint for a package
 */
export function getInstallHint(pkg: string): string {
  const platform = process.platform;

  const hints: Record<string, Record<string, string>> = {
    jq: {
      darwin: "brew install jq",
      linux: "apt install jq  # or: yum install jq",
      win32: "choco install jq  # or: scoop install jq",
    },
    gh: {
      darwin: "brew install gh",
      linux: "apt install gh  # see: https://cli.github.com",
      win32: "choco install gh  # or: winget install GitHub.cli",
    },
  };

  const pkgHints = hints[pkg];
  if (!pkgHints) {
    return `Install ${pkg}`;
  }

  return pkgHints[platform] || pkgHints["linux"] || `Install ${pkg}`;
}

/**
 * MCP server information for Sequant integrations
 */
export interface McpServerInfo {
  name: string;
  purpose: string;
  skills: string[];
  installUrl: string;
}

/**
 * Optional MCP servers that enhance Sequant functionality
 */
export const OPTIONAL_MCP_SERVERS: McpServerInfo[] = [
  {
    name: "chrome-devtools",
    purpose: "Browser automation for UI testing",
    skills: ["/test", "/testgen", "/loop"],
    installUrl:
      "https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-chrome-devtools",
  },
  {
    name: "context7",
    purpose: "External library documentation lookup",
    skills: ["/exec", "/fullsolve"],
    installUrl: "https://github.com/upstash/context7",
  },
  {
    name: "sequential-thinking",
    purpose: "Complex multi-step reasoning",
    skills: ["/fullsolve"],
    installUrl:
      "https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-sequential-thinking",
  },
];

/**
 * Get the path to Claude Desktop config file
 */
export function getClaudeConfigPath(): string {
  const platform = process.platform;
  const home = process.env.HOME || process.env.USERPROFILE || "";

  if (platform === "darwin") {
    return `${home}/Library/Application Support/Claude/claude_desktop_config.json`;
  } else if (platform === "win32") {
    return `${process.env.APPDATA}\\Claude\\claude_desktop_config.json`;
  } else {
    // Linux
    return `${home}/.config/claude/claude_desktop_config.json`;
  }
}

/**
 * Read configured MCP servers from Claude Desktop config
 */
export function getConfiguredMcpServers(): string[] {
  const configPath = getClaudeConfigPath();

  try {
    const content = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(content);
    const servers = config.mcpServers || {};
    return Object.keys(servers);
  } catch {
    // Config file doesn't exist or is invalid
    return [];
  }
}

/**
 * Check which optional MCP servers are configured
 * Returns an object with server names as keys and configured status as values
 */
export function checkOptionalMcpServers(): Record<string, boolean> {
  const configuredServers = getConfiguredMcpServers();
  const result: Record<string, boolean> = {};

  for (const server of OPTIONAL_MCP_SERVERS) {
    // Check for various naming conventions
    const found = configuredServers.some(
      (configured) =>
        configured.toLowerCase().includes(server.name.toLowerCase()) ||
        server.name.toLowerCase().includes(configured.toLowerCase()),
    );
    result[server.name] = found;
  }

  return result;
}
