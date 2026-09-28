/**
 * Sequant MCP Server
 *
 * Exposes Sequant workflow orchestration as an MCP server.
 * Any MCP client (Claude Desktop, Cursor, VS Code, etc.) can invoke
 * Sequant tools to drive structured AI workflows.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import { registerRunTool } from "./tools/run.js";
import { registerStatusTool, type StatusToolOptions } from "./tools/status.js";
import { registerLogsTool } from "./tools/logs.js";
import { registerResources, type ResourceContext } from "./resources.js";

/**
 * Per-tool options for `createServer`. Test-only (#1164): tests point
 * `sequant_status` at a state file they own so they never read or rewrite
 * the checkout's `.sequant/state.json`. `serve` passes none.
 */
export interface CreateServerOptions {
  status?: StatusToolOptions;
}

/**
 * Create and configure the Sequant MCP server instance.
 */
export function createServer(
  version: string,
  context: ResourceContext = {},
  serverOptions: CreateServerOptions = {},
): McpServer {
  const options: ServerOptions = {
    instructions: [
      "Sequant orchestrates AI-driven development workflows for GitHub issues.",
      "Each issue progresses through phases: spec (plan) → exec (implement) → qa (review).",
      "",
      "Tools:",
      "- sequant_status: Check issue progress. Poll every 5-10s during active runs. Always check before calling sequant_run.",
      "- sequant_run: Execute workflow phases. Long-running (up to 30 min). Returns structured JSON on completion.",
      "- sequant_logs: Review past run results and debug failures.",
      "",
      "Resources:",
      "- sequant://state: Dashboard view of all tracked issues and their phases.",
      "- sequant://config: Current workflow settings (timeout, phases, quality loop), verbatim.",
      "- sequant://install: Is the installed skill tree stale vs this server's version? Report-only — never auto-applied; run `sequant update`.",
      "",
      "Workflow: Check sequant_status first → sequant_run if needed → poll sequant_status → review sequant_logs on failure.",
      "Do NOT call sequant_run for issues that are already merged or completed.",
    ].join("\n"),
    capabilities: {
      tools: {},
      resources: {},
    },
  };

  const server = new McpServer(
    {
      name: "sequant",
      version,
    },
    options,
  );

  // Register tools
  registerRunTool(server);
  registerStatusTool(server, serverOptions.status);
  registerLogsTool(server);

  // Register resources
  registerResources(server, context);

  return server;
}
