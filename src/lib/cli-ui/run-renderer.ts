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

import chalk from "chalk";
import logUpdate from "log-update";
import stringWidth from "string-width";
import { formatElapsedTime, formatTimestamp } from "./format.js";
import type {
  IssueRegistration,
  IssueState,
  IssueSummary,
  ProgressEvent,
  RenderOptions,
  RendererMode,
  RunRenderer,
  SummaryRenderInput,
} from "./run-renderer-types.js";

const DEFAULT_LIVE_TICK_MS = 1000;
const DEFAULT_NON_TTY_HEARTBEAT_MS = 60_000;
const NARROW_TERMINAL_THRESHOLD = 80;

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
// Shared state machine
// ============================================================================

abstract class BaseRenderer implements RunRenderer {
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
    this.issues.set(reg.issueNumber, {
      issueNumber: reg.issueNumber,
      title: reg.title,
      worktreePath: reg.worktreePath,
      branch: reg.branch,
      status: "queued",
      phases: [],
    });
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
    if (event.error) state.failureReason = event.error;
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
  private lastEventAt: number;

  constructor(options: RenderOptions) {
    super(options);
    this.heartbeatMs =
      options.nonTtyHeartbeatMs ?? DEFAULT_NON_TTY_HEARTBEAT_MS;
    this.lastEventAt = this.now();
    this.startHeartbeat();
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
    const loopSuffix =
      phase?.loopIteration && phase.loopIteration > 1
        ? ` (loop ${phase.loopIteration})`
        : "";
    if (event.event === "start") {
      this.emitLine(
        `${c.cyan("▸")} #${event.issue} ${event.phase}${loopSuffix}`,
      );
    } else if (event.event === "complete") {
      const durStr =
        event.durationSeconds !== undefined
          ? ` ${formatElapsedTime(event.durationSeconds)}`
          : "";
      this.emitLine(
        `${c.green("✔")} #${event.issue} ${event.phase}${loopSuffix}${durStr}`,
      );
    } else {
      const errStr = event.error ? ` ${c.red(event.error)}` : "";
      this.emitLine(
        `${c.red("✘")} #${event.issue} ${event.phase}${loopSuffix}${errStr}`,
      );
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
    renderSummaryBlock(input, {
      stdoutWrite: this.stdoutWrite,
      noColor: this.noColor,
      columns: NARROW_TERMINAL_THRESHOLD,
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
// TTY renderer — log-update live zone + append-only events log
// ============================================================================

export class TTYRenderer extends BaseRenderer {
  private readonly liveTickMs: number;
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private readonly columnsOverride?: number;
  private readonly noSignalListeners: boolean;
  private readonly logUpdateImpl: (text: string) => void;
  private readonly logUpdateClear: () => void;
  private readonly logUpdateDone: () => void;
  private resizeListener: (() => void) | null = null;
  private banner: string | null = null;

  constructor(options: RenderOptions) {
    super(options);
    this.liveTickMs = options.liveTickMs ?? DEFAULT_LIVE_TICK_MS;
    this.columnsOverride = options.columns;
    this.noSignalListeners = Boolean(options.noSignalListeners);

    // log-update writes to process.stdout via a mutable global instance. When
    // tests inject `stdoutWrite`, route renders through it instead so capture
    // works deterministically.
    if (options.stdoutWrite) {
      let lastFrame = "";
      this.logUpdateImpl = (text: string) => {
        // Clear previous frame (best-effort emulation of log-update behaviour
        // without a real terminal cursor).
        if (lastFrame) options.stdoutWrite!("");
        lastFrame = text;
        options.stdoutWrite!(text + "\n");
      };
      this.logUpdateClear = () => {
        lastFrame = "";
      };
      this.logUpdateDone = () => {
        lastFrame = "";
      };
    } else {
      this.logUpdateImpl = (text: string) => logUpdate(text);
      this.logUpdateClear = () => logUpdate.clear();
      this.logUpdateDone = () => logUpdate.done();
    }

    this.startLiveTimer();
    this.installSignalListeners();
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
    // Clear the live zone so the appended event becomes a real `console.log`
    // line above it; the live zone redraws below.
    this.logUpdateClear();
    const c = colorize(this.noColor);
    const phase = state.phases.find((p) => p.name === event.phase);
    const loopSuffix =
      phase?.loopIteration && phase.loopIteration > 1
        ? ` (loop ${phase.loopIteration}/3)`
        : "";
    let line: string;
    if (event.event === "start") {
      line = `  ${c.cyan("▸")} #${event.issue} ${event.phase}${loopSuffix}`;
    } else if (event.event === "complete") {
      const durStr =
        event.durationSeconds !== undefined
          ? `  ${formatElapsedTime(event.durationSeconds)}`
          : "";
      const prSuffix = state.prUrl ? `  →  PR #${state.prNumber}` : "";
      line = `  ${c.green("✔")} #${event.issue} ${event.phase}${loopSuffix}${durStr}${prSuffix}`;
    } else {
      const errStr = event.error ? `  ${c.red(event.error)}` : "";
      line = `  ${c.red("✘")} #${event.issue} ${event.phase}${loopSuffix}${errStr}`;
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
    // Stop the live zone so the summary anchors at the bottom.
    this.logUpdateClear();
    this.logUpdateDone();
    if (this.liveTimer !== null) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
    renderSummaryBlock(input, {
      stdoutWrite: this.stdoutWrite,
      noColor: this.noColor,
      columns: this.getColumns(),
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
    if (cols < NARROW_TERMINAL_THRESHOLD) {
      return this.renderNarrowFrame();
    }
    if (this.issues.size === 1) {
      return this.renderSingleIssueFrame(cols);
    }
    return this.renderMultiIssueFrame(cols);
  }

  private renderNarrowFrame(): string {
    // AC-25: <80 columns → indented key:value pairs, no box-drawing.
    const c = colorize(this.noColor);
    const header = `SEQUANT WORKFLOW · ${this.runHeader()}`;
    const lines: string[] = [c.bold(header), ""];
    if (this.banner) lines.push(c.yellow(this.banner), "");
    for (const state of this.issues.values()) {
      lines.push(`  #${state.issueNumber}  ${this.statusHeader(state)}`);
      const subLines = this.statusSubLines(state);
      for (const line of subLines) lines.push(`     ${line}`);
    }
    lines.push("", this.rollupLine());
    return lines.join("\n");
  }

  private renderSingleIssueFrame(cols: number): string {
    // AC-11: Single-issue runs use a key:value full-grid table.
    const state = [...this.issues.values()][0];
    const c = colorize(this.noColor);
    const header = `SEQUANT WORKFLOW · #${state.issueNumber} · ${formatElapsedTime((this.now() - this.runStartedAt) / 1000)} elapsed`;

    const labelWidth = 10;
    const innerWidth = Math.max(40, Math.min(cols, 110) - labelWidth - 7);
    const valueWidth = innerWidth;

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
    lines.push(this.drawKeyValueTable(rows, labelWidth, valueWidth));
    return lines.join("\n");
  }

  private renderMultiIssueFrame(cols: number): string {
    // AC-5/6/7: per-issue grid with active expanded, done collapsed.
    const c = colorize(this.noColor);
    const header = `SEQUANT WORKFLOW · ${this.runHeader()}`;

    const issueColW = 8;
    const innerWidth = Math.max(50, Math.min(cols, 110) - issueColW - 7);
    const statusColW = innerWidth;

    const lines: string[] = [c.bold(header), ""];
    if (this.banner) lines.push(c.yellow(this.banner), "");

    const issuesInOrder = [...this.issues.values()];
    const rows = issuesInOrder.map((state) => {
      return {
        issueLabel: `#${state.issueNumber}`,
        statusLines: this.statusCellLines(state),
      };
    });
    lines.push(this.drawIssueGrid(rows, issueColW, statusColW));
    lines.push("");
    lines.push("  " + this.rollupLine());
    return lines.join("\n");
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
    const loopLabel =
      phase?.loopIteration && phase.loopIteration > 1
        ? ` loop ${phase.loopIteration}/3`
        : "";
    return c.cyan(`${spinner} ${cur}${loopLabel} · ${elapsed}`);
  }

  private statusSubLines(state: IssueState): string[] {
    const c = colorize(this.noColor);
    const lines: string[] = [];
    if (state.status === "running" || state.status === "queued") {
      const seq = state.phases
        .filter((p) => p.name !== "loop")
        .map((p) => {
          if (p.status === "done")
            return c.green(
              `${p.name} ✔${p.durationMs ? ` ${formatElapsedTime(p.durationMs / 1000)}` : ""}`,
            );
          if (p.status === "failed") return c.red(`${p.name} ✘`);
          if (p.status === "running") return c.cyan(`${p.name} running`);
          return c.gray(`${p.name} queued`);
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

  private drawKeyValueTable(
    rows: Array<[string, string[]]>,
    labelW: number,
    valueW: number,
  ): string {
    const c = colorize(this.noColor);
    const dim = c.dim;
    const total = labelW + valueW + 3;
    const top = dim(
      "  ┌" + "─".repeat(labelW + 2) + "┬" + "─".repeat(valueW + 2) + "┐",
    );
    const sep = dim(
      "  ├" + "─".repeat(labelW + 2) + "┼" + "─".repeat(valueW + 2) + "┤",
    );
    const bottom = dim(
      "  └" + "─".repeat(labelW + 2) + "┴" + "─".repeat(valueW + 2) + "┘",
    );
    const out: string[] = [top];
    rows.forEach(([label, lines], i) => {
      const labelPadded = padEndVisible(label, labelW);
      lines.forEach((line, idx) => {
        const labelCell = idx === 0 ? c.cyan(labelPadded) : " ".repeat(labelW);
        const valuePadded = padEndVisible(line, valueW);
        out.push(
          `  ${dim("│")} ${labelCell} ${dim("│")} ${valuePadded} ${dim("│")}`,
        );
      });
      if (i < rows.length - 1) out.push(sep);
    });
    out.push(bottom);
    void total;
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
  renderSummaryBlock(input, {
    stdoutWrite:
      options.stdoutWrite ?? ((s: string) => void process.stdout.write(s)),
    noColor: Boolean(options.noColor) || Boolean(process.env.NO_COLOR),
    columns: options.columns ?? process.stdout.columns ?? 100,
  });
}
