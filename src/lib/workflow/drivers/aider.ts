/**
 * AiderDriver — AgentDriver implementation wrapping the Aider CLI.
 *
 * Shells out to `aider --yes --no-auto-commits --message "<prompt>"`
 * for fully non-interactive phase execution. Sequant manages git,
 * not Aider.
 */

import { spawn } from "child_process";
import { execSync } from "child_process";
import { RingBuffer } from "../ring-buffer.js";
import type {
  AgentDriver,
  AgentExecutionConfig,
  AgentPhaseResult,
} from "./agent-driver.js";
import type { AiderSettings } from "../../settings.js";

export class AiderDriver implements AgentDriver {
  name = "aider";

  private settings?: AiderSettings;

  constructor(settings?: AiderSettings) {
    this.settings = settings;
  }

  async executePhase(
    prompt: string,
    config: AgentExecutionConfig,
  ): Promise<AgentPhaseResult> {
    const args = this.buildArgs(prompt, config.files);

    return new Promise<AgentPhaseResult>((resolve) => {
      let capturedOutput = "";
      let capturedStderr = "";
      const stderrBuffer = new RingBuffer(50);
      const stdoutBuffer = new RingBuffer(50);

      const proc = spawn("aider", args, {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Set up timeout
      const timeoutId = setTimeout(() => {
        proc.kill("SIGTERM");
      }, config.phaseTimeout * 1000);

      // Wire external abort signal
      if (config.abortSignal) {
        const onAbort = () => {
          proc.kill("SIGTERM");
        };
        config.abortSignal.addEventListener("abort", onAbort);
        proc.on("close", () => {
          config.abortSignal?.removeEventListener("abort", onAbort);
        });
      }

      proc.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        capturedOutput += text;
        const lines = text.split("\n").filter((l) => l.length > 0);
        for (const line of lines) {
          stdoutBuffer.push(line);
        }
        if (config.verbose) {
          config.onOutput?.(text);
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        capturedStderr += text;
        const lines = text.split("\n").filter((l) => l.length > 0);
        for (const line of lines) {
          stderrBuffer.push(line);
        }
        config.onStderr?.(text);
      });

      proc.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timeoutId);
        if (err.code === "ENOENT") {
          resolve({
            success: false,
            output: capturedOutput,
            error:
              "Aider CLI not found. Install it with: pip install aider-chat",
            stderrTail: stderrBuffer.getLines(),
            stdoutTail: stdoutBuffer.getLines(),
          });
        } else {
          resolve({
            success: false,
            output: capturedOutput,
            error: `Failed to start aider: ${err.message}`,
            stderrTail: stderrBuffer.getLines(),
            stdoutTail: stdoutBuffer.getLines(),
          });
        }
      });

      proc.on("close", (code: number | null, signal: string | null) => {
        clearTimeout(timeoutId);

        if (signal) {
          const isTimeout = signal === "SIGTERM";
          resolve({
            success: false,
            output: capturedOutput,
            error: isTimeout
              ? `Timeout after ${config.phaseTimeout}s`
              : `Process killed by signal: ${signal}`,
            stderrTail: stderrBuffer.getLines(),
            stdoutTail: stdoutBuffer.getLines(),
            exitCode: code ?? undefined,
          });
          return;
        }

        if (code === 0) {
          resolve({
            success: true,
            output: capturedOutput,
            stderrTail: stderrBuffer.getLines(),
            stdoutTail: stdoutBuffer.getLines(),
            exitCode: 0,
          });
        } else {
          const stderrSuffix = capturedStderr
            ? `\nStderr: ${capturedStderr.slice(0, 500)}`
            : "";
          resolve({
            success: false,
            output: capturedOutput,
            error: `Aider exited with code ${code}${stderrSuffix}`,
            stderrTail: stderrBuffer.getLines(),
            stdoutTail: stdoutBuffer.getLines(),
            exitCode: code ?? undefined,
          });
        }
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      execSync("which aider", { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  /** Build the CLI argument list for aider. */
  private buildArgs(prompt: string, files?: string[]): string[] {
    const args = [
      "--yes",
      "--no-auto-commits",
      "--no-pretty",
      "--message",
      prompt,
    ];

    if (this.settings?.model) {
      args.push("--model", this.settings.model);
    }

    if (this.settings?.editFormat) {
      args.push("--edit-format", this.settings.editFormat);
    }

    if (this.settings?.extraArgs) {
      args.push(...this.settings.extraArgs);
    }

    // Pass relevant files for context (e.g., changed files from git diff)
    if (files?.length) {
      for (const file of files) {
        args.push("--file", file);
      }
    }

    return args;
  }
}
