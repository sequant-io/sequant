/**
 * ClaudeCodeDriver — AgentDriver implementation wrapping the Claude Agent SDK.
 *
 * Owns the `@anthropic-ai/claude-agent-sdk` import. No other file in the
 * orchestration layer should import the SDK directly.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { getMcpServersConfig } from "../../system.js";
import { RingBuffer } from "../ring-buffer.js";
import type {
  AgentDriver,
  AgentExecutionConfig,
  AgentPhaseResult,
  ResumeHandle,
} from "./agent-driver.js";

export class ClaudeCodeDriver implements AgentDriver {
  name = "claude-code";

  /**
   * Track session ID across calls so callers can implement resume.
   * Set after each executePhase() call.
   */
  private lastSessionId?: string;

  /**
   * Decide whether a resume handle can be used for a target cwd.
   *
   * Claude Code namespaces session storage by encoded cwd
   * (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`), so a session
   * created in cwd A cannot be located when resuming from cwd B — the SDK
   * returns `error_during_execution` ("No conversation found") rather than
   * crashing (verified against `@anthropic-ai/claude-agent-sdk@0.3.142`,
   * see #674).
   *
   * We use byte-equal comparison, not a normalized path: the SDK's storage
   * key is derived from the literal cwd string, so normalizing here would
   * risk false-positive resumes whose token would then miss on disk.
   */
  canResume(handle: ResumeHandle, targetCwd: string): boolean {
    if (handle.driver !== this.name) return false;
    return handle.originCwd === targetCwd;
  }

  async executePhase(
    prompt: string,
    config: AgentExecutionConfig,
  ): Promise<AgentPhaseResult> {
    const abortController = new AbortController();

    // Wire external abort signal
    if (config.abortSignal) {
      config.abortSignal.addEventListener("abort", () =>
        abortController.abort(),
      );
    }

    // Set up timeout
    const timeoutId = setTimeout(() => {
      abortController.abort();
    }, config.phaseTimeout * 1000);

    let resultSessionId: string | undefined;
    let resultMessage: SDKResultMessage | undefined;
    let capturedOutput = "";
    let capturedStderr = "";
    const stderrBuffer = new RingBuffer(50);
    const stdoutBuffer = new RingBuffer(50);

    // Resolve resume token with cwd-safety check.
    //
    // Prefer the driver-tagged `resumeHandle` over the legacy `sessionId`
    // string (#674). On cwd mismatch we silently drop the resume — Claude
    // Code's cwd-mismatched resume is recoverable (`error_during_execution`,
    // "No conversation found"), but starting fresh is the cleaner outcome
    // than surfacing a per-phase error the caller can't act on.
    let resumeToken: string | undefined;
    if (
      config.resumeHandle &&
      this.canResume(config.resumeHandle, config.cwd)
    ) {
      resumeToken = config.resumeHandle.token;
    } else if (!config.resumeHandle && config.sessionId) {
      // Back-compat: legacy state (sessionId without originCwd) cannot prove
      // cwd parity. Per #674's fail-safe rule, do NOT resume — start fresh.
      resumeToken = undefined;
    }

    try {
      // Get MCP servers config if enabled
      const mcpServers = config.mcp ? getMcpServersConfig() : undefined;

      const queryInstance = query({
        prompt,
        options: {
          abortController,
          cwd: config.cwd,
          settingSources: ["project"],
          systemPrompt: { type: "preset", preset: "claude_code" },
          tools: { type: "preset", preset: "claude_code" },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          // Resume from previous session only when cwd matches origin (#674).
          ...(resumeToken ? { resume: resumeToken } : {}),
          env: config.env,
          ...(mcpServers ? { mcpServers } : {}),
          stderr: (data: string) => {
            capturedStderr += data;
            // Split on newlines and push each line to the ring buffer
            const lines = data.split("\n").filter((l) => l.length > 0);
            for (const line of lines) {
              stderrBuffer.push(line);
            }
            config.onStderr?.(data);
          },
        },
      });

      // Stream and process messages
      for await (const message of queryInstance) {
        if (message.type === "system" && message.subtype === "init") {
          resultSessionId = message.session_id;
        }

        if (message.type === "assistant") {
          const content = message.message.content as Array<{
            type: string;
            text?: string;
          }>;
          const textContent = content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text)
            .join("");
          if (textContent) {
            capturedOutput += textContent;
            const lines = textContent.split("\n").filter((l) => l.length > 0);
            for (const line of lines) {
              stdoutBuffer.push(line);
            }
            config.onOutput?.(textContent);
          }
        }

        if (message.type === "result") {
          resultMessage = message;
        }
      }

      clearTimeout(timeoutId);
      this.lastSessionId = resultSessionId;

      // Build the cwd-bound resume handle from the session created in
      // `config.cwd`. `sessionId` is mirrored for one release (#674) so
      // upgraded callers can still drive resume off the deprecated field.
      const resumeHandle = this.buildResumeHandle(resultSessionId, config.cwd);

      if (resultMessage) {
        if (resultMessage.subtype === "success") {
          return {
            success: true,
            output: capturedOutput,
            sessionId: resultSessionId,
            resumeHandle,
            stderrTail: stderrBuffer.getLines(),
            stdoutTail: stdoutBuffer.getLines(),
          };
        }

        // Handle error subtypes
        let error: string;
        const errorSubtype = resultMessage.subtype;
        if (errorSubtype === "error_max_turns") {
          error = "Max turns reached";
        } else if (errorSubtype === "error_during_execution") {
          error = resultMessage.errors?.join(", ") || "Error during execution";
        } else if (errorSubtype === "error_max_budget_usd") {
          error = "Budget limit exceeded";
        } else {
          error = `Error: ${errorSubtype}`;
        }

        return {
          success: false,
          output: capturedOutput,
          sessionId: resultSessionId,
          resumeHandle,
          error,
          stderrTail: stderrBuffer.getLines(),
          stdoutTail: stdoutBuffer.getLines(),
        };
      }

      return {
        success: false,
        output: capturedOutput,
        sessionId: resultSessionId,
        resumeHandle,
        error: "No result received from Claude",
        stderrTail: stderrBuffer.getLines(),
        stdoutTail: stdoutBuffer.getLines(),
      };
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);

      if (error.includes("abort") || error.includes("AbortError")) {
        return {
          success: false,
          output: capturedOutput,
          error: `Timeout after ${config.phaseTimeout}s`,
          stderrTail: stderrBuffer.getLines(),
          stdoutTail: stdoutBuffer.getLines(),
        };
      }

      const stderrSuffix = capturedStderr
        ? `\nStderr: ${capturedStderr.slice(0, 500)}`
        : "";

      return {
        success: false,
        output: capturedOutput,
        sessionId: resultSessionId,
        resumeHandle: this.buildResumeHandle(resultSessionId, config.cwd),
        error: error + stderrSuffix,
        stderrTail: stderrBuffer.getLines(),
        stdoutTail: stdoutBuffer.getLines(),
      };
    }
  }

  private buildResumeHandle(
    token: string | undefined,
    originCwd: string,
  ): ResumeHandle | undefined {
    if (!token) return undefined;
    return { driver: this.name, token, originCwd };
  }

  async isAvailable(): Promise<boolean> {
    try {
      // If we can import the SDK, it's available
      await import("@anthropic-ai/claude-agent-sdk");
      return true;
    } catch {
      return false;
    }
  }
}
