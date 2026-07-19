/**
 * MCP client detection and configuration
 *
 * Detects installed MCP clients (Claude Desktop, Cursor, VS Code)
 * and generates appropriate configuration entries for Sequant MCP server.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getVersion } from "./version.js";

/** Path to the project-level MCP config file used by Claude Code */
export const PROJECT_MCP_JSON = ".mcp.json";

/**
 * npm package specifier used to launch the MCP server (#793).
 *
 * We pin to the installed version rather than `@latest` so that `npx` does not
 * re-resolve and reinstall the package on the first MCP reconnect after every
 * sequant release — the reinstall was surfacing as an opaque
 * `Failed to reconnect to sequant: -32000` when npx's cache was corrupted
 * (npm ENOTEMPTY). `setup`/`update` (re)write this pin, so the MCP server
 * tracks new releases when the user runs `sequant update` — matching how the
 * plugin cache already pins. See docs/troubleshooting.md ("MCP Server Issues").
 *
 * Falls back to `latest` if the installed version cannot be resolved, so a
 * failed lookup never writes a bogus `sequant@0.0.0` pin into `.mcp.json`.
 */
export function getSequantPackageSpec(): string {
  const version = getVersion();
  return version && version !== "0.0.0"
    ? `sequant@${version}`
    : "sequant@latest";
}

export type McpClientType = "claude-desktop" | "cursor" | "vscode-continue";

export interface McpClientInfo {
  name: string;
  clientType: McpClientType;
  configPath: string;
  exists: boolean;
}

/**
 * Clients that need an explicit cwd because they don't run from the project directory.
 */
const CLIENTS_NEEDING_CWD: ReadonlySet<McpClientType> = new Set([
  "claude-desktop",
  "vscode-continue",
]);

/**
 * Sequant MCP server configuration entry.
 *
 * @param options.projectDir - Absolute project path (used as cwd for clients that need it)
 * @param options.clientType - Target client; determines whether cwd/env are included
 */
export function getSequantMcpConfig(options?: {
  projectDir?: string;
  clientType?: McpClientType;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    command: "npx",
    args: ["-y", getSequantPackageSpec(), "serve"],
  };

  // Add cwd for clients that don't run from the project directory
  if (options?.clientType && CLIENTS_NEEDING_CWD.has(options.clientType)) {
    config.cwd = options.projectDir ?? process.cwd();
  }

  // Only include ANTHROPIC_API_KEY for global client configs (not .mcp.json,
  // which is committed to git and must never contain secrets).
  if (options?.clientType && process.env.ANTHROPIC_API_KEY) {
    config.env = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  }

  return config;
}

/**
 * Detect which MCP-compatible clients are installed
 */
export function detectMcpClients(): McpClientInfo[] {
  const clients: McpClientInfo[] = [];
  const home = os.homedir();

  // Claude Desktop
  const claudeDesktopConfig =
    process.platform === "darwin"
      ? path.join(
          home,
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        )
      : process.platform === "win32"
        ? path.join(
            home,
            "AppData",
            "Roaming",
            "Claude",
            "claude_desktop_config.json",
          )
        : path.join(home, ".config", "claude", "claude_desktop_config.json");

  clients.push({
    name: "Claude Desktop",
    clientType: "claude-desktop",
    configPath: claudeDesktopConfig,
    exists: fs.existsSync(claudeDesktopConfig),
  });

  // Cursor
  const cursorConfig = path.join(process.cwd(), ".cursor", "mcp.json");
  clients.push({
    name: "Cursor",
    clientType: "cursor",
    configPath: cursorConfig,
    exists: fs.existsSync(path.join(process.cwd(), ".cursor")),
  });

  // VS Code (Continue extension uses .continue/config.json)
  const vscodeConfig = path.join(home, ".continue", "config.json");
  clients.push({
    name: "VS Code + Continue",
    clientType: "vscode-continue",
    configPath: vscodeConfig,
    exists: fs.existsSync(vscodeConfig),
  });

  return clients;
}

/**
 * Add Sequant MCP server to a client's config file.
 * Returns true if written, false if already configured.
 */
export function addSequantToMcpConfig(
  configPath: string,
  clientType?: McpClientType,
): boolean {
  const sequantConfig = getSequantMcpConfig({
    projectDir: process.cwd(),
    clientType,
  });

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // Corrupt or empty file — start fresh
    }
  }

  // Initialize mcpServers if needed (Array.isArray guard: typeof [] === "object")
  if (
    !config.mcpServers ||
    typeof config.mcpServers !== "object" ||
    Array.isArray(config.mcpServers)
  ) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;

  // Check if already configured
  if (servers.sequant) {
    return false;
  }

  servers.sequant = sequantConfig;

  // Ensure parent directory exists
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return true;
}

