/**
 * sequant_run MCP tool
 *
 * Execute workflow phases for GitHub issues.
 * Returns structured JSON with per-issue summaries parsed from run logs.
 * Uses async spawn to keep the MCP server responsive during execution.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { spawn } from "child_process";
import { resolve, dirname, join } from "path";
import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { homedir } from "os";
import { LOG_PATHS, RunLogSchema } from "../../lib/workflow/run-log-schema.js";
import type { RunLog } from "../../lib/workflow/run-log-schema.js";
import { registerRun, unregisterRun } from "../run-registry.js";

/** Maximum total response size in bytes (64 KB) */
const MAX_RESPONSE_SIZE = 64 * 1024;

/** Maximum raw output size before truncation */
const MAX_RAW_OUTPUT = 2000;

/** Maximum age of a log file to be considered for the current run (ms) */
const MAX_LOG_AGE_MS = 5 * 60 * 1000; // 5 minutes

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
 * Resolve the CLI binary path to avoid nested npx version mismatches (#389).
 *
 * Priority:
 * 1. process.argv[1] — the script currently running (works for npx, global, local node)
 * 2. __dirname-relative resolution — fallback for bundled/compiled entry points
 * 3. "npx" + "sequant" — last resort if nothing else resolves
 *
 * Returns [command, prefixArgs] where the full invocation is:
 *   spawnAsync(command, [...prefixArgs, "run", ...userArgs])
 */
export function resolveCliBinary(): [string, string[]] {
  // Try process.argv — most reliable across npx, global install, and local node
  const nodeExe = process.argv[0];
  const scriptPath = process.argv[1];

  if (scriptPath && existsSync(scriptPath)) {
    // If the entry point is a .ts file (e.g. running via `npx tsx bin/cli.ts serve`),
    // the child process won't have tsx's loader hooks. Prefer the compiled dist output,
    // or fall through to use tsx explicitly.
    if (!scriptPath.endsWith(".ts")) {
      return [nodeExe, [scriptPath]];
    }

    // Try compiled dist equivalent: bin/cli.ts → dist/bin/cli.js
    const distPath = resolve(
      dirname(scriptPath),
      "..",
      "dist",
      "bin",
      "cli.js",
    );
    if (existsSync(distPath)) {
      return [process.execPath, [distPath]];
    }

    // Use tsx to run the .ts file directly
    return ["npx", ["tsx", scriptPath]];
  }

  // Fallback: resolve relative to this file's location (dist/src/mcp/tools/run.js → dist/bin/cli.js)
  const cliPath = resolve(dirname(__dirname), "..", "..", "bin", "cli.js");
  if (existsSync(cliPath)) {
    return [process.execPath, [cliPath]];
  }

  // Last resort: fall back to npx (original behavior)
  return ["npx", ["sequant"]];
}

/**
 * Resolve the log directory path (project-level or user-level)
 */
function resolveLogDir(): string {
  const projectPath = LOG_PATHS.project;
  if (existsSync(projectPath)) {
    return projectPath;
  }

  const userPath = LOG_PATHS.user.replace("~", homedir());
  if (existsSync(userPath)) {
    return userPath;
  }

  return projectPath;
}

/**
 * Find and parse the most recent run log file.
 *
 * When runStartTime is provided, only log files created within
 * MAX_LOG_AGE_MS of that timestamp are considered, preventing
 * stale logs from a previous run being returned.
 */
export async function readLatestRunLog(
  runStartTime?: Date,
): Promise<RunLog | null> {
  try {
    const logDir = resolveLogDir();

    const entries = await readdir(logDir);
    let logFiles = entries
      .filter((f) => f.startsWith("run-") && f.endsWith(".json"))
      .sort()
      .reverse();

    if (logFiles.length === 0) return null;

    // Filter by recency if a run start time is provided
    if (runStartTime) {
      logFiles = logFiles.filter((f) => {
        // Filename format: run-YYYY-MM-DDTHH-MM-SS-<uuid>.json
        const match = f.match(
          /^run-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/,
        );
        if (!match) return false;
        const fileTime = new Date(
          `${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`,
        );
        // Accept files created around or after the run started
        return fileTime.getTime() >= runStartTime.getTime() - MAX_LOG_AGE_MS;
      });
      if (logFiles.length === 0) return null;
    }

    const content = await readFile(join(logDir, logFiles[0]), "utf-8");
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
  exitCode?: number | null,
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
    ...(exitCode != null && exitCode !== 0 ? { exitCode } : {}),
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
 * Enforce response size limit by progressively truncating rawOutput.
 * Uses Buffer.byteLength for accurate UTF-8 byte measurement.
 */
function enforceResponseSizeLimit(response: RunToolResponse): RunToolResponse {
  let json = JSON.stringify(response);
  let byteLength = Buffer.byteLength(json, "utf-8");

  if (byteLength <= MAX_RESPONSE_SIZE) {
    return response;
  }

  // Progressively truncate rawOutput to fit
  const rawOutput = response.rawOutput || "";
  if (rawOutput.length > 0) {
    const excess = byteLength - MAX_RESPONSE_SIZE;
    // Over-trim slightly: multi-byte chars mean char count < byte count
    const newLength = Math.max(0, rawOutput.length - excess - 200);

    response.rawOutput =
      newLength > 0 ? rawOutput.slice(-newLength) : undefined;

    json = JSON.stringify(response);
    byteLength = Buffer.byteLength(json, "utf-8");
  }

  // If still too large (structured data itself is huge), truncate error field
  if (byteLength > MAX_RESPONSE_SIZE && response.error) {
    const excess = byteLength - MAX_RESPONSE_SIZE;
    const newLength = Math.max(0, response.error.length - excess - 200);
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
  exitCode?: number | null,
  stderr?: string,
): RunToolResponse {
  return {
    status: overallStatus,
    ...(exitCode != null && exitCode !== 0 ? { exitCode } : {}),
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
/** Prefix used by the batch executor to emit structured progress lines. */
const PROGRESS_LINE_PREFIX = "SEQUANT_PROGRESS:";

/** Parsed progress event from a SEQUANT_PROGRESS line. */
export interface ProgressEvent {
  issue: number;
  phase: string;
  event: "start" | "complete" | "failed";
  durationSeconds?: number;
  error?: string;
}

/**
 * Parse a SEQUANT_PROGRESS line emitted by the batch executor.
 * Returns the parsed event or null if the line isn't a progress line.
 */
export function parseProgressLine(line: string): ProgressEvent | null {
  if (!line.startsWith(PROGRESS_LINE_PREFIX)) return null;
  try {
    const json = JSON.parse(line.slice(PROGRESS_LINE_PREFIX.length));
    if (
      typeof json.issue === "number" &&
      typeof json.phase === "string" &&
      typeof json.event === "string" &&
      (json.event === "start" ||
        json.event === "complete" ||
        json.event === "failed")
    ) {
      const result: ProgressEvent = {
        issue: json.issue,
        phase: json.phase,
        event: json.event,
      };
      if (typeof json.durationSeconds === "number") {
        result.durationSeconds = json.durationSeconds;
      }
      if (typeof json.error === "string") {
        result.error = json.error;
      }
      return result;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a human-readable message for a progress notification (AC-3).
 * @internal Exported for testing only.
 */
export function formatProgressMessage(event: ProgressEvent): string {
  const prefix = `#${event.issue}`;
  switch (event.event) {
    case "start":
      return `${prefix}: ${event.phase} started`;
    case "complete": {
      const dur = event.durationSeconds ? ` (${event.durationSeconds}s)` : "";
      return `${prefix}: ${event.phase} \u2713${dur}`;
    }
    case "failed": {
      const reason = event.error ? ` \u2014 ${event.error}` : "";
      return `${prefix}: ${event.phase} \u2717${reason}`;
    }
  }
}

/**
 * Create a line buffer that accumulates stream chunks and yields complete lines.
 * Handles the case where a single `data` event spans partial lines.
 */
export function createLineBuffer(
  onLine: (line: string) => void,
): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!; // keep incomplete tail
    for (const line of lines) {
      if (line.length > 0) onLine(line);
    }
  };
}

/** Type alias for the tool handler's extra parameter */
type ToolHandlerExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const runToolInputSchema = {
  issues: z.array(z.number()).describe("GitHub issue numbers to process"),
  phases: z
    .string()
    .optional()
    .describe(
      "Comma-separated workflow phases to execute. " +
        "Valid values: 'spec' (plan and review AC), 'exec' (implement in worktree), 'qa' (code review and verification). " +
        "Default: 'spec,exec,qa'. Example: 'spec,exec' to skip QA.",
    ),
  qualityLoop: z
    .boolean()
    .optional()
    .describe("Enable auto-retry on QA failure"),
  agent: z
    .string()
    .optional()
    .describe("Agent driver for phase execution (default: configured default)"),
};

export function registerRunTool(server: McpServer): void {
  server.registerTool(
    "sequant_run",
    {
      title: "Sequant Run",
      description:
        "Execute structured AI workflow phases for GitHub issues. " +
        "Runs spec (plan) → exec (implement) → qa (review) in sequence, creating worktrees and PRs. " +
        "Long-running: up to 30 minutes per issue. Returns structured JSON with per-issue phase results. " +
        "Check sequant_status first to avoid re-running completed issues. " +
        "Example: {issues: [123], phases: 'spec,exec'}",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: runToolInputSchema,
    },
    (async (
      {
        issues,
        phases,
        qualityLoop,
        agent,
      }: {
        issues: number[];
        phases?: string;
        qualityLoop?: boolean;
        agent?: string;
      },
      extra: ToolHandlerExtra,
    ) => {
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

      // Resolve CLI binary to avoid nested npx version mismatch (#389)
      const [command, prefixArgs] = resolveCliBinary();

      // Build command arguments
      const args = [...prefixArgs, "run", ...issues.map(String)];
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
      const phaseList = phasesStr.split(",");
      const totalSteps = issues.length * phaseList.length;
      const runStartTime = new Date();

      // Extract progress token for MCP progress notifications (AC-1)
      const progressToken = extra._meta?.progressToken;

      // Track progress: only complete/failed events increment the counter
      let completedSteps = 0;

      /**
       * Emit a progress notification if the client provided a progressToken.
       * Only complete/failed events increment the progress counter.
       * Failures are caught to avoid aborting the run (AC-6).
       */
      const emitProgress = (event: ProgressEvent): void => {
        if (progressToken === undefined) return;
        if (event.event === "complete" || event.event === "failed") {
          completedSteps++;
        }
        try {
          // Fire-and-forget: don't await to avoid blocking the output stream
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: completedSteps,
                total: totalSteps,
                message: formatProgressMessage(event),
              },
            })
            .catch(() => {
              // Swallow notification delivery errors (AC-6)
            });
        } catch {
          // Swallow synchronous errors (AC-6)
        }
      };

      /**
       * Handle a complete line of subprocess stderr, checking for progress events.
       * The batch executor emits SEQUANT_PROGRESS:{json} lines at phase boundaries.
       */
      const handleLine = (line: string): void => {
        const event = parseProgressLine(line);
        if (event) emitProgress(event);
      };

      // Line-buffer stderr to handle chunk boundaries correctly.
      // When a progressToken is present, we also enable spawnAsync's
      // internal progress detection for timeout reset (AC-4).
      const hasProgressToken = progressToken !== undefined;
      const stderrLineBuffer = hasProgressToken
        ? createLineBuffer(handleLine)
        : undefined;

      // Register all issues as active runs for real-time status polling
      for (const issue of issues) {
        registerRun(issue);
      }

      try {
        const result = await spawnAsync(command, args, {
          timeout: PHASE_TIMEOUT,
          env: {
            ...process.env,
            SEQUANT_ORCHESTRATOR: "mcp-server",
          },
          signal: extra.signal,
          onStderr: stderrLineBuffer,
          // Enable timeout reset on progress events when client
          // provided a progressToken (AC-4). spawnAsync detects
          // SEQUANT_PROGRESS lines from stderr internally.
          onProgress: hasProgressToken ? () => {} : undefined,
        });

        const stdout = result.stdout || "";
        const stderr = result.stderr || "";
        const overallStatus: "success" | "failure" =
          result.exitCode === 0 ? "success" : "failure";

        // Try to read structured log file for rich per-issue data
        const runLog = await readLatestRunLog(runStartTime);

        let response: RunToolResponse;
        if (runLog) {
          response = buildStructuredResponse(
            runLog,
            stdout,
            overallStatus,
            result.exitCode,
            stderr || undefined,
          );
        } else {
          // Fallback: no log file available
          response = buildFallbackResponse(
            stdout,
            issues,
            overallStatus,
            phasesStr,
            result.exitCode,
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
          ...(result.exitCode !== 0 ? { isError: true } : {}),
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
      } finally {
        for (const issue of issues) {
          unregisterRun(issue);
        }
      }
    }) as Parameters<typeof server.registerTool>[2],
  );
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Per-phase timeout ceiling (30 minutes) */
export const PHASE_TIMEOUT = 1_800_000;

/** Absolute maximum run duration (2 hours), even with progress resets */
export const MAX_TOTAL_TIMEOUT = 7_200_000;

export interface SpawnOptions {
  timeout: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Called with each stderr chunk (real-time, before process exits) */
  onStderr?: (chunk: string) => void;
  /** Called with each stdout chunk (real-time, before process exits) */
  onStdout?: (chunk: string) => void;
  /**
   * Called when a progress event is detected from stderr.
   * When set, enables resettable timeout: the per-phase timeout resets on
   * each SEQUANT_PROGRESS line, but the absolute ceiling still applies.
   */
  onProgress?: () => void;
  /**
   * Override the absolute timeout ceiling (defaults to MAX_TOTAL_TIMEOUT).
   * Only applies when onProgress is set. Useful for testing.
   * @internal
   */
  maxTotalTimeout?: number;
}

/** @internal Exported for testing only */
export function spawnAsync(
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env,
      detached: true,
    });

    const settle = (
      outcome: { ok: true; result: SpawnResult } | { ok: false; error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", onAbort);
      if (outcome.ok) {
        resolve(outcome.result);
      } else {
        reject(outcome.error);
      }
    };

    // Resettable timeout: resets on progress events (AC-4).
    // Uses options.timeout as the per-phase ceiling and MAX_TOTAL_TIMEOUT
    // as the absolute ceiling to prevent infinite runs.
    const runStart = Date.now();
    const maxTotal = options.onProgress
      ? (options.maxTotalTimeout ?? MAX_TOTAL_TIMEOUT)
      : options.timeout;

    const scheduleTimeout = (): ReturnType<typeof setTimeout> => {
      const elapsed = Date.now() - runStart;
      const remaining = Math.min(options.timeout, maxTotal - elapsed);
      if (remaining <= 0) {
        // Already exceeded max total — kill immediately
        killProcessGroup(proc);
        const msg = options.onProgress
          ? `Process timed out: total elapsed ${elapsed}ms exceeded ceiling of ${maxTotal}ms`
          : `Process timed out after ${maxTotal}ms`;
        settle({ ok: false, error: new Error(msg) });
        return setTimeout(() => {}, 0); // dummy handle
      }
      return setTimeout(() => {
        killProcessGroup(proc);
        const msg = options.onProgress
          ? `Process timed out: no progress for ${options.timeout}ms (total elapsed: ${Date.now() - runStart}ms)`
          : `Process timed out after ${options.timeout}ms`;
        settle({ ok: false, error: new Error(msg) });
      }, remaining);
    };

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    timeoutId = scheduleTimeout();

    // When progress monitoring is enabled, detect SEQUANT_PROGRESS lines
    // from stderr and reset the timeout on each one. This keeps the timeout
    // reset logic co-located with the timer inside spawnAsync (AC-4).
    const resetTimeout = () => {
      if (!settled) {
        clearTimeout(timeoutId);
        timeoutId = scheduleTimeout();
      }
    };

    const progressLineBuffer = options.onProgress
      ? createLineBuffer((line) => {
          if (line.startsWith(PROGRESS_LINE_PREFIX)) {
            resetTimeout();
            options.onProgress!();
          }
        })
      : undefined;

    const onAbort = () => {
      killProcessGroup(proc);
      settle({ ok: false, error: new Error("Cancelled by client") });
    };

    if (options.signal) {
      if (options.signal.aborted) {
        killProcessGroup(proc);
        clearTimeout(timeoutId);
        reject(new Error("Cancelled by client"));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      options.onStdout?.(chunk);
    });

    proc.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      options.onStderr?.(chunk);
      progressLineBuffer?.(chunk);
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        settle({
          ok: false,
          error: new Error(
            `Command not found: ${command}. Ensure it is installed and in PATH.`,
          ),
        });
      } else {
        settle({
          ok: false,
          error: new Error(`Failed to spawn process: ${err.message}`),
        });
      }
    });

    proc.on("close", (code: number | null) => {
      settle({ ok: true, result: { exitCode: code, stdout, stderr } });
    });
  });
}

const SIGKILL_GRACE_MS = 5000;

function killProcessGroup(proc: ReturnType<typeof spawn>): void {
  let exited = false;
  proc.on("close", () => {
    exited = true;
  });

  sendSignal(proc, "SIGTERM");

  setTimeout(() => {
    if (!exited) {
      sendSignal(proc, "SIGKILL");
    }
  }, SIGKILL_GRACE_MS).unref();
}

function sendSignal(
  proc: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, signal);
    }
  } catch {
    // Process group may already be gone — fall back to direct kill
    if (!proc.killed) {
      proc.kill(signal);
    }
  }
}
