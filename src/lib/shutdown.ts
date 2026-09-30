/**
 * Graceful shutdown manager for sequant run
 *
 * Handles SIGINT/SIGTERM signals and coordinates cleanup tasks
 * when the process is interrupted.
 *
 * @example
 * ```typescript
 * const shutdown = new ShutdownManager();
 *
 * // Register cleanup tasks
 * shutdown.registerCleanup('Save logs', async () => {
 *   await logWriter.finalize();
 * });
 *
 * // Set abort controller for current phase
 * shutdown.setAbortController(abortController);
 *
 * // In finally block
 * shutdown.dispose();
 * ```
 */

import chalk from "chalk";

/**
 * Ordering class for a cleanup task (#1222). `"finalize"` tasks run before
 * every `"resource"` task, regardless of registration order — registration
 * order alone can't guarantee this, since resource cleanups (e.g. worktree
 * removal) are often registered lazily, after a finalize task already is.
 * Within a phase, tasks still run LIFO.
 */
export type CleanupPhase = "finalize" | "resource";

/**
 * Cleanup task with name for user feedback
 */
interface CleanupTask {
  name: string;
  task: (abort: AbortContext | null) => Promise<void>;
  phase: CleanupPhase;
}

/** Ordering tasks run in: every "finalize" task, then every "resource" task. */
const CLEANUP_PHASE_ORDER: CleanupPhase[] = ["finalize", "resource"];

/**
 * Why the process is shutting down, handed to every cleanup task so they can
 * record the cause rather than silently persisting a truncated record (#856).
 */
export interface AbortContext {
  /** Signal that triggered the shutdown, e.g. `SIGTERM`. */
  signal: string;
  /** Human-readable cause, from `describeSignalCause`. */
  reason: string;
}

/** POSIX signal numbers for the signals we install handlers for. */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGINT: 2,
  SIGTERM: 15,
};

/**
 * Conventional shell exit code for death-by-signal: `128 + signum`
 * (SIGINT → 130, SIGTERM → 143). Falls back to 1 for anything unmapped.
 *
 * #856: this used to be a flat `0`. A run killed from outside therefore
 * exited *successfully*, so nothing downstream — CI, a wrapping script, the
 * user reading `$?` — could tell a completed run from a terminated one.
 */
export function exitCodeForSignal(signal: string): number {
  const num = SIGNAL_NUMBERS[signal];
  return num === undefined ? 1 : 128 + num;
}

/**
 * Human-readable cause for a termination signal (#856, AC-4).
 *
 * SIGINT is the user pressing Ctrl+C — self-explanatory. SIGTERM is not:
 * no interactive user sends it by hand, so it always means something else
 * killed the run, and the user needs to be told that rather than left to
 * infer it from truncated output. The known offender on macOS is Claude
 * Code's `[bg-pty]` host-dead watchdog, which group-SIGKILLs a process tree
 * containing the run; see `docs/incidents/856/`.
 */
export function describeSignalCause(signal: string): string {
  switch (signal) {
    case "SIGINT":
      return "interrupted by user (Ctrl+C)";
    case "SIGTERM":
      return "terminated by an external SIGTERM (not sent by sequant)";
    default:
      return `terminated by ${signal}`;
  }
}

/**
 * Default cleanup timeout (#1222 AC-3): the MCP `run` tool's SIGKILL grace
 * (`src/mcp/tools/run.ts`) is derived from this constant, plus a buffer, so
 * the two can't drift apart the way the standalone `5000`/`10000` literals
 * did — a cleanup that respects its own timeout must not be cut off by an
 * outer SIGKILL that fires first.
 */
export const DEFAULT_FORCE_EXIT_TIMEOUT_MS = 10000;

/**
 * Options for ShutdownManager
 */
export interface ShutdownManagerOptions {
  /** Timeout for cleanup tasks in milliseconds (default: 10000) */
  forceExitTimeout?: number;
  /** Custom output function for testing (default: console.log) */
  output?: (message: string) => void;
  /** Custom error output function for testing (default: console.error) */
  errorOutput?: (message: string) => void;
  /** Custom exit function for testing (default: process.exit) */
  exit?: (code: number) => void;
}

