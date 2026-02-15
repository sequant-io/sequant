/**
 * Metrics writer for local workflow analytics
 *
 * Provides atomic writes (temp file + rename) to prevent corruption.
 * All data stays local - no network requests.
 *
 * @example
 * ```typescript
 * import { MetricsWriter } from './metrics-writer';
 *
 * const writer = new MetricsWriter();
 * await writer.recordRun({
 *   issues: [123, 124],
 *   phases: ['spec', 'exec', 'qa'],
 *   outcome: 'success',
 *   duration: 720,
 *   model: 'opus',
 *   flags: ['--chain'],
 *   metrics: { filesChanged: 9, linesAdded: 1800 }
 * });
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  type Metrics,
  type MetricRun,
  type MetricPhase,
  type RunOutcome,
  type RunMetrics,
  MetricsSchema,
  METRICS_FILE_PATH,
  createEmptyMetrics,
  createMetricRun,
} from "./metrics-schema.js";

export interface MetricsWriterOptions {
  /** Path to metrics file (default: .sequant/metrics.json) */
  metricsPath?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Manages local workflow metrics collection
 */
export class MetricsWriter {
  private metricsPath: string;
  private verbose: boolean;
  private cachedMetrics: Metrics | null = null;

  constructor(options: MetricsWriterOptions = {}) {
    this.metricsPath = options.metricsPath ?? METRICS_FILE_PATH;
    this.verbose = options.verbose ?? false;
  }

  /**
   * Get the full path to the metrics file
   */
  getMetricsPath(): string {
    return this.metricsPath;
  }

  /**
   * Read the current metrics data
   *
   * Returns empty metrics if file doesn't exist.
   * Throws on parse errors.
   */
  async getMetrics(): Promise<Metrics> {
    // Return cached metrics if available
    if (this.cachedMetrics) {
      return this.cachedMetrics;
    }

    if (!fs.existsSync(this.metricsPath)) {
      const emptyMetrics = createEmptyMetrics();
      this.cachedMetrics = emptyMetrics;
      return emptyMetrics;
    }

    try {
      const content = fs.readFileSync(this.metricsPath, "utf-8");
      const parsed = JSON.parse(content);
      const metrics = MetricsSchema.parse(parsed);
      this.cachedMetrics = metrics;
      return metrics;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in metrics file: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Write metrics to disk using atomic write
   *
   * Writes to a temp file first, then renames to prevent corruption
   * if the process is interrupted during write.
   */
  async saveMetrics(metrics: Metrics): Promise<void> {
    // Validate before writing
    MetricsSchema.parse(metrics);

    // Ensure directory exists
    const dir = path.dirname(this.metricsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write to temp file first (atomic write pattern)
    const tempPath = path.join(
      os.tmpdir(),
      `sequant-metrics-${Date.now()}-${process.pid}.json`,
    );

    try {
      fs.writeFileSync(tempPath, JSON.stringify(metrics, null, 2));

      // Rename temp file to actual path (atomic on most systems)
      fs.renameSync(tempPath, this.metricsPath);

      // Update cache
      this.cachedMetrics = metrics;
    } catch (error) {
      // Clean up temp file on error
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw error;
    }
  }

  /**
   * Clear the cached metrics (forces re-read on next access)
   */
  clearCache(): void {
    this.cachedMetrics = null;
  }

  /**
   * Record a workflow run
   *
   * @param options - Run data to record
   */
  async recordRun(options: {
    issues: number[];
    phases: MetricPhase[];
    outcome: RunOutcome;
    duration: number;
    model?: string;
    flags?: string[];
    metrics?: Partial<RunMetrics>;
  }): Promise<MetricRun> {
    const metrics = await this.getMetrics();
    const run = createMetricRun(options);

    metrics.runs.push(run);
    await this.saveMetrics(metrics);

    if (this.verbose) {
      console.log(`📊 Recorded run: ${run.id.slice(0, 8)}... (${run.outcome})`);
    }

    return run;
  }

  /**
   * Get all runs
   */
  async getAllRuns(): Promise<MetricRun[]> {
    const metrics = await this.getMetrics();
    return metrics.runs;
  }

  /**
   * Get runs filtered by date range
   */
  async getRunsByDateRange(start: Date, end: Date): Promise<MetricRun[]> {
    const runs = await this.getAllRuns();
    return runs.filter((run) => {
      const runDate = new Date(run.date);
      return runDate >= start && runDate <= end;
    });
  }

  /**
   * Get the most recent N runs
   */
  async getRecentRuns(count: number): Promise<MetricRun[]> {
    const runs = await this.getAllRuns();
    // Runs are stored in chronological order, get the last N
    return runs.slice(-count);
  }

  /**
   * Check if metrics file exists
   */
  metricsExists(): boolean {
    return fs.existsSync(this.metricsPath);
  }

  /**
   * Delete the metrics file (for testing or user request)
   */
  async deleteMetrics(): Promise<void> {
    if (fs.existsSync(this.metricsPath)) {
      fs.unlinkSync(this.metricsPath);
      this.cachedMetrics = null;

      if (this.verbose) {
        console.log(`📊 Metrics deleted: ${this.metricsPath}`);
      }
    }
  }
}

// Export a default instance for convenience
let defaultWriter: MetricsWriter | null = null;

/**
 * Get the default metrics writer instance
 */
export function getMetricsWriter(
  options?: MetricsWriterOptions,
): MetricsWriter {
  if (!defaultWriter || options) {
    defaultWriter = new MetricsWriter(options);
  }
  return defaultWriter;
}

/**
 * Reset the default metrics writer (for testing)
 */
export function resetMetricsWriter(): void {
  defaultWriter = null;
}
