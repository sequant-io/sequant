/**
 * RunRenderer — single coordinator for all `sequant run` stdout output.
 *
 * Replaces the dual-output regression where `PhaseSpinner` (legacy, #244) and
 * the parallel-mode `▸/✔` lines (#458) both wrote to stdout for single-issue
 * runs and produced overwritten / missing-duration lines.
 *
 * Three modes implement the same `RunRenderer` interface:
 *   - TTYRenderer:           live grid (top, redrawn ~1Hz) + events log (below)
 *   - NonTTYRenderer:        append-only `[HH:MM:SS]` events + 60s heartbeat
 *   - OrchestratorRenderer:  no-op when SEQUANT_ORCHESTRATOR is set so MCP's
 *                            `emitProgressLine` JSON is the only stdout
 *
 * See issue #618.
 */

import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import logUpdate from "log-update";
import stringWidth from "string-width";
import { formatElapsedTime, formatTimestamp } from "./format.js";
import type { PhasePauseHandle } from "../workflow/types.js";
import type {
  IssueRegistration,
  IssueState,
  IssueSummary,
  PhaseState,
  ProgressEvent,
  RenderOptions,
  RendererMode,
  RunRenderer,
  SummaryRenderInput,
} from "./run-renderer-types.js";

const DEFAULT_LIVE_TICK_MS = 1000;
const DEFAULT_NON_TTY_HEARTBEAT_MS = 60_000;
const NARROW_TERMINAL_THRESHOLD = 80;
const DEFAULT_MULTI_ISSUE_ROW_CAP = 10;
// Generous default: in production, TTY mode always has `process.stdout.rows`
// set, so this only matters in tests and detached stdout. A high default avoids
// over-constraining multi-issue test scenarios while keeping the height cap
// active enough to catch pathological frames.
const DEFAULT_TERMINAL_ROWS = 100;
const DEFAULT_MAX_LOOP_ITERATIONS = 3;
const SUMMARY_COLUMN_CAP = 110;
const FAILURE_SIGNATURE_LENGTH = 80;
const FAIL_REASON_TRUNCATE_LENGTH = 40;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Colour helpers — bypassed cleanly when `noColor` is true.
function colorize(noColor: boolean) {
  if (noColor) {
    const id = (s: string) => s;
    return {
      dim: id,
      green: id,
      red: id,
      yellow: id,
      cyan: id,
      gray: id,
      bold: id,
    };
  }
  return {
    dim: chalk.dim,
    green: chalk.green,
    red: chalk.red,
    yellow: chalk.yellow,
    cyan: chalk.cyan,
    gray: chalk.gray,
    bold: chalk.bold,
  };
}

// ============================================================================
// Shared helpers (#624)
// ============================================================================

/**
 * #624 Item 4: normalized failure signature for dedup decisions.
 *
 * Strips ANSI escape sequences, lowercases, trims whitespace, and truncates to
 * the first 80 visible chars. The plan deliberately chose a length-bounded
 * prefix over a crypto hash so debugging can match signatures by eye.
 */
export function failureSignature(error: string | undefined): string {
  if (!error) return "";
  // eslint-disable-next-line no-control-regex
  const stripped = error.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  return stripped.trim().toLowerCase().slice(0, FAILURE_SIGNATURE_LENGTH);
}

/**
 * #624 Item 3 / Derived AC-D2: shared suffix builder used by all three retry
 * sites (NonTTY events log, TTY events log, TTY status header). Centralizes
 * the `(attempt N/M)` / `loop N/M` literals so they cannot drift between paths.
 *
 * `kind` selects the surface:
 *   - "events" → events-log line: leading space + parentheses
 *   - "header" → status cell: leading space, no parentheses
 *
 * Returns the empty string when the attempt counter does not apply
 * (no iteration, iteration === 1, or non-positive).
 */
export function formatRetrySuffix(
  iteration: number | undefined,
  maxIterations: number,
  kind: "events" | "header",
): string {
  if (!iteration || iteration <= 1) return "";
  const counter = `${iteration}/${maxIterations}`;
  if (kind === "events") return ` (attempt ${counter})`;
  return ` ${counter}`;
}

// ============================================================================
// Shared state machine
// ============================================================================

abstract class BaseRenderer implements RunRenderer, PhasePauseHandle {
  protected readonly issues = new Map<number, IssueState>();
  protected readonly stdoutWrite: (s: string) => void;
  protected readonly stderrWrite: (s: string) => void;
  protected readonly now: () => number;
  protected readonly wallClock: () => Date;
  protected readonly noColor: boolean;
  protected readonly runStartedAt: number;
  protected paused = false;
  protected disposed = false;

  constructor(options: RenderOptions) {
    this.stdoutWrite =
      options.stdoutWrite ?? ((s: string) => void process.stdout.write(s));
    this.stderrWrite =
      options.stderrWrite ?? ((s: string) => void process.stderr.write(s));
    this.now = options.now ?? Date.now;
    this.wallClock = options.wallClock ?? (() => new Date());
    this.noColor = Boolean(options.noColor) || Boolean(process.env.NO_COLOR);
    this.runStartedAt = this.now();
  }

  registerIssue(reg: IssueRegistration): void {
    if (this.issues.has(reg.issueNumber)) return;
    // #672 AC-2: seed pending cells when the plan is known at registration.
    // Empty arrays fall back to streaming-only behaviour (AC-2 edge case).
    const phases: PhaseState[] =
      reg.plannedPhases && reg.plannedPhases.length > 0
        ? reg.plannedPhases.map((name) => ({ name, status: "pending" }))
        : [];
    this.issues.set(reg.issueNumber, {
      issueNumber: reg.issueNumber,
      title: reg.title,
      worktreePath: reg.worktreePath,
      branch: reg.branch,
      autoDetect: reg.autoDetect,
      status: "queued",
      phases,
    });
    this.afterStateChange();
  }

  setPhasePlan(issue: number, phases: string[]): void {
    const state = this.issues.get(issue);
    if (!state) return;
    // #672 AC-2: rebuild the phase array from the resolved plan, preserving
    // any phase state already captured from events that fired before the plan
    // resolved (e.g. spec ran first in auto-detect mode and finished before
    // setPhasePlan landed). Phases already seen keep their state; new planned
    // phases enter as `pending`.
    const existing = new Map(state.phases.map((p) => [p.name, p]));
    state.phases = phases.map(
      (name) => existing.get(name) ?? { name, status: "pending" },
    );
    // Any previously-seen phases that aren't in the new plan still belong on
    // the row — they actually ran. Append them at the end so the planned order
    // is preserved for unplayed phases.
    for (const prev of existing.values()) {
      if (!phases.includes(prev.name)) state.phases.push(prev);
    }
    this.afterStateChange();
  }

  onEvent(event: ProgressEvent): void {
    if (this.disposed) return;
    let state = this.issues.get(event.issue);
    if (!state) {
      state = {
        issueNumber: event.issue,
        status: "queued",
        phases: [],
      };
      this.issues.set(event.issue, state);
    }
    this.applyEvent(state, event);
    this.afterEvent(event, state);
  }

  setPullRequest(issue: number, prNumber: number, prUrl: string): void {
    const state = this.issues.get(issue);
    if (!state) return;
    state.prNumber = prNumber;
    state.prUrl = prUrl;
    this.afterStateChange();
  }

  pause(): void {
    this.paused = true;
    this.onPause();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.onResume();
  }

