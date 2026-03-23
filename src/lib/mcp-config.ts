/**
 * MCP client detection and configuration
 *
 * Detects installed MCP clients (Claude Desktop, Cursor, VS Code)
 * and generates appropriate configuration entries for Sequant MCP server.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface McpClientInfo {
  name: string;
  configPath: string;
  exists: boolean;
}

/**
 * Sequant MCP server configuration entry
 */
export function getSequantMcpConfig(): Record<string, unknown> {
  return {
    command: "npx",
    args: ["sequant@latest", "serve"],
  };
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
    configPath: claudeDesktopConfig,
    exists: fs.existsSync(claudeDesktopConfig),
  });

  // Cursor
  const cursorConfig = path.join(process.cwd(), ".cursor", "mcp.json");
  clients.push({
    name: "Cursor",
    configPath: cursorConfig,
    exists: fs.existsSync(path.join(process.cwd(), ".cursor")),
  });

  // VS Code (Continue extension uses .continue/config.json)
  const vscodeConfig = path.join(home, ".continue", "config.json");
  clients.push({
    name: "VS Code + Continue",
    configPath: vscodeConfig,
    exists: fs.existsSync(vscodeConfig),
  });

  return clients;
}

/**
 * Add Sequant MCP server to a client's config file.
 * Returns true if written, false if already configured.
 */
export function addSequantToMcpConfig(configPath: string): boolean {
  const sequantConfig = getSequantMcpConfig();

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // Corrupt or empty file — start fresh
    }
  }

  // Initialize mcpServers if needed
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
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