/**
 * Manages graceful shutdown for sequant run
 *
 * Features:
 * - Registers SIGINT/SIGTERM handlers
 * - Manages cleanup tasks (executed in LIFO order)
 * - Integrates with AbortController for phase cancellation
 * - Supports double Ctrl+C for force exit
 * - Has configurable timeout to prevent hanging
 */
export class ShutdownManager {
  private cleanupTasks: CleanupTask[] = [];
  private _isShuttingDown = false;
  /** Cause of the in-progress shutdown; null until a signal arrives (#856). */
  private _abortContext: AbortContext | null = null;
  /** Active abort controllers — supports concurrent phase execution (#404) */
  private abortControllers = new Set<AbortController>();
  private forceExitTimeout: number;
  private output: (message: string) => void;
  private errorOutput: (message: string) => void;
  private exit: (code: number) => void;

  // Store bound handlers for removal in dispose()
  private sigintHandler: () => void;
  private sigtermHandler: () => void;

  constructor(options: ShutdownManagerOptions = {}) {
    this.forceExitTimeout =
      options.forceExitTimeout ?? DEFAULT_FORCE_EXIT_TIMEOUT_MS;
    this.output = options.output ?? console.log.bind(console);
    this.errorOutput = options.errorOutput ?? console.error.bind(console);
    this.exit = options.exit ?? process.exit.bind(process);

    // Bind handlers so we can remove them later
    this.sigintHandler = () => this.gracefulShutdown("SIGINT");
    this.sigtermHandler = () => this.gracefulShutdown("SIGTERM");

    // Register signal handlers
    process.on("SIGINT", this.sigintHandler);
    process.on("SIGTERM", this.sigtermHandler);
  }

  /**
   * Whether a shutdown is currently in progress
   */
  get isShuttingDown(): boolean {
    return this._isShuttingDown;
  }

  /**
   * Alias for isShuttingDown (matches proposed API)
   */
  get shuttingDown(): boolean {
    return this._isShuttingDown;
  }

  /**
   * Why the process is shutting down, or `null` if it isn't (#856).
   * Lets code outside a cleanup task — e.g. a `finally` block that also
   * finalizes state — record the same cause the cleanup tasks saw.
   */
  get abortContext(): AbortContext | null {
    return this._abortContext;
  }

  /**
   * Register an abort controller for a running phase.
   *
   * When shutdown is triggered, ALL registered controllers are aborted,
   * supporting concurrent phase execution.
   */
  addAbortController(controller: AbortController): void {
    this.abortControllers.add(controller);
  }

  /**
   * Unregister a specific abort controller after a phase completes.
   *
   * Only removes the given controller — others remain active.
   */
  removeAbortController(controller: AbortController): void {
    this.abortControllers.delete(controller);
  }

  /**
   * @deprecated Use addAbortController/removeAbortController for concurrent safety.
   */
  setAbortController(controller: AbortController): void {
    this.abortControllers.clear();
    this.abortControllers.add(controller);
  }

  /**
   * @deprecated Use removeAbortController(controller) instead.
   */
  clearAbortController(): void {
    this.abortControllers.clear();
  }

  /**
   * Register a cleanup task
   *
   * Tasks are executed in LIFO order (last registered = first executed).
   * This allows dependent cleanup to happen in correct order.
   *
   * @param name - Human-readable name for user feedback
   * @param task - Async function to execute during cleanup. Receives the
   *   `AbortContext` when the shutdown was signal-triggered, or `null` on a
   *   programmatic teardown. Tasks that don't care may ignore the argument.
   * @param options.phase - Ordering class (#1222). Defaults to `"resource"`.
   *   Every `"finalize"` task runs before any `"resource"` task, regardless
   *   of registration order.
   */
  registerCleanup(
    name: string,
    task: (abort: AbortContext | null) => Promise<void>,
    options?: { phase?: CleanupPhase },
  ): void {
    this.cleanupTasks.push({ name, task, phase: options?.phase ?? "resource" });
  }

