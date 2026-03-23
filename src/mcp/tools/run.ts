/**
 * sequant_run MCP tool
 *
 * Execute workflow phases for GitHub issues.
 * Returns structured JSON with per-issue summaries parsed from run logs.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { LOG_PATHS, RunLogSchema } from "../../lib/workflow/run-log-schema.js";
import type { RunLog } from "../../lib/workflow/run-log-schema.js";

/** Maximum total response size in bytes (64 KB) */
const MAX_RESPONSE_SIZE = 64 * 1024;

/** Maximum raw output size before truncation */
const MAX_RAW_OUTPUT = 2000;

/**
 * Per-issue summary in the structured response
 */
interface RunToolIssueSummary {
  issueNumber: number;
  status: "success" | "failure" | "partial";
  phases: Array<{ phase: string; status: string; durationSeconds: number }>;
  verdict?: string;
  durationSeconds: number;
}

/**
 * Structured response from sequant_run
 */
interface RunToolResponse {
  status: "success" | "failure";
  exitCode?: number;
  issues: RunToolIssueSummary[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    durationSeconds: number;
  };
  phases: string;
  rawOutput?: string;
  error?: string;
}

/**
 * Resolve the log directory path (project-level or user-level)
 */
function resolveLogDir(): string {
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

/**
 * Find and parse the most recent run log file
 */
export function readLatestRunLog(): RunLog | null {
  try {
    const logDir = resolveLogDir();
    if (!fs.existsSync(logDir)) return null;

    const logFiles = fs
      .readdirSync(logDir)
      .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (logFiles.length === 0) return null;

    const content = fs.readFileSync(path.join(logDir, logFiles[0]), "utf-8");
    return RunLogSchema.parse(JSON.parse(content));
  } catch {
    return null;
  }
}

/**
 * Build a structured response from a parsed RunLog
 */
export function buildStructuredResponse(
  runLog: RunLog,
  rawOutput: string,
  overallStatus: "success" | "failure",
  exitCode?: number,
  errorOutput?: string,
): RunToolResponse {
  const issues: RunToolIssueSummary[] = runLog.issues.map((issue) => {
    // Find QA verdict from phase logs
    const qaPhase = issue.phases.find((p) => p.phase === "qa");
    const verdict = qaPhase?.verdict;

    return {
      issueNumber: issue.issueNumber,
      status: issue.status,
      phases: issue.phases.map((p) => ({
        phase: p.phase,
        status: p.status,
        durationSeconds: p.durationSeconds,
      })),
      ...(verdict ? { verdict } : {}),
      durationSeconds: issue.totalDurationSeconds,
    };
  });

  const phasesRan = [
    ...new Set(runLog.issues.flatMap((i) => i.phases.map((p) => p.phase))),
  ].join(",");

  const response: RunToolResponse = {
    status: overallStatus,
    ...(exitCode !== undefined && exitCode !== 0 ? { exitCode } : {}),
    issues,
    summary: {
      total: runLog.summary.totalIssues,
      passed: runLog.summary.passed,
      failed: runLog.summary.failed,
      durationSeconds: runLog.summary.totalDurationSeconds,
    },
    phases: phasesRan || runLog.config.phases.join(","),
    rawOutput: rawOutput.slice(-MAX_RAW_OUTPUT),
    ...(errorOutput ? { error: errorOutput.slice(-1000) } : {}),
  };

  return enforceResponseSizeLimit(response);
}

/**
 * Enforce response size limit by progressively truncating rawOutput
 */
function enforceResponseSizeLimit(response: RunToolResponse): RunToolResponse {
  let json = JSON.stringify(response);

  if (json.length <= MAX_RESPONSE_SIZE) {
    return response;
  }

  // Progressively truncate rawOutput to fit
  const rawOutput = response.rawOutput || "";
  if (rawOutput.length > 0) {
    // Calculate how much we need to shrink
    const excess = json.length - MAX_RESPONSE_SIZE;
    const newLength = Math.max(0, rawOutput.length - excess - 100); // 100 byte safety margin

    response.rawOutput =
      newLength > 0 ? rawOutput.slice(-newLength) : undefined;

    json = JSON.stringify(response);
  }

  // If still too large (structured data itself is huge), truncate error field
  if (json.length > MAX_RESPONSE_SIZE && response.error) {
    const excess = json.length - MAX_RESPONSE_SIZE;
    const newLength = Math.max(0, response.error.length - excess - 100);
    response.error =
      newLength > 0 ? response.error.slice(-newLength) : undefined;
  }

  return response;
}

/**
 * Build a fallback response when no log file is available
 */
function buildFallbackResponse(
  stdout: string,
  issueNumbers: number[],
  overallStatus: "success" | "failure",
  phases: string,
  exitCode?: number,
  stderr?: string,
): RunToolResponse {
  return {
    status: overallStatus,
    ...(exitCode !== undefined && exitCode !== 0 ? { exitCode } : {}),
    issues: [],
    summary: {
      total: issueNumbers.length,
      passed: overallStatus === "success" ? issueNumbers.length : 0,
      failed: overallStatus === "failure" ? issueNumbers.length : 0,
      durationSeconds: 0,
    },
    phases,
    rawOutput: stdout.slice(-MAX_RAW_OUTPUT),
    ...(stderr ? { error: stderr.slice(-1000) } : {}),
  };
}

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

      const phasesStr = phases || "spec,exec,qa";

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

        const stdout = result.stdout || "";
        const stderr = result.stderr || "";
        const overallStatus = result.status === 0 ? "success" : "failure";

        // Try to read structured log file for rich per-issue data
        const runLog = readLatestRunLog();

        let response: RunToolResponse;
        if (runLog) {
          response = buildStructuredResponse(
            runLog,
            stdout,
            overallStatus as "success" | "failure",
            result.status ?? undefined,
            stderr || undefined,
          );
        } else {
          // Fallback: no log file available
          response = buildFallbackResponse(
            stdout,
            issues,
            overallStatus as "success" | "failure",
            phasesStr,
            result.status ?? undefined,
            stderr || undefined,
          );
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response),
            },
          ],
          ...(result.status !== 0 ? { isError: true } : {}),
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
