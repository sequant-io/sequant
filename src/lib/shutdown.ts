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
 * Cleanup task with name for user feedback
 */
interface CleanupTask {
  name: string;
  task: () => Promise<void>;
}

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
  private abortController: AbortController | null = null;
  private forceExitTimeout: number;
  private output: (message: string) => void;
  private errorOutput: (message: string) => void;
  private exit: (code: number) => void;

  // Store bound handlers for removal in dispose()
  private sigintHandler: () => void;
  private sigtermHandler: () => void;

  constructor(options: ShutdownManagerOptions = {}) {
    this.forceExitTimeout = options.forceExitTimeout ?? 10000;
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
   * Set the abort controller for the current phase
   *
   * When shutdown is triggered, this controller will be aborted
   * to cancel any in-flight operations.
   */
  setAbortController(controller: AbortController): void {
    this.abortController = controller;
  }

  /**
   * Clear the abort controller (e.g., after phase completes)
   */
  clearAbortController(): void {
    this.abortController = null;
  }

  /**
   * Register a cleanup task
   *
   * Tasks are executed in LIFO order (last registered = first executed).
   * This allows dependent cleanup to happen in correct order.
   *
   * @param name - Human-readable name for user feedback
   * @param task - Async function to execute during cleanup
   */
  registerCleanup(name: string, task: () => Promise<void>): void {
    this.cleanupTasks.push({ name, task });
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

    this.output(
      chalk.yellow(`\n⚠️  Received ${signal}, shutting down gracefully...`),
    );

    // Abort in-flight phase immediately
    if (this.abortController) {
      this.abortController.abort();
      this.output(chalk.green("✓ Aborted active phase"));
    }

    // Set up force exit timeout
    const forceExitTimer = setTimeout(() => {
      this.errorOutput(chalk.red("Cleanup timeout, force exiting"));
      this.exit(1);
    }, this.forceExitTimeout);

    // Run cleanup tasks in reverse order (LIFO)
    const tasksToRun = [...this.cleanupTasks].reverse();

    for (const { name, task } of tasksToRun) {
      try {
        await task();
        this.output(chalk.green(`✓ ${name}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.errorOutput(chalk.red(`✗ ${name}: ${message}`));
      }
    }

    clearTimeout(forceExitTimer);

    // Print summary
    this.output(chalk.yellow("\nInterrupted. Cleanup complete."));

    this.exit(0);
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
    this.abortController = null;
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
