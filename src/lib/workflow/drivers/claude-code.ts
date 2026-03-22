/**
 * ClaudeCodeDriver — AgentDriver implementation wrapping the Claude Agent SDK.
 *
 * Owns the `@anthropic-ai/claude-agent-sdk` import. No other file in the
 * orchestration layer should import the SDK directly.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { getMcpServersConfig } from "../../system.js";
import type {
  AgentDriver,
  AgentExecutionConfig,
  AgentPhaseResult,
} from "./agent-driver.js";

export class ClaudeCodeDriver implements AgentDriver {
  name = "claude-code";

  /**
   * Track session ID across calls so callers can implement resume.
   * Set after each executePhase() call.
   */
  private lastSessionId?: string;

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
          // Resume from previous session if provided
          ...(config.sessionId ? { resume: config.sessionId } : {}),
          env: config.env,
          ...(mcpServers ? { mcpServers } : {}),
          stderr: (data: string) => {
            capturedStderr += data;
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
            config.onOutput?.(textContent);
          }
        }

        if (message.type === "result") {
          resultMessage = message;
        }
      }

      clearTimeout(timeoutId);
      this.lastSessionId = resultSessionId;

      if (resultMessage) {
        if (resultMessage.subtype === "success") {
          return {
            success: true,
            output: capturedOutput,
            sessionId: resultSessionId,
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
          error,
        };
      }

      return {
        success: false,
        output: capturedOutput,
        sessionId: resultSessionId,
        error: "No result received from Claude",
      };
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err instanceof Error ? err.message : String(err);

      if (error.includes("abort") || error.includes("AbortError")) {
        return {
          success: false,
          output: capturedOutput,
          error: `Timeout after ${config.phaseTimeout}s`,
        };
      }

      const stderrSuffix = capturedStderr
        ? `\nStderr: ${capturedStderr.slice(0, 500)}`
        : "";

      return {
        success: false,
        output: capturedOutput,
        sessionId: resultSessionId,
        error: error + stderrSuffix,
      };
    }
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
