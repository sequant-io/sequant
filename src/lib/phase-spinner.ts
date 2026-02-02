/**
 * Phase Spinner - Animated spinner with elapsed time for phase execution
 *
 * Wraps the cli-ui spinner with:
 * - Elapsed time tracking (updates every 5 seconds)
 * - Phase progress indicator (e.g., "spec (1/3)")
 * - Integration with ShutdownManager for graceful cleanup
 *
 * @example
 * ```typescript
 * const spinner = new PhaseSpinner({
 *   phase: 'exec',
 *   phaseIndex: 2,
 *   totalPhases: 3,
 *   shutdownManager,
 * });
 *
 * spinner.start();
 * // ... phase execution
 * spinner.succeed(); // Shows "✓ exec (2/3) (45s)"
 * ```
 */

import { spinner as createSpinner, type SpinnerManager } from "./cli-ui.js";
import type { ShutdownManager } from "./shutdown.js";

/**
 * Elapsed time update interval in milliseconds
 */
const ELAPSED_UPDATE_INTERVAL_MS = 5000;

/**
 * Options for creating a PhaseSpinner
 */
export interface PhaseSpinnerOptions {
  /** Phase name (e.g., "spec", "exec", "qa") */
  phase: string;
  /** Current phase index (1-based) */
  phaseIndex: number;
  /** Total number of phases */
  totalPhases: number;
  /** Optional ShutdownManager for graceful cleanup */
  shutdownManager?: ShutdownManager;
  /** Optional prefix for indentation (default: "    ") */
  prefix?: string;
  /** Optional quality loop iteration (shows "iteration N" if > 1) */
  iteration?: number;
}

/**
 * Format elapsed time in human-readable format
 *
 * @param seconds - Elapsed time in seconds
 * @returns Formatted string (e.g., "45s", "2m 15s", "1h 5m")
 */
export function formatElapsedTime(seconds: number): string {
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }
  const hours = Math.floor(seconds / 3600);
  const remainingMinutes = Math.floor((seconds % 3600) / 60);
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * PhaseSpinner - Animated spinner with elapsed time and phase progress
 *
 * Features:
 * - Animated spinner (or text fallback) via cli-ui
 * - Elapsed time tracking with automatic updates
 * - Phase progress indicator (e.g., "exec (2/3)")
 * - ShutdownManager integration for graceful Ctrl+C cleanup
 * - Pause/resume for verbose streaming output
 */
export class PhaseSpinner {
  private spinner: SpinnerManager;
  private startTime: number = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private paused = false;

  private readonly phase: string;
  private readonly phaseIndex: number;
  private readonly totalPhases: number;
  private readonly shutdownManager?: ShutdownManager;
  private readonly prefix: string;
  private readonly iteration?: number;
  private readonly cleanupName: string;

  constructor(options: PhaseSpinnerOptions) {
    this.phase = options.phase;
    this.phaseIndex = options.phaseIndex;
    this.totalPhases = options.totalPhases;
    this.shutdownManager = options.shutdownManager;
    this.prefix = options.prefix ?? "    ";
    this.iteration = options.iteration;
    this.cleanupName = `phase-spinner-${options.phase}`;

    // Create the underlying spinner with initial text
    this.spinner = createSpinner(this.formatText(0));
  }

  /**
   * Format the spinner text with phase, progress, and elapsed time
   */
  private formatText(elapsedSeconds: number): string {
    const progress = `(${this.phaseIndex}/${this.totalPhases})`;
    const elapsed =
      elapsedSeconds > 0 ? ` ${formatElapsedTime(elapsedSeconds)}` : "";
    const iterationSuffix =
      this.iteration && this.iteration > 1
        ? ` [iteration ${this.iteration}]`
        : "";

    return `${this.prefix}${this.phase} ${progress}...${elapsed}${iterationSuffix}`;
  }

  /**
   * Update the spinner text with current elapsed time
   */
  private updateElapsedTime(): void {
    if (this.disposed || this.paused) return;

    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    this.spinner.text = this.formatText(elapsedSeconds);
  }