  /**
   * #647 AC-3: default notice path — just write to the renderer's stdout
   * channel. NonTTYRenderer keeps this default (no live zone to manage).
   * TTYRenderer overrides to clear the live zone before writing so
   * log-update's cursor model stays consistent with the actual terminal.
   */
  appendNotice(message: string): void {
    if (this.disposed) return;
    this.stdoutWrite(message + "\n");
  }

  abstract renderSummary(input: SummaryRenderInput): void;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose();
  }

  // ------------ State machine ------------

  protected applyEvent(state: IssueState, event: ProgressEvent): void {
    const phaseName = event.phase;
    let phase = state.phases.find((p) => p.name === phaseName);
    if (!phase) {
      phase = { name: phaseName, status: "pending" };
      state.phases.push(phase);
    }

    if (event.event === "start") {
      if (state.startedAt === undefined) state.startedAt = this.now();
      state.status = "running";
      state.currentPhase = phaseName;
      phase.status = "running";
      phase.startedAt = this.now();
      if (event.iteration !== undefined) {
        phase.loopIteration = event.iteration;
      }
      // Clear any sub-status from a prior phase.
      state.subStatus = undefined;
      return;
    }

    if (event.event === "complete") {
      phase.status = "done";
      if (event.durationSeconds !== undefined) {
        phase.durationMs = event.durationSeconds * 1000;
      } else if (phase.startedAt !== undefined) {
        phase.durationMs = this.now() - phase.startedAt;
      }
      if (state.currentPhase === phaseName) state.currentPhase = undefined;
      return;
    }

    // failed
    phase.status = "failed";
    if (event.durationSeconds !== undefined) {
      phase.durationMs = event.durationSeconds * 1000;
    } else if (phase.startedAt !== undefined) {
      phase.durationMs = this.now() - phase.startedAt;
    }
    state.status = "failed";
    state.completedAt = this.now();
    state.currentPhase = undefined;
    if (event.error !== undefined) state.failureReason = event.error;

    // #624 Item 4: update failure dedup metadata on the PHASE (not the issue).
    // Per-phase tracking ensures "same failure as attempt N" only references
    // prior attempts of THIS phase — exec failing with "boom" followed by qa
    // failing with "boom" no longer abbreviates qa as "same failure as attempt 1"
    // when attempt 1 was an exec failure.
    const sig = failureSignature(event.error);
    const currentAttempt = phase.loopIteration ?? 1;
    if (phase.lastFailureSignature !== sig) {
      phase.lastFailureSignature = sig;
      phase.firstAttemptForSignature = currentAttempt;
    }
  }

  /** Mark an issue done after PR is recorded — derived from phase completion. */
  protected maybeMarkIssueDone(state: IssueState): void {
    if (state.status === "failed") return;
    const allTerminal = state.phases.every(
      (p) => p.status === "done" || p.status === "failed",
    );
    if (allTerminal && state.phases.length > 0) {
      state.status = state.phases.some((p) => p.status === "failed")
        ? "failed"
        : "done";
      state.completedAt = this.now();
    }
  }

  // ------------ Hooks for subclasses ------------

  protected afterEvent(_event: ProgressEvent, state: IssueState): void {
    if (state.status !== "failed") this.maybeMarkIssueDone(state);
    this.afterStateChange();
  }

  protected afterStateChange(): void {
    /* default: no-op */
  }

  protected onPause(): void {
    /* default: no-op */
  }

  protected onResume(): void {
    /* default: no-op */
  }

  protected onDispose(): void {
    /* default: no-op */
  }
}

// ============================================================================
// Orchestrator (MCP) renderer — fully suppressed
// ============================================================================

/**
 * No-op renderer used when `SEQUANT_ORCHESTRATOR` is set.
 *
 * The orchestrator (e.g. MCP server) consumes `emitProgressLine` JSON from
 * batch-executor directly. Rendering anything else from the CLI would be
 * double-emission. We still track state so `renderSummary` could be useful
 * if explicitly invoked, but neither stdout nor stderr is touched.
 */
export class OrchestratorRenderer extends BaseRenderer {
  renderSummary(): void {
    /* AC-18: orchestrator path emits no human-readable summary. */
  }
}

// ============================================================================
// Non-TTY renderer — append-only with timestamps + 60s heartbeat
// ============================================================================

export class NonTTYRenderer extends BaseRenderer {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatMs: number;
  private readonly columnsOverride?: number;
  private readonly maxLoopIterations: number;
  private lastEventAt: number;

  constructor(options: RenderOptions) {
    super(options);
    this.heartbeatMs =
      options.nonTtyHeartbeatMs ?? DEFAULT_NON_TTY_HEARTBEAT_MS;
    this.columnsOverride = options.columns;
    this.maxLoopIterations =
      options.maxLoopIterations ?? DEFAULT_MAX_LOOP_ITERATIONS;
    this.lastEventAt = this.now();
    this.startHeartbeat();
  }

  private getColumns(): number {
    return (
      this.columnsOverride ??
      (process.stdout.columns && process.stdout.columns > 0
        ? process.stdout.columns
        : 100)
    );
  }

