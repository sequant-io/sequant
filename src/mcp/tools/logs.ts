/**
 * sequant_logs MCP tool
 *
 * Get run logs and metrics.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { LOG_PATHS, RunLogSchema } from "../../lib/workflow/run-log-schema.js";
import type { RunLog } from "../../lib/workflow/run-log-schema.js";

function resolveLogPath(): string {
  const projectPath = LOG_PATHS.project;
  if (fs.existsSync(projectPath)) {
    return projectPath;
  }

  const userPath = LOG_PATHS.user.replace("~", os.homedir());
  if (fs.existsSync(userPath)) {
    return userPath;
  }

  return projectPath;
}

function parseLogFile(filePath: string): RunLog | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);
    return RunLogSchema.parse(data);
  } catch {
    return null;
  }
}

export function registerLogsTool(server: McpServer): void {
  server.registerTool(
    "sequant_logs",
    {
      title: "Sequant Logs",
      description:
        "Get structured run logs for recent workflow executions. " +
        "Each log contains per-issue phase results (duration, status, errors) and QA verdicts. " +
        "Use after a sequant_run completes or fails to understand what happened. " +
        "Logs are stored as run-<ISO-timestamp>-<uuid>.json files.",
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        runId: z
          .string()
          .optional()
          .describe(
            "Specific run ID prefix to filter by (e.g. 'run-2026-03-24'). " +
              "Omit to return the most recent runs.",
          ),
        limit: z
          .number()
          .optional()
          .describe(
            "Number of recent runs to return (default: 5, max: all available)",
          ),
      },
    },
    async ({ runId, limit }) => {
      try {
        const logDir = resolveLogPath();

        if (!fs.existsSync(logDir)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  logs: [],
                  message:
                    "No log directory found. Run `sequant run` to generate logs.",
                }),
              },
            ],
          };
        }

        const logFiles = fs
          .readdirSync(logDir)
          .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
          .sort()
          .reverse();

        if (logFiles.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  logs: [],
                  message: "No logs found.",
                }),
              },
            ],
          };
        }

        let logs: RunLog[] = [];
        for (const filename of logFiles) {
          const filePath = path.join(logDir, filename);
          const log = parseLogFile(filePath);
          if (log) {
            // Filter by runId if specified
            if (runId && !log.runId.startsWith(runId)) {
              continue;
            }
            logs.push(log);
          }
        }

        // Apply limit
        const maxResults = limit && limit > 0 ? limit : 5;
        logs = logs.slice(0, maxResults);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                count: logs.length,
                logs: logs.map((log) => ({
                  runId: log.runId,
                  startTime: log.startTime,
                  config: log.config,
                  summary: log.summary,
                  issues: log.issues.map((issue) => ({
                    issueNumber: issue.issueNumber,
                    title: issue.title,
                    status: issue.status,
                    totalDurationSeconds: issue.totalDurationSeconds,
                    phases: issue.phases.map((p) => ({
                      phase: p.phase,
                      status: p.status,
                      durationSeconds: p.durationSeconds,
                      error: p.error,
                    })),
                  })),
                })),
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
                error: "LOGS_ERROR",
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