/**
 * Check whether .mcp.json already has a sequant server entry.
 */
export function isSequantInProjectMcpJson(projectDir?: string): boolean {
  const mcpJsonPath = path.resolve(projectDir ?? ".", PROJECT_MCP_JSON);
  if (!fs.existsSync(mcpJsonPath)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
    return !!config?.mcpServers?.sequant;
  } catch {
    return false;
  }
}

export interface ProjectMcpJsonResult {
  created: boolean;
  merged: boolean;
  skipped: boolean;
}

/**
 * Create or update .mcp.json in the project root for Claude Code.
 *
 * - If .mcp.json doesn't exist → create it with the sequant server entry
 * - If .mcp.json exists with a sequant entry → skip (already configured)
 * - If .mcp.json exists without a sequant entry → merge it in
 *
 * Unlike global client configs, .mcp.json does NOT include cwd or env
 * because Claude Code runs from the project root.
 */
export function createProjectMcpJson(
  projectDir?: string,
): ProjectMcpJsonResult {
  const mcpJsonPath = path.resolve(projectDir ?? ".", PROJECT_MCP_JSON);
  const sequantConfig = getSequantMcpConfig(); // No clientType → no cwd/env

  let config: Record<string, unknown> = {};
  let fileExisted = false;

  if (fs.existsSync(mcpJsonPath)) {
    fileExisted = true;
    try {
      config = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
    } catch {
      // Corrupt or empty file — start fresh
      config = {};
    }
  }

  // Initialize mcpServers if needed (Array.isArray guard: typeof [] === "object")
  if (
    !config.mcpServers ||
    typeof config.mcpServers !== "object" ||
    Array.isArray(config.mcpServers)
  ) {
    config.mcpServers = {};
  }

  const servers = config.mcpServers as Record<string, unknown>;

  // Already configured — skip
  if (servers.sequant) {
    return { created: false, merged: false, skipped: true };
  }

  servers.sequant = sequantConfig;
  fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + "\n");

  if (fileExisted) {
    return { created: false, merged: true, skipped: false };
  }
  return { created: true, merged: false, skipped: false };
}

export interface SyncMcpPinResult {
  updated: boolean;
  /** Why no rewrite happened, when updated === false. */
  reason?: "no-file" | "no-entry" | "no-pin" | "already-current";
  /** Previous package spec, when updated === true (e.g. "sequant@latest"). */
  from?: string;
  /** New package spec, when updated === true (e.g. "sequant@2.9.0"). */
  to?: string;
}

/**
 * Re-pin an existing project `.mcp.json` sequant entry to the installed version (#793).
 *
 * Unlike {@link createProjectMcpJson} (which skips when a sequant entry already
 * exists), this is the `update`/`sync` path: it refreshes the version pin so the
 * MCP server tracks the release the user just updated to. It only rewrites the
 * `sequant@<version>` token inside `args` and leaves everything else untouched.
 *
 * No-ops (returns `updated: false`) when:
 * - `.mcp.json` doesn't exist (`no-file`) — we never create it here; that's init's job
 * - there's no sequant server entry (`no-entry`)
 * - the entry uses a local-binary form with no `sequant@…` arg (`no-pin`) — a
 *   deliberate contributor override we must not clobber
 * - the pin already matches the installed version (`already-current`)
 *
 * With `opts.dryRun`, computes `from`/`to` and returns `updated: true` for a
 * pending change but does not write the file — the caller reports it as a preview.
 */
export function syncSequantMcpPin(
  projectDir?: string,
  opts?: { dryRun?: boolean },
): SyncMcpPinResult {
  const mcpJsonPath = path.resolve(projectDir ?? ".", PROJECT_MCP_JSON);
  if (!fs.existsSync(mcpJsonPath)) {
    return { updated: false, reason: "no-file" };
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
  } catch {
    // Corrupt file — leave it alone rather than overwriting user content.
    return { updated: false, reason: "no-file" };
  }

  const servers = config?.mcpServers as Record<string, unknown> | undefined;
  const sequant = servers?.sequant as { args?: unknown } | undefined;
  if (!sequant) {
    return { updated: false, reason: "no-entry" };
  }

  const args = sequant.args;
  if (!Array.isArray(args)) {
    return { updated: false, reason: "no-pin" };
  }

  const pinIndex = args.findIndex(
    (a) => typeof a === "string" && a.startsWith("sequant@"),
  );
  if (pinIndex === -1) {
    return { updated: false, reason: "no-pin" };
  }

  const from = args[pinIndex] as string;
  const to = getSequantPackageSpec();
  if (from === to) {
    return { updated: false, reason: "already-current" };
  }

  if (!opts?.dryRun) {
    args[pinIndex] = to;
    fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + "\n");
  }
  return { updated: true, from, to };
}