  private startHeartbeat(): void {
    if (this.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(
      () => this.tickHeartbeat(),
      this.heartbeatMs,
    );
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  /** Test hook: drive a heartbeat without waiting on real timers. */
  tickHeartbeatNow(): void {
    this.tickHeartbeat();
  }

  private tickHeartbeat(): void {
    if (this.disposed || this.paused) return;
    if (this.now() - this.lastEventAt < this.heartbeatMs) return;
    const running = [...this.issues.values()].filter(
      (s) => s.status === "running" && s.currentPhase,
    );
    if (running.length === 0) return;
    const parts = running.map((s) => {
      const elapsedSec =
        s.startedAt !== undefined ? (this.now() - s.startedAt) / 1000 : 0;
      return `#${s.issueNumber} ${s.currentPhase} (${formatElapsedTime(elapsedSec)})`;
    });
    this.emitLine(`⏱ still running: ${parts.join(", ")}`);
  }

  protected afterEvent(event: ProgressEvent, state: IssueState): void {
    super.afterEvent(event, state);
    this.lastEventAt = this.now();
    this.emitEventLine(event, state);
  }

  private emitEventLine(event: ProgressEvent, state: IssueState): void {
    const c = colorize(this.noColor);
    const phase = state.phases.find((p) => p.name === event.phase);
    // #624 Item 3: non-loop phase events on retry get `(attempt N/M)`.
    // The loop phase itself stays unannotated in the events log (the live zone
    // shows `loop N/M · last fail: …` already; double-counting would be noise).
    const retrySuffix =
      event.phase === "loop"
        ? ""
        : formatRetrySuffix(
            phase?.loopIteration,
            this.maxLoopIterations,
            "events",
          );
    if (event.event === "start") {
      this.emitLine(
        `${c.cyan("▸")} #${event.issue} ${event.phase}${retrySuffix}`,
      );
    } else if (event.event === "complete") {
      const durStr =
        event.durationSeconds !== undefined
          ? ` ${formatElapsedTime(event.durationSeconds)}`
          : "";
      this.emitLine(
        `${c.green("✔")} #${event.issue} ${event.phase}${retrySuffix}${durStr}`,
      );
    } else {
      // #624 Item 4: failure dedup. The third tier (final attempt) emits the
      // full text even when the signature repeats, so divergent failures stay
      // visible right up to max-iter. Dedup state is per-phase so cross-phase
      // signature collisions don't produce misleading "attempt N" references.
      const attempt = phase?.loopIteration ?? 1;
      const dedup = phase
        ? decideDedup(phase, attempt, this.maxLoopIterations)
        : "full";
      if (dedup === "abbreviated" && phase) {
        this.emitLine(
          `${c.red("✘")} #${event.issue} ${event.phase}${retrySuffix} (same failure as attempt ${phase.firstAttemptForSignature})`,
        );
      } else {
        const errStr = event.error ? ` ${c.red(event.error)}` : "";
        this.emitLine(
          `${c.red("✘")} #${event.issue} ${event.phase}${retrySuffix}${errStr}`,
        );
      }
    }
  }

  /** Append a single `\n`-terminated line with `[HH:MM:SS]` prefix. */
  private emitLine(text: string): void {
    const ts = formatTimestamp(this.wallClock());
    const c = colorize(this.noColor);
    this.stdoutWrite(`${c.dim(`[${ts}]`)} ${text}\n`);
  }

  setPullRequest(issue: number, prNumber: number, prUrl: string): void {
    super.setPullRequest(issue, prNumber, prUrl);
    const c = colorize(this.noColor);
    this.emitLine(`${c.green("→")} #${issue} PR #${prNumber} ${c.dim(prUrl)}`);
  }

  renderSummary(input: SummaryRenderInput): void {
    if (this.disposed) return;
    // #624 Item 2 (AC-2.3): share the same column source/cap as the TTY path
    // so the summary table is never rendered at a divergent width that pushes
    // the rightmost border off-screen.
    renderSummaryBlock(input, {
      stdoutWrite: this.stdoutWrite,
      noColor: this.noColor,
      columns: Math.min(this.getColumns(), SUMMARY_COLUMN_CAP),
    });
  }

  protected onDispose(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// ============================================================================
// Failure dedup shared decision (#624 Item 4)
// ============================================================================

/**
 * Three-state machine for failure dedup. Returns "abbreviated" when the
 * incoming failure signature matches a prior attempt of THIS phase AND we
 * haven't yet reached the final allowed attempt; otherwise "full" so
 * divergence and last-chance failures stay fully visible in the events log.
 *
 * Per-phase (not per-issue) so cross-phase signature collisions don't produce
 * misleading "same failure as attempt N" text — N would otherwise point at a
 * different phase's attempt.
 */
function decideDedup(
  phase: PhaseState,
  currentAttempt: number,
  maxIterations: number,
): "abbreviated" | "full" {
  // `applyEvent` already updated `phase.lastFailureSignature` and
  // `phase.firstAttemptForSignature` before the emit code runs. So we dedup
  // when the first-seen attempt is strictly earlier than the current one.
  const firstAttempt = phase.firstAttemptForSignature;
  if (firstAttempt === undefined || firstAttempt >= currentAttempt) {
    return "full";
  }
  if (currentAttempt >= maxIterations) {
    return "full";
  }
  return "abbreviated";
}

// ============================================================================
// TTY renderer — log-update live zone + append-only events log
// ============================================================================

/**
 * #624 Derived AC-D1: test-only observability for the log-update stub. Tests
 * can read `replacementCount` and `lastFrame` to verify the frame is *replaced*
 * on each redraw rather than appended — the foundational guarantee that Items
 * 1 and 2 rely on.
 *
 * `clearCalls` / `doneCalls` (added in the hardening pass) let AC-2.2 verify
 * the renderer actually invokes `logUpdate.clear()` + `logUpdate.done()` during
 * `renderSummary` teardown — not just that the stub's local `lastFrame` was
 * reset.
 */
export interface TTYTestStub {
  /** Number of times the live frame was replaced (not the initial write). */
  readonly replacementCount: number;
  /** The most recent live frame text passed to log-update. */
  readonly lastFrame: string;
  /** Number of times `logUpdate.clear()` was invoked. */
  readonly clearCalls: number;
  /** Number of times `logUpdate.done()` was invoked. */
  readonly doneCalls: number;
}

export class TTYRenderer extends BaseRenderer {
  private readonly liveTickMs: number;
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private readonly columnsOverride?: number;
  private readonly rowsOverride?: number;
  private readonly noSignalListeners: boolean;
  private readonly stallThresholdMs: number;
  private readonly multiIssueRowCap: number;
  private readonly maxLoopIterations: number;
  private readonly logUpdateImpl: (text: string) => void;
  private readonly logUpdateClear: () => void;
  private readonly logUpdateDone: () => void;
  private resizeListener: (() => void) | null = null;
  private banner: string | null = null;
  private readonly _testStub: {
    replacementCount: number;
    lastFrame: string;
    clearCalls: number;
    doneCalls: number;
  } | null;

  constructor(options: RenderOptions) {
    super(options);
    this.liveTickMs = options.liveTickMs ?? DEFAULT_LIVE_TICK_MS;
    this.columnsOverride = options.columns;
    this.rowsOverride = options.rows;
    this.noSignalListeners = Boolean(options.noSignalListeners);
    // AC-26: stall threshold disabled by default (Number.POSITIVE_INFINITY); the
    // wiring layer derives a real value from settings.run.timeout when available.
    this.stallThresholdMs =
      options.stallThresholdMs ?? Number.POSITIVE_INFINITY;
    this.multiIssueRowCap =
      options.multiIssueRowCap ?? DEFAULT_MULTI_ISSUE_ROW_CAP;
    this.maxLoopIterations =
      options.maxLoopIterations ?? DEFAULT_MAX_LOOP_ITERATIONS;

    // #647 AC-1: render-state instrumentation gated on `SEQUANT_DEBUG_RENDERER=1`.
    // Emits one JSON line per log-update callsite so a production replay shows
    // exactly which mechanism from the #647 issue body is firing (column/row
    // mismatch, wrap-induced row inflation, etc.). The trace doubles as the
    // evidence required by AC-1's "Pick the fix direction from §2 only after
    // instrumentation confirms the mechanism." sub-bullet.
    //
    // #664: routes to a file sink instead of stderr. In any terminal where
    // stdout and stderr share a pty (the normal case), stderr writes scroll
    // the terminal between log-update redraws — log-update has no record of
    // them, so `eraseLines(previousLineCount)` misses rows and the prior
    // frame's top survives in scrollback. The AC-1 capture's "2181×" headline
    // was 2171× of this amplifier, not the underlying #647 bug. Sinking to
    // a file removes the amplifier while preserving identical JSON schema +
    // per-op cadence for diagnostic replay.
    const debugEnabled = process.env.SEQUANT_DEBUG_RENDERER === "1";
    let debugFd: number | null = null;
    if (debugEnabled) {
      // Default sink resolves against `process.cwd()` — matches the rest of
      // the codebase's `.sequant/` convention (see `src/lib/relay/paths.ts:39`,
      // `src/lib/ci/config.ts:42`). Invoking `sequant` from a subdirectory
      // puts the file under that subdirectory's `.sequant/`, where the project
      // root's `.sequant/*` gitignore does not reach — pass an absolute
      // override via `SEQUANT_DEBUG_RENDERER_FILE` if that's a concern.
      //
      // `||` not `??`: treat an empty SEQUANT_DEBUG_RENDERER_FILE as "use
      // default" rather than passing "" to openSync (which would throw and
      // suppress all debug output via the fallback path). Locked in by the
      // "AC-2 + empty string" test in scrollback-harness.test.ts.
      const debugPath =
        process.env.SEQUANT_DEBUG_RENDERER_FILE ||
        path.join(process.cwd(), ".sequant", "debug-renderer.jsonl");
      try {
        fs.mkdirSync(path.dirname(debugPath), { recursive: true });
        debugFd = fs.openSync(debugPath, "a");
      } catch (err) {
        // Fall through to no-op rather than crashing the run. One-shot
        // startup notice so the user sees why debug output didn't appear.
        const msg = err instanceof Error ? err.message : String(err);
        this.stderrWrite(
          `SEQUANT_DEBUG_RENDERER: file sink unavailable at ${debugPath} (${msg}), debug output suppressed\n`,
        );
        debugFd = null;
      }
    }
    let frameCounter = 0;
    const emitDebug = (op: "impl" | "clear" | "done", text?: string) => {
      if (debugFd === null) return;
      // log-update's render path is roughly:
      //   output = wrapAnsi(text + "\n", stream.columns, {trim:false, hard:true})
      //   previousLineCount = output.split("\n").length
      // So `previousLineCount` is wrap-aware: a 100-char line in an 80-col
      // stream counts as 2, not 1. We approximate that here using `stringWidth`
      // (already a dep) instead of `text.split("\n").length`. The metric is
      // intentionally an approximation — wrap-ansi has word-breaking nuances
      // — but it's correct enough to spot the diagnostic case AC-1 cares
      // about: when this count diverges from the actual on-terminal row
      // count, log-update's `eraseLines` will undershoot.
      const streamCols =
        process.stdout.columns ?? this.getColumns() ?? Infinity;
      let logicalLines: number | undefined;
      let wrappedLineCount: number | undefined;
      if (text !== undefined) {
        const lines = text.split("\n");
        logicalLines = lines.length + (text.endsWith("\n") ? 0 : 1);
        wrappedLineCount = lines.reduce((acc, line) => {
          const w = stringWidth(line);
          return acc + Math.max(1, Math.ceil(w / streamCols));
        }, 0);
        // log-update appends a trailing \n before wrapping, so count it.
        if (!text.endsWith("\n")) wrappedLineCount++;
      }
      const record = {
        t: this.now() - this.runStartedAt,
        op,
        frame: frameCounter,
        rendererCols: this.getColumns(),
        rendererRows: this.getRows(),
        stdoutCols: process.stdout.columns ?? null,
        stdoutRows: process.stdout.rows ?? null,
        logicalLines,
        wrappedLineCount,
      };
      // Sync append. `O_APPEND` guarantees atomic per-line writes on POSIX,
      // and the fd lives for the process lifetime — no close on dispose
      // because late-fire callbacks could still emit after teardown begins.
      fs.writeSync(
        debugFd,
        `SEQUANT_DEBUG_RENDERER ${JSON.stringify(record)}\n`,
      );
    };

    // log-update writes to process.stdout via a mutable global instance. When
    // tests inject `stdoutWrite`, route renders through it instead so capture
    // works deterministically. The #647 harness tests instead inject a real
    // `log-update` instance bound to a virtual terminal — that path bypasses
    // the stub so we can assert on actual cursor/erase semantics.
    if (options.logUpdateInstance) {
      // #647: harness path — drive a real `createLogUpdate(stream)` instance
      // so the scrollback-aware regression test sees the same ANSI cursor
      // operations a production user's terminal would receive. Stub is left
      // null because the harness asserts on the VirtualTerminal directly.
      const lu = options.logUpdateInstance;
      this._testStub = null;
      this.logUpdateImpl = (text: string) => {
        frameCounter++;
        emitDebug("impl", text);
        lu(text);
      };
      this.logUpdateClear = () => {
        emitDebug("clear");
        lu.clear();
      };
      this.logUpdateDone = () => {
        emitDebug("done");
        lu.done();
      };
    } else if (options.stdoutWrite) {
      // #624 Derived AC-D1: replacement-aware test stub. Tracks each frame
      // replacement so tests can assert on frame churn without parsing buf.out.
      // `clearCalls` / `doneCalls` verify the renderer actually invokes the
      // teardown methods (not just resets local state).
      const stub = {
        replacementCount: 0,
        lastFrame: "",
        clearCalls: 0,
        doneCalls: 0,
      };
      this._testStub = stub;
      this.logUpdateImpl = (text: string) => {
        frameCounter++;
        emitDebug("impl", text);
        if (stub.lastFrame) stub.replacementCount++;
        stub.lastFrame = text;
        options.stdoutWrite!(text + "\n");
      };
      this.logUpdateClear = () => {
        emitDebug("clear");
        stub.clearCalls++;
        stub.lastFrame = "";
      };
      this.logUpdateDone = () => {
        emitDebug("done");
        stub.doneCalls++;
        stub.lastFrame = "";
      };
    } else {
      this._testStub = null;
      this.logUpdateImpl = (text: string) => {
        frameCounter++;
        emitDebug("impl", text);
        logUpdate(text);
      };
      this.logUpdateClear = () => {
        emitDebug("clear");
        logUpdate.clear();
      };
      this.logUpdateDone = () => {
        emitDebug("done");
        logUpdate.done();
      };
    }

    this.startLiveTimer();
    this.installSignalListeners();
  }

  /**
   * #624 Derived AC-D1: expose the test-only log-update stub. Returns `null`
   * when not in test mode (production renders go through real `log-update`).
   *
   * #647 AC-D3 warning: this stub does NOT model `log-update`'s ANSI cursor
   * or scrollback semantics. Tests that assert on `stub.lastFrame` only see
   * the most recent frame, not whether earlier frames remained stranded in
   * scrollback. Header-count / duplicate-header assertions MUST use
   * `scrollback-harness.ts` (real `createLogUpdate` + VirtualTerminal),
   * otherwise they will pass green even when the production rendering is
   * broken — see #624 for the precedent.
   */
  getTestStub(): TTYTestStub | null {
    return this._testStub;
  }

  private startLiveTimer(): void {
    if (this.liveTickMs <= 0) return;
    this.liveTimer = setInterval(() => this.tick(), this.liveTickMs);
    if (typeof this.liveTimer.unref === "function") {
      this.liveTimer.unref();
    }
  }

  private installSignalListeners(): void {
    if (this.noSignalListeners) return;
    this.resizeListener = () => this.redraw();
    process.on("SIGWINCH", this.resizeListener);
  }

  /** Test hook: drive a tick without waiting on real timers. */
  tickNow(): void {
    this.tick();
  }

  private tick(): void {
    if (this.disposed || this.paused) return;
    this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
    this.redraw();
  }

  protected afterEvent(event: ProgressEvent, state: IssueState): void {
    super.afterEvent(event, state);
    if (this.paused || this.disposed) return;
    // Append the event line first (above the live zone in append order),
    // then redraw the live zone below it.
    this.appendEventLine(event, state);
    this.redraw();
  }

  protected afterStateChange(): void {
    if (this.paused || this.disposed) return;
    this.redraw();
  }

  /** Set a banner that renders above the live grid (e.g. worktree-loss). */
  setBanner(text: string | null): void {
    this.banner = text;
    this.redraw();
  }

  private appendEventLine(event: ProgressEvent, state: IssueState): void {
    // #672 AC-1: drop the `▸ start` journal line. The live zone already shows
    // the phase as running in place, so appending a permanent scrollback line
    // duplicates that information and produces the "two-row" visual reported
    // in #672. `complete` and `failed` still append (they are the durable
    // record of what ran). The redraw in `afterEvent` keeps the live zone
    // fresh so the transition pending → running is still visible.
    if (event.event === "start") return;
    // Clear the live zone so the appended event becomes a real `console.log`
    // line above it; the live zone redraws below.
    this.logUpdateClear();
    const c = colorize(this.noColor);
    const phase = state.phases.find((p) => p.name === event.phase);
    // #624 Item 3: shared retry-suffix helper. The `loop` phase has its own
    // running indicator in the live zone, so we don't double-annotate it here.
    const retrySuffix =
      event.phase === "loop"
        ? ""
        : formatRetrySuffix(
            phase?.loopIteration,
            this.maxLoopIterations,
            "events",
          );
    let line: string;
    if (event.event === "complete") {
      const durStr =
        event.durationSeconds !== undefined
          ? `  ${formatElapsedTime(event.durationSeconds)}`
          : "";
      const prSuffix = state.prUrl ? `  →  PR #${state.prNumber}` : "";
      line = `  ${c.green("✔")} #${event.issue} ${event.phase}${retrySuffix}${durStr}${prSuffix}`;
    } else {
      // #624 Item 4: failure dedup. Abbreviated form only fires when the
      // signature matches a *prior* attempt of THIS phase and we are not at
      // the final allowed iteration (preserves divergence visibility).
      const attempt = phase?.loopIteration ?? 1;
      const dedup = phase
        ? decideDedup(phase, attempt, this.maxLoopIterations)
        : "full";
      if (dedup === "abbreviated" && phase) {
        line = `  ${c.red("✘")} #${event.issue} ${event.phase}${retrySuffix} (same failure as attempt ${phase.firstAttemptForSignature})`;
      } else {
        const errStr = event.error ? `  ${c.red(event.error)}` : "";
        line = `  ${c.red("✘")} #${event.issue} ${event.phase}${retrySuffix}${errStr}`;
      }
    }
    this.stdoutWrite(line + "\n");
  }

  setPullRequest(issue: number, prNumber: number, prUrl: string): void {
    super.setPullRequest(issue, prNumber, prUrl);
    if (this.paused || this.disposed) return;
    this.logUpdateClear();
    const c = colorize(this.noColor);
    this.stdoutWrite(
      `  ${c.green("→")} #${issue}  PR #${prNumber}  ${c.dim(prUrl)}\n`,
    );
    this.redraw();
  }

  renderSummary(input: SummaryRenderInput): void {
    if (this.disposed) return;
    // #624 Item 2: tear down the live zone *before* writing the summary so any
    // subsequent `console.log` from displaySummary (reflection block, merge
    // tip) cannot overlap with the trailing border of the summary table.
    this.logUpdateClear();
    this.logUpdateDone();
    if (this.liveTimer !== null) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
    // #624 Item 2 (AC-2.3): clamp summary columns to SUMMARY_COLUMN_CAP so wide
    // terminals don't produce a grid that overflows narrower readers (CI logs,
    // VS Code terminal panes).
    renderSummaryBlock(input, {
      stdoutWrite: this.stdoutWrite,
      noColor: this.noColor,
      columns: Math.min(this.getColumns(), SUMMARY_COLUMN_CAP),
    });
  }

  protected onPause(): void {
    // Clear the live zone so verbose streaming has clean stdout.
    this.logUpdateClear();
  }

  protected onResume(): void {
    // Live zone redraws on next tick / event automatically.
    this.redraw();
  }

  /**
   * #647 AC-3: TTYRenderer override. Writes the notice above the live zone
   * the same way `appendEventLine` does (clear → write → redraw), so
   * log-update's `previousLineCount` stays consistent with the actual
   * terminal state. If the renderer is already paused (e.g., during
   * verbose subprocess streaming), skip the clear/redraw and just write;
   * the eventual `resume()` will redraw cleanly.
   */
  appendNotice(message: string): void {
    if (this.disposed) return;
    if (this.paused) {
      this.stdoutWrite(message + "\n");
      return;
    }
    this.logUpdateClear();
    this.stdoutWrite(message + "\n");
    this.redraw();
  }

  protected onDispose(): void {
    if (this.liveTimer !== null) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
    if (this.resizeListener) {
      process.removeListener("SIGWINCH", this.resizeListener);
      this.resizeListener = null;
    }
    this.logUpdateClear();
    this.logUpdateDone();
  }

  // ---------------- Layout ----------------

  private getColumns(): number {
    return (
      this.columnsOverride ??
      (process.stdout.columns && process.stdout.columns > 0
        ? process.stdout.columns
        : 100)
    );
  }

  /**
   * #624 Item 1: terminal row count, with a safe default for piped / detached
   * stdout where `process.stdout.rows` is undefined.
   */
  private getRows(): number {
    if (this.rowsOverride !== undefined) return this.rowsOverride;
    const r = process.stdout.rows;
    return r && r > 0 ? r : DEFAULT_TERMINAL_ROWS;
  }

  /**
   * #624 Item 1: hard ceiling on live-zone height. The cap is
   * `max(8, rows - 5)`, dropping to `max(8, rows - 7)` when a banner is active
   * so the banner + a few separator rows still fit. The floor of 8 prevents
   * the live zone from collapsing on tiny terminals.
   */
  private getMaxLiveRows(): number {
    const reservation = this.banner ? 7 : 5;
    return Math.max(8, this.getRows() - reservation);
  }

  private redraw(): void {
    if (this.disposed || this.paused) return;
    const cols = this.getColumns();
    const text = this.renderLiveFrame(cols);
    if (!text) {
      this.logUpdateClear();
      return;
    }
    this.logUpdateImpl(text);
  }

  /** Public for tests — render the live zone to a string without emitting. */
  renderLiveFrame(columns?: number): string {
    const cols = columns ?? this.getColumns();
    if (this.issues.size === 0) return "";
    const text =
      cols < NARROW_TERMINAL_THRESHOLD
        ? this.renderNarrowFrame()
        : this.issues.size === 1
          ? this.renderSingleIssueFrame(cols)
          : this.renderMultiIssueFrame(cols);
    return this.clampFrameHeight(text);
  }

  /**
   * #624 Item 1 (AC-1.1): hard ceiling on rendered frame height. The interior
   * `applyRowCap` already collapses excess issues into the rollup row, but the
   * frame can still drift over the cap if many issues have multi-line status
   * cells (sub-status + phase sequence). This is the belt-and-braces clamp
   * that guarantees `log-update` never sees a frame taller than the terminal.
   *
   * Always engages — when `rows` isn't explicitly provided, `getRows()` returns
   * `DEFAULT_TERMINAL_ROWS` (100) so the cap is generous but never disengaged.
   */
  private clampFrameHeight(text: string): string {
    const lines = text.split("\n");
    const maxRows = this.getMaxLiveRows();
    if (lines.length <= maxRows) return text;
    const c = colorize(this.noColor);
    // Reserve the last visible row for an overflow indicator so the cap is
    // observable from the rendered output.
    const truncated = lines.slice(0, Math.max(1, maxRows - 1));
    const hidden = lines.length - truncated.length;
    truncated.push(
      c.dim(
        `  … ${hidden} more line${hidden === 1 ? "" : "s"} (terminal too short)`,
      ),
    );
    return truncated.join("\n");
  }

  private renderNarrowFrame(): string {
    // AC-25: <80 columns → indented key:value pairs, no box-drawing.
    const c = colorize(this.noColor);
    const header = `SEQUANT WORKFLOW · ${this.runHeader()}`;
    const lines: string[] = [c.bold(header), ""];
    if (this.banner) lines.push(c.yellow(this.banner), "");
    const { rolledUpDoneCount, visibleStates, totalCount } = this.applyRowCap();
    if (rolledUpDoneCount > 0) {
      lines.push(`  ${c.green(`✔ ${rolledUpDoneCount} done`)}`);
    }
    for (const state of visibleStates) {
      lines.push(`  #${state.issueNumber}  ${this.statusHeader(state)}`);
      const subLines = this.statusSubLines(state);
      for (const line of subLines) lines.push(`     ${line}`);
    }
    if (rolledUpDoneCount > 0) {
      lines.push(
        "",
        c.dim(`  (${visibleStates.length} of ${totalCount} shown)`),
      );
    }
    lines.push("", this.rollupLine());
    return lines.join("\n");
  }

  private renderSingleIssueFrame(cols: number): string {
    // AC-11: single-issue runs render as indented `label  value` lines — not a
    // box-drawing grid.
    //
    // The grid was the dominant source of `log-update` `eraseLines` stranding
    // (#647 / #655): a multi-line bordered frame whose top survives in
    // scrollback when the erase undershoots, leaving a frozen first paint (the
    // classic "0s elapsed" ghost with no bottom border). Indented labels keep
    // the same information at a shorter, border-free height that clears
    // cleanly, and match the repo's move away from box-drawing in human output
    // (see feedback_llm_hostile_formatting). Multi-issue still uses the grid.
    const state = [...this.issues.values()][0];
    const c = colorize(this.noColor);
    const header = `SEQUANT WORKFLOW · #${state.issueNumber} · ${formatElapsedTime((this.now() - this.runStartedAt) / 1000)} elapsed`;

    // Label column fits the widest label ("Worktree"); value column is the
    // remaining width after the 2-space indent + 2-space gap. Capped the same
    // way the grid was so wide / misreported terminals can't push values past a
    // standard 80-col reader.
    const labelWidth = 8;
    const valueWidth = Math.max(40, Math.min(cols, 100) - labelWidth - 4);

    const rows: Array<[string, string[]]> = [];
    const titleSuffix = state.title ? ` — ${state.title}` : "";
    rows.push([
      "Issue",
      [`#${state.issueNumber}${titleSuffix}`.slice(0, valueWidth)],
    ]);
    if (state.worktreePath) {
      rows.push(["Worktree", [truncate(state.worktreePath, valueWidth)]]);
    }
    if (state.branch) {
      rows.push(["Branch", [truncate(state.branch, valueWidth)]]);
    }
    rows.push(["Status", this.statusCellLines(state)]);

    const lines: string[] = [c.bold(header), ""];
    if (this.banner) lines.push(c.yellow(this.banner), "");
    lines.push(this.drawKeyValueLines(rows, labelWidth));
    return lines.join("\n");
  }

  private renderMultiIssueFrame(cols: number): string {
    // AC-5/6/7: per-issue grid with active expanded, done collapsed.
    // AC-28: when total issues exceed the row cap, oldest done issues collapse
    // into a single `✔ {N} done` row at the top and a `(M of N shown)` indicator
    // is appended.
    const c = colorize(this.noColor);
    const header = `SEQUANT WORKFLOW · ${this.runHeader()}`;

    // #647 AC-3: see note in `renderSingleIssueFrame` — cap at 78 (not 110) so
    // the rendered grid stays narrower than any standard 80-col terminal under
    // width-misreporting conditions. The box-drawing total is
    // `issueColW + statusColW + 9`; the prior `- 7` formula compounded the
    // overflow.
    const issueColW = 8;
    const innerWidth = Math.max(50, Math.min(cols, 78) - issueColW - 9);
    const statusColW = innerWidth;

    const lines: string[] = [c.bold(header), ""];
    if (this.banner) lines.push(c.yellow(this.banner), "");

    const { rolledUpDoneCount, visibleStates, totalCount } = this.applyRowCap();

    const rows: Array<{ issueLabel: string; statusLines: string[] }> = [];
    if (rolledUpDoneCount > 0) {
      rows.push({
        issueLabel: c.green(`✔ ${rolledUpDoneCount}`),
        statusLines: [c.green(`${rolledUpDoneCount} done · rolled up`)],
      });
    }
    for (const state of visibleStates) {
      rows.push({
        issueLabel: `#${state.issueNumber}`,
        statusLines: this.statusCellLines(state),
      });
    }
    lines.push(this.drawIssueGrid(rows, issueColW, statusColW));
    lines.push("");
    if (rolledUpDoneCount > 0) {
      lines.push(c.dim(`  (${visibleStates.length} of ${totalCount} shown)`));
    }
    lines.push("  " + this.rollupLine());
    return lines.join("\n");
  }

  /**
   * AC-28 + #624 Item 1: enforce the per-frame issue row cap, derived from
   * the smaller of `multiIssueRowCap` (static config) and a dynamic ceiling
   * computed from terminal height. The dynamic ceiling reserves ~3 lines per
   * issue (status header + sub-status + separator) and a fixed overhead for
   * the frame header, blank lines, grid borders, and the rollup line.
   *
   * If the cap is not exceeded, returns all issues unchanged. Otherwise: keep
   * all non-done rows, then fill remaining slots with the most recently
   * completed done rows; older done rows roll up into a single summary entry.
   */
  private applyRowCap(): {
    rolledUpDoneCount: number;
    visibleStates: IssueState[];
    totalCount: number;
  } {
    const all = [...this.issues.values()];
    const totalCount = all.length;
    const cap = this.effectiveRowCap();
    if (totalCount <= cap) {
      return { rolledUpDoneCount: 0, visibleStates: all, totalCount };
    }
    const active = all.filter((s) => s.status !== "done");
    const done = all
      .filter((s) => s.status === "done")
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    // Reserve one row for the rollup line, leave the rest for visible issues.
    const visibleSlots = Math.max(1, cap - 1);
    const remainingSlotsForDone = Math.max(0, visibleSlots - active.length);
    const visibleDone = done.slice(0, remainingSlotsForDone);
    const rolledUpDoneCount = done.length - visibleDone.length;
    return {
      rolledUpDoneCount,
      visibleStates: [...active, ...visibleDone],
      totalCount,
    };
  }

  /**
   * #624 Item 1 (AC-1.1): smaller of the configured static cap and the
   * dynamic terminal-height-derived cap. Each issue row takes roughly 3 grid
   * lines (header, sub-status, separator); the fixed overhead covers the
   * frame title, blank lines, grid borders, and the rollup row.
   *
   * Always engages — when `rows` isn't explicitly provided, `getRows()` returns
   * `DEFAULT_TERMINAL_ROWS` (100) which produces a dynamic cap of ~30, well
   * above the static `multiIssueRowCap` default of 10, so the static cap stays
   * in charge for normal-height terminals.
   */
  private effectiveRowCap(): number {
    const LINES_PER_ISSUE = 3;
    const FIXED_OVERHEAD = 8;
    const maxLiveRows = this.getMaxLiveRows();
    const dynamicCap = Math.max(
      2,
      Math.floor((maxLiveRows - FIXED_OVERHEAD) / LINES_PER_ISSUE),
    );
    return Math.min(this.multiIssueRowCap, dynamicCap);
  }

  // ---------------- Per-issue status content ----------------

  private statusHeader(state: IssueState): string {
    const c = colorize(this.noColor);
    if (state.status === "done") {
      const total =
        state.startedAt !== undefined && state.completedAt !== undefined
          ? formatElapsedTime((state.completedAt - state.startedAt) / 1000)
          : "";
      const phaseSeq = state.phases
        .map((p) => p.name)
        .filter((n) => n !== "loop")
        .join("→");
      const prSuffix = state.prNumber ? ` · PR #${state.prNumber}` : "";
      return c.green(`✔ done · ${total} · ${phaseSeq}${prSuffix}`);
    }
    if (state.status === "failed") {
      const total =
        state.startedAt !== undefined
          ? formatElapsedTime(
              ((state.completedAt ?? this.now()) - state.startedAt) / 1000,
            )
          : "";
      return c.red(
        `✘ failed${total ? ` · ${total}` : ""}${state.failureReason ? ` · ${state.failureReason}` : ""}`,
      );
    }
    if (state.status === "queued") {
      return c.gray("· queued");
    }
    // running
    const cur = state.currentPhase ?? "starting";
    const phase = state.phases.find((p) => p.name === cur);
    const elapsedMs =
      phase?.startedAt !== undefined ? this.now() - phase.startedAt : 0;
    const elapsed = formatElapsedTime(elapsedMs / 1000);
    const spinner = SPINNER_FRAMES[this.spinnerFrame];

    // AC-23: in auto-detect mode, render `Phase: detecting…` while spec is
    // running and no other phase has started yet (no resolved plan known).
    if (
      state.autoDetect &&
      cur === "spec" &&
      phase?.status === "running" &&
      state.phases.length === 1
    ) {
      return c.cyan(`${spinner} Phase: detecting… · ${elapsed}`);
    }

    // AC-26: when a phase has been running past the stall threshold, flip the
    // status header to a yellow stalled marker. The phase keeps ticking; this
    // is informational only.
    if (elapsedMs > this.stallThresholdMs) {
      return c.yellow(`⚠ stalled · ${cur} · ${elapsed}`);
    }

    // #624 Item 3 (AC-3.3): while in the `loop` phase, surface both the loop
    // iteration counter and the last failure reason so the user can see what
    // the loop is reacting to. The first loop iteration starts at 1/M.
    if (cur === "loop") {
      const iter = phase?.loopIteration ?? 1;
      const failReason = state.failureReason
        ? ` · last fail: ${truncate(state.failureReason, FAIL_REASON_TRUNCATE_LENGTH)}`
        : "";
      return c.cyan(
        `${spinner} loop ${iter}/${this.maxLoopIterations}${failReason} · ${elapsed}`,
      );
    }

    // #624 Derived AC-D2: shared retry-suffix helper. Eliminates the hardcoded
    // `/3` literal so `maxLoopIterations` from settings flows through.
    const loopLabel = formatRetrySuffix(
      phase?.loopIteration,
      this.maxLoopIterations,
      "header",
    );
    const loopPrefix = loopLabel ? ` loop${loopLabel}` : "";
    return c.cyan(`${spinner} ${cur}${loopPrefix} · ${elapsed}`);
  }

  private statusSubLines(state: IssueState): string[] {
    const c = colorize(this.noColor);
    const lines: string[] = [];
    // #672 AC-3: include the failed state so the row that just failed still
    // renders its phase cells (the failing cell shows ✘ in place). Without
    // this, a failure on an unstarted phase hides the entire pipeline behind
    // the header summary, making it impossible to see how far the run got.
    if (
      state.status === "running" ||
      state.status === "queued" ||
      state.status === "failed"
    ) {
      const seq = state.phases
        .filter((p) => p.name !== "loop")
        .map((p) => {
          if (p.status === "done")
            return c.green(
              `${p.name} ✔${p.durationMs ? ` ${formatElapsedTime(p.durationMs / 1000)}` : ""}`,
            );
          if (p.status === "failed") return c.red(`${p.name} ✘`);
          if (p.status === "running") return c.cyan(`${p.name} running`);
          // #672 AC-3: pending cells render as `name –` (en dash) so the live
          // zone reads as a roadmap when a phase plan is set via registration
          // or `setPhasePlan`. Without a plan, no pending cells are seeded so
          // this branch is unreachable — preserving prior single-row output.
          return c.gray(`${p.name} –`);
        })
        .join("  →  ");
      if (seq) lines.push(seq);
      if (state.subStatus) lines.push(c.dim(state.subStatus));
    }
    return lines;
  }

  private statusCellLines(state: IssueState): string[] {
    if (state.status === "done") return [this.statusHeader(state)];
    return [this.statusHeader(state), ...this.statusSubLines(state)];
  }

  // ---------------- Rollup / header ----------------

  private runHeader(): string {
    const elapsed = formatElapsedTime((this.now() - this.runStartedAt) / 1000);
    const issues = this.issues.size;
    return `${issues} issue${issues === 1 ? "" : "s"} · ${elapsed}`;
  }

  private rollupLine(): string {
    const c = colorize(this.noColor);
    let done = 0,
      running = 0,
      queued = 0,
      failed = 0;
    for (const s of this.issues.values()) {
      switch (s.status) {
        case "done":
          done++;
          break;
        case "running":
          running++;
          break;
        case "queued":
          queued++;
          break;
        case "failed":
          failed++;
          break;
      }
    }
    return c.dim(
      `${done} done · ${running} running · ${queued} queued · ${failed} failed`,
    );
  }

  // ---------------- Box drawing ----------------

  /**
   * Single-issue layout: indented `label  value` lines, no box drawing. The
   * label is cyan and padded to `labelW`; continuation lines (multi-line
   * status cells) align under the value column with a blank label. See
   * `renderSingleIssueFrame` for why the bordered grid was dropped.
   */
  private drawKeyValueLines(
    rows: Array<[string, string[]]>,
    labelW: number,
  ): string {
    const c = colorize(this.noColor);
    const out: string[] = [];
    for (const [label, lines] of rows) {
      const labelPadded = padEndVisible(label, labelW);
      lines.forEach((line, idx) => {
        const labelCell = idx === 0 ? c.cyan(labelPadded) : " ".repeat(labelW);
        out.push(`  ${labelCell}  ${line}`);
      });
    }
    return out.join("\n");
  }

  private drawIssueGrid(
    rows: Array<{ issueLabel: string; statusLines: string[] }>,
    issueW: number,
    statusW: number,
  ): string {
    const c = colorize(this.noColor);
    const dim = c.dim;
    const top = dim(
      "  ┌" + "─".repeat(issueW + 2) + "┬" + "─".repeat(statusW + 2) + "┐",
    );
    const sep = dim(
      "  ├" + "─".repeat(issueW + 2) + "┼" + "─".repeat(statusW + 2) + "┤",
    );
    const bottom = dim(
      "  └" + "─".repeat(issueW + 2) + "┴" + "─".repeat(statusW + 2) + "┘",
    );
    const headerRow = `  ${dim("│")} ${c.cyan(padEndVisible("Issue", issueW))} ${dim("│")} ${c.cyan(padEndVisible("Status", statusW))} ${dim("│")}`;
    const out: string[] = [top, headerRow, sep];
    rows.forEach((row, i) => {
      row.statusLines.forEach((line, idx) => {
        const issueCell =
          idx === 0
            ? padEndVisible(row.issueLabel, issueW)
            : " ".repeat(issueW);
        const statusPadded = padEndVisible(line, statusW);
        out.push(
          `  ${dim("│")} ${issueCell} ${dim("│")} ${statusPadded} ${dim("│")}`,
        );
      });
      if (i < rows.length - 1) out.push(sep);
    });
    out.push(bottom);
    return out.join("\n");
  }
}

// ============================================================================
// Summary block (shared by TTY + non-TTY)
// ============================================================================

interface SummaryRenderCtx {
  stdoutWrite: (s: string) => void;
  noColor: boolean;
  columns: number;
}

function renderSummaryBlock(
  input: SummaryRenderInput,
  ctx: SummaryRenderCtx,
): void {
  const { issues } = input;
  if (issues.length === 0 && !input.dryRun) return;
  const c = colorize(ctx.noColor);
  const passed = issues.filter((i) => i.success).length;
  const failed = issues.filter((i) => !i.success).length;
  const totalStr =
    input.totalDurationSeconds !== undefined
      ? ` · ${formatElapsedTime(input.totalDurationSeconds)}`
      : "";
  const out: string[] = [];
  out.push("");
  out.push(
    c.bold(
      `SUMMARY · ${issues.length} issue${issues.length === 1 ? "" : "s"}${totalStr} · ${passed} passed · ${failed} failed`,
    ),
  );
  out.push("");

  if (ctx.columns < NARROW_TERMINAL_THRESHOLD) {
    // AC-25 fallback: indented key:value pairs.
    for (const r of issues) {
      const status = r.success ? c.green("✔ passed") : c.red("✘ failed");
      const detail = renderSummaryDetail(r, ctx);
      out.push(`  ${status}  #${r.issueNumber}  ${detail.summary}`);
      for (const extra of detail.extras) out.push(`     ${extra}`);
      if (r.durationSeconds !== undefined) {
        out.push(`     ${c.dim(formatElapsedTime(r.durationSeconds))}`);
      }
    }
  } else {
    out.push(renderSummaryGrid(issues, ctx));
  }

  out.push("");
  out.push(`  ${c.green(`${passed} passed`)} · ${c.red(`${failed} failed`)}`);
  if (input.logPath) {
    out.push(`  ${c.dim(`Log: ${input.logPath}`)}`);
  }
  out.push("");

  ctx.stdoutWrite(out.join("\n"));
}

function renderSummaryDetail(
  r: IssueSummary,
  ctx: SummaryRenderCtx,
): { summary: string; extras: string[] } {
  const c = colorize(ctx.noColor);
  if (r.success) {
    const phaseSeq = r.phases
      .map((p) => (p.success ? c.green(p.name) : c.red(p.name)))
      .join(" → ");
    const pr = r.prNumber ? ` · PR #${r.prNumber}` : "";
    return { summary: `${phaseSeq}${pr}`, extras: [] };
  }
  // Failed → multi-line detail.
  const reason = r.failureReason ?? "failure";
  const extras: string[] = [];
  if (r.qaVerdict) {
    const unmet = r.unmetCount !== undefined ? ` (${r.unmetCount} unmet)` : "";
    extras.push(c.red(`${r.qaVerdict}${unmet}`));
  }
  return { summary: c.red(reason), extras };
}

function renderSummaryGrid(
  issues: IssueSummary[],
  ctx: SummaryRenderCtx,
): string {
  const c = colorize(ctx.noColor);
  const dim = c.dim;
  const issueW = 8;
  const resultW = 10;
  const totalW = 10;
  const detailW = Math.max(
    28,
    Math.min(ctx.columns, 100) - issueW - resultW - totalW - 11,
  );

  const top = dim(
    "  ┌" +
      "─".repeat(issueW + 2) +
      "┬" +
      "─".repeat(resultW + 2) +
      "┬" +
      "─".repeat(detailW + 2) +
      "┬" +
      "─".repeat(totalW + 2) +
      "┐",
  );
  const sep = dim(
    "  ├" +
      "─".repeat(issueW + 2) +
      "┼" +
      "─".repeat(resultW + 2) +
      "┼" +
      "─".repeat(detailW + 2) +
      "┼" +
      "─".repeat(totalW + 2) +
      "┤",
  );
  const bottom = dim(
    "  └" +
      "─".repeat(issueW + 2) +
      "┴" +
      "─".repeat(resultW + 2) +
      "┴" +
      "─".repeat(detailW + 2) +
      "┴" +
      "─".repeat(totalW + 2) +
      "┘",
  );
  const headerRow = `  ${dim("│")} ${c.cyan(padEndVisible("Issue", issueW))} ${dim("│")} ${c.cyan(padEndVisible("Result", resultW))} ${dim("│")} ${c.cyan(padEndVisible("Detail", detailW))} ${dim("│")} ${c.cyan(padEndVisible("Total", totalW))} ${dim("│")}`;
  const out: string[] = [top, headerRow, sep];
  issues.forEach((r, i) => {
    const result = r.success ? c.green("✔ passed") : c.red("✘ failed");
    const detail = renderSummaryDetail(r, ctx);
    const detailLines = [detail.summary, ...detail.extras];
    const total =
      r.durationSeconds !== undefined
        ? formatElapsedTime(r.durationSeconds)
        : "";
    detailLines.forEach((line, idx) => {
      const issueCell =
        idx === 0
          ? padEndVisible(`#${r.issueNumber}`, issueW)
          : " ".repeat(issueW);
      const resultCell =
        idx === 0 ? padEndVisible(result, resultW) : " ".repeat(resultW);
      const totalCell =
        idx === 0 ? padEndVisible(total, totalW) : " ".repeat(totalW);
      out.push(
        `  ${dim("│")} ${issueCell} ${dim("│")} ${resultCell} ${dim("│")} ${padEndVisible(line, detailW)} ${dim("│")} ${totalCell} ${dim("│")}`,
      );
    });
    if (i < issues.length - 1) out.push(sep);
  });
  out.push(bottom);
  return out.join("\n");
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Pad/truncate a string to a visible-width column, ignoring ANSI escape
 * sequences. Uses `string-width` (already a dependency) so wide CJK and
 * emoji characters don't break alignment.
 */
function padEndVisible(s: string, width: number): string {
  const visible = stringWidth(s);
  if (visible >= width) return truncate(s, width);
  return s + " ".repeat(width - visible);
}

function truncate(s: string, max: number): string {
  // Strip nothing — assumes input is plain text, not ANSI. Visible truncation
  // is best-effort; box drawing happens after this so ANSI is added later.
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

// ============================================================================
// Factory
// ============================================================================

export interface CreateRendererOptions extends RenderOptions {
  /** Force a specific mode (otherwise auto-detected from env + TTY). */
  mode?: RendererMode;
}

/**
 * Create a `RunRenderer` matching the current execution context.
 *
 * Detection order:
 *   1. Explicit `mode` override.
 *   2. `SEQUANT_ORCHESTRATOR` env var → orchestrator (no-op).
 *   3. `process.stdout.isTTY` (or `options.isTTY`) → TTY renderer.
 *   4. Otherwise → non-TTY renderer.
 */
export function createRunRenderer(
  options: CreateRendererOptions = {},
): RunRenderer {
  const mode: RendererMode =
    options.mode ??
    (process.env.SEQUANT_ORCHESTRATOR
      ? "orchestrator"
      : (options.isTTY ?? Boolean(process.stdout.isTTY))
        ? "tty"
        : "non-tty");
  if (mode === "orchestrator") return new OrchestratorRenderer(options);
  if (mode === "tty") return new TTYRenderer(options);
  return new NonTTYRenderer(options);
}

/**
 * Public summary helper — used by the legacy displaySummary path so callers
 * that bypass the renderer still get the new grid layout.
 */
export function renderRunSummary(
  input: SummaryRenderInput,
  options: {
    stdoutWrite?: (s: string) => void;
    noColor?: boolean;
    columns?: number;
  } = {},
): void {
  // #624 Item 2 (AC-2.3): apply the same SUMMARY_COLUMN_CAP as the TTY and
  // non-TTY paths so the legacy renderless path can't produce a divergent
  // wide grid that overflows.
  const rawColumns = options.columns ?? process.stdout.columns ?? 100;
  renderSummaryBlock(input, {
    stdoutWrite:
      options.stdoutWrite ?? ((s: string) => void process.stdout.write(s)),
    noColor: Boolean(options.noColor) || Boolean(process.env.NO_COLOR),
    columns: Math.min(rawColumns, SUMMARY_COLUMN_CAP),
  });
}
