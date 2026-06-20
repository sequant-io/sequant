/**
 * ClaudeCodeDriver — AgentDriver implementation wrapping the Claude Agent SDK.
 *
 * Owns the `@anthropic-ai/claude-agent-sdk` import. No other file in the
 * orchestration layer should import the SDK directly.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKResultMessage,
  SDKRateLimitInfo,
  SDKAssistantMessageError,
} from "@anthropic-ai/claude-agent-sdk";
import { getMcpServersConfig } from "../../system.js";
import {
  type SequantError,
  RateLimitError,
  BillingError,
  createRateLimitError,
  isRateLimitFailureInfo,
} from "../../errors.js";
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

    // Structured rate-limit / billing signals captured from the SDK stream
    // (#732). The SDK emits these but sequant previously dropped them on the
    // floor, falling back to regex-on-stderr classification. We keep only the
    // latest *failure-grade* rate-limit info (rejection or billing) so an
    // informational `allowed_warning` event isn't mis-attributed to an
    // unrelated phase failure.
    let rateLimitInfo: SDKRateLimitInfo | undefined;
    let assistantError: SDKAssistantMessageError | undefined;
    // Last api_retry signal, captured opportunistically for diagnostics.
    let apiRetryError: SDKAssistantMessageError | undefined;
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

        // Capture structured rate-limit info (#732). Only retain
        // failure-grade events (rejection / billing) so a benign warning
        // doesn't poison the failure path.
        if (
          message.type === "rate_limit_event" &&
          isRateLimitFailureInfo(message.rate_limit_info)
        ) {
          rateLimitInfo = message.rate_limit_info;
        }

        // Capture api_retry diagnostics (#732, optional). These are transient
        // retries the SDK performs internally; recorded for the structured
        // error fallback when no rate_limit_event/assistant error is present.
        if (message.type === "system" && message.subtype === "api_retry") {
          apiRetryError = message.error;
        }

        if (message.type === "assistant") {
          // Capture the assistant-level error field (#732) — `rate_limit`,
          // `billing_error`, `overloaded`, etc. Previously discarded by the
          // text-only content filter below.
          if (message.error) {
            assistantError = message.error;
          }

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

      // Build a typed error from structured SDK signals (#732). Present only
      // when the stream surfaced a rate-limit/billing failure; otherwise
      // undefined and the executor falls back to stderr-regex classification.
      const structuredError = this.buildStructuredError(
        rateLimitInfo,
        assistantError,
        apiRetryError,
      );

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
          // Prefer the structured cause (e.g. "Out of credits") over the
          // generic subtype text when available (#732).
          error: structuredError?.message ?? error,
          structuredError,
          stderrTail: stderrBuffer.getLines(),
          stdoutTail: stdoutBuffer.getLines(),
        };
      }

      return {
        success: false,
        output: capturedOutput,
        sessionId: resultSessionId,
        resumeHandle,
        error: structuredError?.message ?? "No result received from Claude",
        structuredError,
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

      // If the stream surfaced a failure-grade rate-limit/billing signal before
      // throwing, prefer that typed cause (#732) over the raw thrown message — a
      // mid-stream throw after a *rejected* rate_limit_event is very likely the
      // proximate cause. Abort/timeout is handled above first, so a genuine
      // timeout is never masked by a stale rate-limit signal.
      const structuredError = this.buildStructuredError(
        rateLimitInfo,
        assistantError,
        apiRetryError,
      );

      const stderrSuffix = capturedStderr
        ? `\nStderr: ${capturedStderr.slice(0, 500)}`
        : "";

      return {
        success: false,
        output: capturedOutput,
        sessionId: resultSessionId,
        resumeHandle: this.buildResumeHandle(resultSessionId, config.cwd),
        error: structuredError?.message ?? error + stderrSuffix,
        structuredError,
        stderrTail: stderrBuffer.getLines(),
        stdoutTail: stdoutBuffer.getLines(),
      };
    }
  }

  /**
   * Derive a typed {@link SequantError} from structured SDK failure signals
   * (#732). Precedence: a captured `rate_limit_event` (richest signal) wins;
   * otherwise the assistant-level `error`; otherwise the last `api_retry`
   * error. Returns undefined when no rate-limit/billing signal was seen, so
   * the executor falls back to stderr-regex classification.
   */
  private buildStructuredError(
    rateLimitInfo: SDKRateLimitInfo | undefined,
    assistantError: SDKAssistantMessageError | undefined,
    apiRetryError: SDKAssistantMessageError | undefined,
  ): SequantError | undefined {
    if (rateLimitInfo) {
      return createRateLimitError(rateLimitInfo);
    }
    return (
      this.errorFromAssistantError(assistantError) ??
      this.errorFromAssistantError(apiRetryError)
    );
  }

  /**
   * Map the SDK's assistant/api-retry error enum to a typed error. Only
   * rate-limit / billing variants are mapped; other variants (auth, etc.)
   * return undefined and defer to the existing classification path.
   */
  private errorFromAssistantError(
    error: SDKAssistantMessageError | undefined,
  ): SequantError | undefined {
    switch (error) {
      case "billing_error":
        return new BillingError("Billing error");
      case "rate_limit":
        return new RateLimitError("Rate limited");
      case "overloaded":
        return new RateLimitError("API overloaded");
      default:
        return undefined;
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
