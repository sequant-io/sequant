/**
 * AgentDriver interface — decouples workflow orchestration from agent execution.
 *
 * Claude Code is the default implementation; alternatives (Aider, Codex CLI,
 * Continue.dev, Copilot SDK, Cursor API) can be added by implementing this
 * interface without touching orchestration logic.
 */

import type { SequantError } from "../../errors.js";

/**
 * Resume handle for a previous agent session.
 *
 * Replaces the opaque `sessionId` string with a driver-tagged value that
 * records the cwd the session was created in. Drivers use this to enforce
 * cwd-safe resume (Claude Code: session storage is cwd-namespaced; Codex:
 * cwd-independent SDK requires driver-side gating). See #674.
 */
export interface ResumeHandle {
  /** Driver name that created this handle (e.g. "claude-code", "codex"). */
  driver: string;
  /** Driver-specific resume token (session id, thread id, etc.). */
  token: string;
  /** Absolute cwd the session was created in. */
  originCwd: string;
}

/**
 * Configuration passed to an agent for phase execution.
 */
export interface AgentExecutionConfig {
  cwd: string;
  env: Record<string, string>;
  abortSignal?: AbortSignal;
  phaseTimeout: number;
  verbose: boolean;
  mcp: boolean;
  /**
   * Resume a previous session (driver-specific; ignored if unsupported).
   *
   * @deprecated Use {@link resumeHandle}. The opaque `sessionId` field is
   * retained for one release to keep in-flight `.sequant/state.json` records
   * resumable across upgrade. Drivers MUST prefer `resumeHandle` when both
   * are set. See #674.
   */
  sessionId?: string;
  /** Driver-tagged resume handle with originCwd for cwd-safe resume (#674). */
  resumeHandle?: ResumeHandle;
  /** Callback for streaming output */
  onOutput?: (text: string) => void;
  /** Callback for stderr */
  onStderr?: (text: string) => void;
  /** Relevant files for the phase (used by file-oriented drivers like Aider) */
  files?: string[];
}

/**
 * Result returned by an agent after executing a phase.
 */
export interface AgentPhaseResult {
  success: boolean;
  output: string;
  /**
   * @deprecated Use {@link resumeHandle}. Retained as a mirror of
   * `resumeHandle.token` for one release to ease state-file migration. See
   * #674.
   */
  sessionId?: string;
  /** Driver-tagged resume handle for cwd-safe cross-phase resume (#674). */
  resumeHandle?: ResumeHandle;
  error?: string;
  /**
   * Set when the agent hit its `maxTurns` ceiling (`error_max_turns`). The
   * `output` is partial-but-usable rather than a hard failure, so consumers
   * can treat it as inconclusive/incomplete instead of discarding the work.
   * See #733.
   */
  capped?: boolean;
  /**
   * Typed error carrying structured cause data (#732). Set by drivers that can
   * observe structured failure signals (e.g. ClaudeCodeDriver reading the SDK's
   * `rate_limit_event` / assistant `error`). The executor prefers this over
   * stderr-regex classification and uses its type to gate retry behavior (e.g.
   * skipping the MCP fallback for non-retryable billing failures). Left
   * undefined by drivers without structured signals (aider, subprocess paths).
   */
  structuredError?: SequantError;
  /** Last N lines of stderr captured via RingBuffer (#447) */
  stderrTail?: string[];
  /** Last N lines of stdout captured via RingBuffer (#447) */
  stdoutTail?: string[];
  /** Process exit code (undefined for SDK-based drivers) (#447) */
  exitCode?: number;
}

/**
 * Interface that all agent backends must implement.
 *
 * The driver is responsible for executing a prompt and returning
 * a structured result. Parsing (QA verdicts, etc.) stays in
 * phase-executor.ts — the driver just captures text.
 */
export interface AgentDriver {
  /** Human-readable name for logging */
  name: string;

  /** Execute a phase prompt and return structured result */
  executePhase(
    prompt: string,
    config: AgentExecutionConfig,
  ): Promise<AgentPhaseResult>;

  /** Check if this driver is available/configured */
  isAvailable(): Promise<boolean>;

  /**
   * Decide whether a resume handle can be safely used for a target cwd.
   *
   * Implementations enforce the asymmetric resume contract (#674):
   * - Claude Code: session storage is cwd-namespaced; resume only if cwds
   *   match byte-equal.
   * - Codex (when added in #497): runtime is cwd-independent; the driver
   *   enforces cwd match (and AGENTS.md parity) to prevent silent
   *   misexecution.
   * - Drivers without a session-resume concept return `false`.
   *
   * Drivers MUST also verify `handle.driver === this.name` and reject
   * cross-driver handles.
   */
  canResume(handle: ResumeHandle, targetCwd: string): boolean;
}
