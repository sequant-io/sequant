/**
 * AgentDriver interface — decouples workflow orchestration from agent execution.
 *
 * Claude Code is the default implementation; alternatives (Aider, Codex CLI,
 * Continue.dev, Copilot SDK, Cursor API) can be added by implementing this
 * interface without touching orchestration logic.
 */

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
  /** Resume a previous session (driver-specific; ignored if unsupported) */
  sessionId?: string;
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
  sessionId?: string;
  error?: string;
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
}
