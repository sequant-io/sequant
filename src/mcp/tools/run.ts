/**
 * sequant_run MCP tool
 *
 * Execute workflow phases for GitHub issues.
 * Uses async spawn to keep the MCP server responsive during execution.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn } from "child_process";

const runToolInputSchema = {
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
    .describe("Agent driver for phase execution (default: configured default)"),
};

export function registerRunTool(server: McpServer): void {
  server.registerTool(
    "sequant_run",
    {
      title: "Sequant Run",
      description:
        "Run structured AI workflow phases (spec, exec, qa) for GitHub issues with quality gates",
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
      extra: { signal: AbortSignal },
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
        const result = await spawnAsync("npx", args, {
          timeout: 1800000, // 30 min default
          env: {
            ...process.env,
            SEQUANT_ORCHESTRATOR: "mcp-server",
          },
          signal: extra.signal,
        });

        if (result.exitCode !== 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "failure",
                  exitCode: result.exitCode,
                  issues: issues,
                  output: result.stdout.slice(-2000),
                  error: result.stderr.slice(-1000),
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
                output: result.stdout.slice(-2000),
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
    }) as Parameters<typeof server.registerTool>[2],
  );
}

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  timeout: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
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

    const timeoutId = setTimeout(() => {
      killProcessGroup(proc);
      settle({
        ok: false,
        error: new Error(`Process timed out after ${options.timeout}ms`),
      });
    }, options.timeout);

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
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
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