  /**
   * Start the spinner
   *
   * Begins the animation and elapsed time tracking.
   */
  start(): PhaseSpinner {
    if (this.disposed) return this;

    this.startTime = Date.now();
    this.spinner.start(this.formatText(0));

    // Start elapsed time update interval
    this.intervalId = setInterval(() => {
      this.updateElapsedTime();
    }, ELAPSED_UPDATE_INTERVAL_MS);

    // Register with ShutdownManager for graceful cleanup
    if (this.shutdownManager) {
      this.shutdownManager.registerCleanup(this.cleanupName, async () => {
        this.stop();
      });
    }

    return this;
  }

  /**
   * Mark the phase as succeeded
   *
   * Stops the spinner and shows a checkmark with total duration.
   */
  succeed(customText?: string): PhaseSpinner {
    if (this.disposed) return this;

    this.clearInterval();
    this.unregisterCleanup();

    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    const duration = formatElapsedTime(elapsedSeconds);
    const progress = `(${this.phaseIndex}/${this.totalPhases})`;
    const text =
      customText ?? `${this.prefix}${this.phase} ${progress} (${duration})`;

    this.spinner.succeed(text);
    this.disposed = true;

    return this;
  }

  /**
   * Mark the phase as failed
   *
   * Stops the spinner and shows an error indicator with message.
   */
  fail(error?: string): PhaseSpinner {
    if (this.disposed) return this;

    this.clearInterval();
    this.unregisterCleanup();

    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    const duration = formatElapsedTime(elapsedSeconds);
    const progress = `(${this.phaseIndex}/${this.totalPhases})`;
    const errorSuffix = error ? `: ${error}` : "";
    const text = `${this.prefix}${this.phase} ${progress} (${duration})${errorSuffix}`;

    this.spinner.fail(text);
    this.disposed = true;

    return this;
  }

  /**
   * Stop the spinner without success/fail indication
   *
   * Use this for cleanup or when the phase is interrupted.
   */
  stop(): PhaseSpinner {
    if (this.disposed) return this;

    this.clearInterval();
    this.unregisterCleanup();
    this.spinner.stop();
    this.disposed = true;

    return this;
  }

  /**
   * Pause the spinner (for verbose streaming output)
   *
   * Temporarily stops the animation without disposing.
   * Call resume() to continue.
   */
  pause(): PhaseSpinner {
    if (this.disposed || this.paused) return this;

    this.paused = true;
    this.spinner.stop();

    return this;
  }

  /**
   * Resume the spinner after pause
   *
   * Restarts the animation with updated elapsed time.
   */
  resume(): PhaseSpinner {
    if (this.disposed || !this.paused) return this;

    this.paused = false;
    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    this.spinner.start(this.formatText(elapsedSeconds));

    return this;
  }

  /**
   * Check if the spinner is currently active
   */
  get isSpinning(): boolean {
    return this.spinner.isSpinning && !this.disposed && !this.paused;
  }

  /**
   * Get the total elapsed time in seconds
   */
  get elapsedSeconds(): number {
    if (this.startTime === 0) return 0;
    return (Date.now() - this.startTime) / 1000;
  }

  /**
   * Dispose of the spinner and clean up resources
   *
   * Called automatically by succeed(), fail(), or stop().
   * Safe to call multiple times.
   */
  dispose(): void {
    if (this.disposed) return;

    this.clearInterval();
    this.unregisterCleanup();
    this.spinner.stop();
    this.disposed = true;
  }

  /**
   * Clear the elapsed time update interval
   */
  private clearInterval(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Unregister from ShutdownManager
   */
  private unregisterCleanup(): void {
    if (this.shutdownManager) {
      this.shutdownManager.unregisterCleanup(this.cleanupName);
    }
  }
}

/**
 * Create a PhaseSpinner with the given options
 *
 * Convenience function matching the pattern of cli-ui.spinner().
 */
export function phaseSpinner(options: PhaseSpinnerOptions): PhaseSpinner {
  return new PhaseSpinner(options);
}
