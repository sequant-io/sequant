/**
 * Sequant MCP Server
 *
 * Exposes Sequant workflow orchestration as an MCP server.
 * Any MCP client (Claude Desktop, Cursor, VS Code, etc.) can invoke
 * Sequant tools to drive structured AI workflows.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRunTool } from "./tools/run.js";
import { registerStatusTool } from "./tools/status.js";
import { registerLogsTool } from "./tools/logs.js";
import { registerResources } from "./resources.js";

/**
 * Create and configure the Sequant MCP server instance.
 */
export function createServer(version: string): McpServer {
  const server = new McpServer(
    {
      name: "sequant",
      version,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // Register tools
  registerRunTool(server);
  registerStatusTool(server);
  registerLogsTool(server);

  // Register resources
  registerResources(server);

  return server;
}
