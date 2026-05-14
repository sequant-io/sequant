/**
 * Types shared between RunRenderer modes (TTY, non-TTY, orchestrator).
 *
 * The renderer is event-driven: a `ProgressEvent` flows in and the renderer
 * decides whether to update the live zone, append an event line, or both.
 */

export type ProgressEventKind = "start" | "complete" | "failed";

/** Raw event from batch-executor `emitProgressLine` / `onProgress` callbacks. */
export interface ProgressEvent {
  issue: number;
  phase: string;
  event: ProgressEventKind;
  durationSeconds?: number;
  error?: string;
  /**
   * Quality-loop iteration (1-based). Set on the `loop` phase event and on
   * retried phase events (exec, qa, ...) once the outer loop iterates past 1.
   * Surfaced in the events log as `(attempt N/M)` and in the live-zone status
   * cell as `loop N/M` (#624 Item 3).
   */
  iteration?: number;
}

/** Per-phase status tracked inside the renderer state machine. */
export interface PhaseState {
  name: string;
  status: "pending" | "running" | "done" | "failed";
  startedAt?: number;
  durationMs?: number;
  /** Loop iteration label (e.g. "loop 2/3"). */
  loopIteration?: number;
  /**
   * #624 Item 4: normalized signature of the most recent failure for THIS
   * phase (ANSI-stripped, lowercased, first 80 chars, trimmed). Per-phase so
   * "same failure as attempt N" never references a different phase's attempt.
   */
  lastFailureSignature?: string;
  /**
   * #624 Item 4: 1-based attempt number for this phase when
   * `lastFailureSignature` was first observed. Referenced in the abbreviated
   * form `(attempt N/M, same failure as attempt K)`.
   */
  firstAttemptForSignature?: number;
}

/** Per-issue status tracked inside the renderer state machine. */
export interface IssueState {
  issueNumber: number;
  title?: string;
  worktreePath?: string;
  branch?: string;
  status: "queued" | "running" | "done" | "failed";
  phases: PhaseState[];
  currentPhase?: string;
  startedAt?: number;
  completedAt?: number;
  prNumber?: number;
  prUrl?: string;
  /** Optional sub-status line (e.g. "claude streaming · editing src/cli.ts"). */
  subStatus?: string;
  /** Last QA verdict / error reason for failed issues. */
  failureReason?: string;
  /**
   * AC-23: auto-detect mode — render `Phase: detecting…` until spec finishes
   * and the resolved plan is known.
   */
  autoDetect?: boolean;
}

/** Initial registration payload — fed at runner start so queued rows render. */
export interface IssueRegistration {
  issueNumber: number;
  title?: string;
  worktreePath?: string;
  branch?: string;
  /**
   * AC-23: when true, the issue runs in auto-detect mode. The renderer shows
   * `Phase: detecting…` while spec is running (before the resolved phase plan
   * is known) and switches to the normal phase header once spec completes.
   */
  autoDetect?: boolean;
}

/** Per-issue summary fields used by the final summary table. */
export interface IssueSummary {
  issueNumber: number;
  success: boolean;
  durationSeconds?: number;
  phases: Array<{ name: string; success: boolean }>;
  loopTriggered?: boolean;
  prNumber?: number;
  prUrl?: string;
  failureReason?: string;
  qaVerdict?: string;
  unmetCount?: number;
}

/** Inputs needed to render the final summary block. */
export interface SummaryRenderInput {
  issues: IssueSummary[];
  totalDurationSeconds?: number;
  logPath?: string | null;
  dryRun?: boolean;
}

/** Public renderer interface — all modes implement this. */
export interface RunRenderer {
  /** Register an issue so it shows as `queued` before the first phase event. */
  registerIssue(reg: IssueRegistration): void;
  /** Feed a progress event from batch-executor. */
  onEvent(event: ProgressEvent): void;
  /** Mark an issue as completed with PR info. Called by orchestrator. */
  setPullRequest(issue: number, prNumber: number, prUrl: string): void;
  /** Pause live updates so verbose streaming can write through. */
  pause(): void;
  /** Resume live updates after streaming ends. */
  resume(): void;
  /** Render the final summary block. */
  renderSummary(input: SummaryRenderInput): void;
  /** Tear down timers, cursor state, signal listeners. */
  dispose(): void;
}

/**
 * Options shared by every renderer mode. Most are optional; defaults match
 * production behaviour (real stdout, real timers, real signals).
 */
export interface RenderOptions {
  /** Override stdout writer. Defaults to `process.stdout.write`. */
  stdoutWrite?: (s: string) => void;
  /** Override stderr writer. Defaults to `process.stderr.write`. */
  stderrWrite?: (s: string) => void;
  /** Override clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Override "wall clock" used for non-TTY timestamps. Defaults to `() => new Date()`. */
  wallClock?: () => Date;
  /** Override TTY detection. Defaults to `process.stdout.isTTY`. */
  isTTY?: boolean;
  /** Override terminal column count. Defaults to `process.stdout.columns`. */
  columns?: number;
  /** Disable color output (NO_COLOR). */
  noColor?: boolean;
  /** Heartbeat tick interval for the live zone (ms). Defaults to 1000. */
  liveTickMs?: number;
  /** Idle heartbeat interval for non-TTY mode (ms). Defaults to 60_000. */
  nonTtyHeartbeatMs?: number;
  /** Don't subscribe to SIGWINCH (used in tests). */
  noSignalListeners?: boolean;
  /**
   * AC-26: when a running phase has been active for longer than this many ms
   * with no completion event, the status header flips to `⚠ stalled · …`.
   * Defaults to half the phase timeout when wired from settings; effectively
   * disabled (10× the default heartbeat) when omitted.
   */
  stallThresholdMs?: number;
  /**
   * AC-28: cap visible per-issue rows in the multi-issue live grid. When the
   * total issue count exceeds this, the oldest done rows roll up into a
   * single `✔ {N} done` summary row at the top. Defaults to 10.
   */
  multiIssueRowCap?: number;
  /**
   * #624 Item 1: terminal row count. The TTY live zone caps its frame height
   * at `max(8, rows - 5)` so `log-update` never deals with a frame taller than
   * the terminal — otherwise it loses cursor tracking and appends fresh frames
   * instead of replacing them. Defaults to `process.stdout.rows` or 24.
   */
  rows?: number;
  /**
   * #624 Item 3 / D2: total allowed quality-loop iterations. Used by every
   * retry-suffix site (`(attempt N/M)` / `loop N/M`) so the M denominator
   * tracks the configured maximum instead of being hardcoded. Defaults to 3.
   */
  maxLoopIterations?: number;
  /**
   * When true, `renderSummary` is rendered even if no issues were registered.
   * Default: false (matches existing displaySummary behaviour).
   */
  alwaysRenderSummary?: boolean;
  /**
   * #647: inject a `log-update` instance (typically built via
   * `createLogUpdate(stream)` against a custom stream). Used by the
   * scrollback-harness regression test to drive the real `log-update`
   * through a virtual terminal that tracks scrollback. When set, this takes
   * precedence over both `stdoutWrite` (for the log-update path) and the
   * default `process.stdout`-bound `logUpdate` import.
   *
   * Production code never sets this. Tests that need to assert on
   * `log-update`'s actual erase semantics use it to replace the test stub.
   */
  logUpdateInstance?: {
    (text: string): void;
    clear(): void;
    done(): void;
  };
}

/**
 * Mode the renderer should run in. Auto-detected by `createRunRenderer` from
 * env + TTY, but explicit selection is supported for tests.
 */
export type RendererMode = "tty" | "non-tty" | "orchestrator";
