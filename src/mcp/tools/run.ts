/**
 * sequant_run MCP tool
 *
 * Execute workflow phases for GitHub issues.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawnSync } from "child_process";

export function registerRunTool(server: McpServer): void {
  server.registerTool(
    "sequant_run",
    {
      title: "Sequant Run",
      description:
        "Run structured AI workflow phases (spec, exec, qa) for GitHub issues with quality gates",
      inputSchema: {
        issues: z.array(z.number()).describe("GitHub issue numbers to process"),
        phases: z
          .string()
          .optional()
          .describe("Comma-separated phases (default: spec,exec,qa)"),
        qualityLoop: z
          .boolean()
          .optional()
          .describe("Enable auto-retry on QA failure"),
        agent: z
          .string()
          .optional()
          .describe(
            "Agent driver for phase execution (default: configured default)",
          ),
      },
    },
    async ({ issues, phases, qualityLoop, agent }) => {
      if (!issues || issues.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "INVALID_INPUT",
                message: "At least one issue number is required",
              }),
            },
          ],
          isError: true,
        };
      }

      // Build command arguments
      const args = ["sequant", "run", ...issues.map(String)];
      if (phases) {
        args.push("--phases", phases);
      }
      if (qualityLoop) {
        args.push("--quality-loop");
      }
      if (agent) {
        args.push("--agent", agent);
      }
      args.push("--log-json");

      try {
        const result = spawnSync("npx", args, {
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 1800000, // 30 min default
          env: {
            ...process.env,
            SEQUANT_ORCHESTRATOR: "mcp-server",
          },
        });

        const output = result.stdout || "";
        const stderr = result.stderr || "";

        if (result.status !== 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "failure",
                  exitCode: result.status,
                  issues: issues,
                  output: output.slice(-2000),
                  error: stderr.slice(-1000),
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "success",
                issues: issues,
                phases: phases || "spec,exec,qa",
                output: output.slice(-2000),
              }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "EXECUTION_ERROR",
                message: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
