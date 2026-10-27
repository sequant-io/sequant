/**
 * sequant_logs MCP tool
 *
 * Get run logs and metrics.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { resolveLogDir, parseLogFile } from "../../lib/run-logs.js";
import type { RunLog } from "../../lib/workflow/run-log-schema.js";

export function registerLogsTool(server: McpServer): void {
  server.registerTool(
    "sequant_logs",
    {
      title: "Sequant Logs",
      description:
        "Get structured run logs for recent workflow executions. " +
        "Each log contains per-issue phase results (duration, status, errors) and QA verdicts. " +
        "Use after a sequant_run completes or fails to understand what happened. " +
        "A log's optional cost ({ usd, tokens }) is the SDK's estimate, not a billing statement; " +
        "absent means unrecorded, not free. " +
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
        const logDir = resolveLogDir();

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
                  // #1527: the run's cost, when the log carries one. The CLI's
                  // `sequant logs` prints the same figure; absent means
                  // unrecorded, never free.
                  ...(log.cost && { cost: log.cost }),
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
                      ...(p.verdict && { verdict: p.verdict }),
                      ...(p.summary && { summary: p.summary }),
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