  /**
   * Unregister a cleanup task by name
   *
   * Use this when a resource is cleaned up normally (e.g., worktree
   * removed after successful merge).
   */
  unregisterCleanup(name: string): void {
    this.cleanupTasks = this.cleanupTasks.filter((t) => t.name !== name);
  }

  /**
   * Get the number of registered cleanup tasks
   */
  getCleanupTaskCount(): number {
    return this.cleanupTasks.length;
  }

  /**
   * Trigger graceful shutdown
   *
   * This is called automatically on SIGINT/SIGTERM, but can also
   * be called programmatically for testing.
   */
  async gracefulShutdown(signal: string): Promise<void> {
    // Double signal = force exit
    if (this._isShuttingDown) {
      this.errorOutput(chalk.red("\nForce exiting..."));
      this.exit(1);
      return;
    }

    this._isShuttingDown = true;

    // #856 AC-4: name the cause up front. A truncated run whose last words
    // were "shutting down gracefully" reads as an orderly stop; it isn't one.
    const abort: AbortContext = {
      signal,
      reason: describeSignalCause(signal),
    };
    this._abortContext = abort;

    this.output(
      chalk.yellow(`\n!  Received ${signal}, shutting down gracefully...`),
    );

    // Abort all in-flight phases immediately
    if (this.abortControllers.size > 0) {
      const count = this.abortControllers.size;
      for (const controller of this.abortControllers) {
        controller.abort();
      }
      this.abortControllers.clear();
      this.output(
        chalk.green(`✓ Aborted ${count} active phase${count > 1 ? "s" : ""}`),
      );
    }

    // Set up force exit timeout
    const forceExitTimer = setTimeout(() => {
      this.errorOutput(chalk.red("Cleanup timeout, force exiting"));
      this.exit(1);
    }, this.forceExitTimeout);

    // Run cleanup tasks by phase (#1222: all "finalize" before any
    // "resource"), LIFO within each phase.
    const tasksToRun = CLEANUP_PHASE_ORDER.flatMap((phase) =>
      this.cleanupTasks.filter((t) => t.phase === phase).reverse(),
    );

    for (const { name, task } of tasksToRun) {
      try {
        await task(abort);
        this.output(chalk.green(`✓ ${name}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.errorOutput(chalk.red(`✗ ${name}: ${message}`));
      }
    }

    clearTimeout(forceExitTimer);

    // #856 AC-4: report the abort AS an abort, with its cause and a non-zero
    // exit code. The old banner ("Interrupted. Cleanup complete.") plus
    // `exit(0)` made an externally-killed run indistinguishable from a
    // successful one — and because this path exits the process, the normal
    // `displaySummary` / `abortReason` rendering in run-display.ts is never
    // reached, so this banner is the only thing the user sees.
    const code = exitCodeForSignal(signal);
    this.errorOutput(chalk.red(`\n✗ Run aborted — ${abort.reason}.`));
    this.output(
      chalk.yellow(
        `  Cleanup completed. No phase results beyond this point were recorded.`,
      ),
    );
    if (signal === "SIGTERM") {
      this.output(
        chalk.gray(
          `  sequant does not send itself SIGTERM. If this run was launched as a\n` +
            `  backgrounded task inside an interactive Claude Code session, see\n` +
            `  docs/incidents/856/ — relaunch from a plain terminal instead.`,
        ),
      );
    }
    this.output(chalk.gray(`  Exit code: ${code}`));

    this.exit(code);
  }

  /**
   * Remove signal handlers and clean up
   *
   * Call this in a finally block to prevent handler accumulation
   * across multiple runs in the same process.
   */
  dispose(): void {
    process.removeListener("SIGINT", this.sigintHandler);
    process.removeListener("SIGTERM", this.sigtermHandler);
    this.cleanupTasks = [];
    this.abortControllers.clear();
    this._abortContext = null;
  }
}

/**
 * Create a shutdown manager with default options
 *
 * Convenience function for standard usage.
 */
export function createShutdownManager(
  options?: ShutdownManagerOptions,
): ShutdownManager {
  return new ShutdownManager(options);
}
