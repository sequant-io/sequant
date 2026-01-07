/**
 * Structured Logger for Pipeline Scripts
 *
 * Provides log levels with emoji prefixes for visual scanning in terminal output.
 * Supports verbose mode integration with CLI arguments.
 *
 * @example
 * ```typescript
 * import { createLogger } from './lib/logger'
 *
 * const log = createLogger({ verbose: args.verbose })
 *
 * log.debug('Processing item', { id: 123 })  // Only shown in verbose mode
 * log.info('Starting process')
 * log.success('Completed successfully')
 * log.warn('Missing optional field')
 * log.error('Failed to connect', error)
 * ```
 */

/**
 * Log levels in order of severity.
 */
export type LogLevel = "debug" | "info" | "success" | "warn" | "error";

/**
 * Logger configuration options.
 */
export interface LoggerOptions {
  /** Enable debug level logging (default: false) */
  verbose?: boolean;
  /** Suppress all console output (default: false). Useful when another renderer (e.g., listr2) controls the terminal. */
  silent?: boolean;
  /** Custom output function (default: console.log) */
  output?: (message: string) => void;
  /** Custom error output function (default: console.error) */
  errorOutput?: (message: string) => void;
  /** Include timestamps in log messages (default: false) */
  timestamps?: boolean;
}

/**
 * Logger interface with methods for each log level.
 */
export interface Logger {
  /** Debug-level logging (only shown when verbose is true) */
  debug(message: string, data?: unknown): void;
  /** Info-level logging */
  info(message: string, data?: unknown): void;
  /** Success-level logging */
  success(message: string, data?: unknown): void;
  /** Warning-level logging */
  warn(message: string, data?: unknown): void;
  /** Error-level logging */
  error(message: string, data?: unknown): void;
  /** Log at a specific level */
  log(level: LogLevel, message: string, data?: unknown): void;
  /** Create a child logger with a prefix */
  child(prefix: string): Logger;
  /** Check if verbose mode is enabled */
  isVerbose(): boolean;
}

/**
 * Emoji prefixes for each log level.
 */
const LOG_PREFIXES: Record<LogLevel, string> = {
  debug: "🔍",
  info: "ℹ️",
  success: "✅",
  warn: "⚠️",
  error: "❌",
};

/**
 * Format a log message with optional data.
 *
 * @param level - The log level
 * @param message - The log message
 * @param data - Optional data to include
 * @param options - Additional formatting options
 * @returns Formatted log string
 */
function formatMessage(
  level: LogLevel,
  message: string,
  data?: unknown,
  options?: { prefix?: string; timestamp?: boolean },
): string {
  const parts: string[] = [];

  // Add timestamp if enabled
  if (options?.timestamp) {
    const now = new Date().toISOString().slice(11, 19); // HH:MM:SS
    parts.push(`[${now}]`);
  }

  // Add emoji prefix
  parts.push(LOG_PREFIXES[level]);

  // Add custom prefix if provided
  if (options?.prefix) {
    parts.push(`[${options.prefix}]`);
  }

  // Add message
  parts.push(message);

  // Add data if provided
  if (data !== undefined) {
    if (data instanceof Error) {
      parts.push(`- ${data.message}`);
      if (data.stack) {
        parts.push(`\n  ${data.stack.split("\n").slice(1).join("\n  ")}`);
      }
    } else if (typeof data === "object") {
      parts.push(`- ${JSON.stringify(data)}`);
    } else {
      parts.push(`- ${String(data)}`);
    }
  }

  return parts.join(" ");
}

/**
 * Create a structured logger with configurable options.
 *
 * @param options - Logger configuration
 * @returns A Logger instance
 *
 * @example
 * ```typescript
 * // Basic usage
 * const log = createLogger()
 * log.info('Hello')
 *
 * // With verbose mode
 * const verboseLog = createLogger({ verbose: true })
 * verboseLog.debug('Debug info') // Now visible
 *
 * // With timestamps
 * const timedLog = createLogger({ timestamps: true })
 * timedLog.info('With time') // [12:34:56] ℹ️ With time
 *
 * // Child logger with prefix
 * const childLog = log.child('discovery')
 * childLog.info('Finding items') // ℹ️ [discovery] Finding items
 * ```
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const {
    verbose = false,
    silent = false,
    output = console.log,
    errorOutput = console.error,
    timestamps = false,
  } = options;

  const createLogFunction = (prefix?: string): Logger => ({
    debug(message: string, data?: unknown): void {
      if (silent || !verbose) return;
      output(
        formatMessage("debug", message, data, {
          prefix,
          timestamp: timestamps,
        }),
      );
    },

    info(message: string, data?: unknown): void {
      if (silent) return;
      output(
        formatMessage("info", message, data, { prefix, timestamp: timestamps }),
      );
    },

    success(message: string, data?: unknown): void {
      if (silent) return;
      output(
        formatMessage("success", message, data, {
          prefix,
          timestamp: timestamps,
        }),
      );
    },

    warn(message: string, data?: unknown): void {
      if (silent) return;
      output(
        formatMessage("warn", message, data, { prefix, timestamp: timestamps }),
      );
    },

    error(message: string, data?: unknown): void {
      if (silent) return;
      errorOutput(
        formatMessage("error", message, data, {
          prefix,
          timestamp: timestamps,
        }),
      );
    },

    log(level: LogLevel, message: string, data?: unknown): void {
      if (silent) return;
      if (level === "debug" && !verbose) return;
      const logFn = level === "error" ? errorOutput : output;
      logFn(
        formatMessage(level, message, data, { prefix, timestamp: timestamps }),
      );
    },

    child(childPrefix: string): Logger {
      const newPrefix = prefix ? `${prefix}:${childPrefix}` : childPrefix;
      return createLogFunction(newPrefix);
    },

    isVerbose(): boolean {
      return verbose;
    },
  });

  return createLogFunction();
}

/**
 * Default logger instance (non-verbose).
 * Use `createLogger({ verbose: true })` for verbose mode.
 */
export const defaultLogger = createLogger();

/**
 * Quick logging functions using the default logger.
 * For scripts that don't need verbose mode configuration.
 *
 * @example
 * ```typescript
 * import { log } from './lib/logger'
 *
 * log.info('Starting')
 * log.success('Done')
 * ```
 */
export const log = defaultLogger;

/**
 * Create a logger that logs to an array for testing.
 *
 * @returns Object with logger and captured messages
 *
 * @example
 * ```typescript
 * const { logger, messages } = createTestLogger()
 * logger.info('test')
 * expect(messages).toContain(expect.stringContaining('test'))
 * ```
 */
export function createTestLogger(
  options: Omit<LoggerOptions, "output" | "errorOutput"> = {},
): {
  logger: Logger;
  messages: string[];
  errors: string[];
} {
  const messages: string[] = [];
  const errors: string[] = [];

  const logger = createLogger({
    ...options,
    output: (msg) => messages.push(msg),
    errorOutput: (msg) => errors.push(msg),
  });

  return { logger, messages, errors };
}

/**
 * Log a step in a multi-step process.
 *
 * @param step - Current step number
 * @param total - Total number of steps
 * @param message - Step description
 *
 * @example
 * ```typescript
 * logStep(1, 3, 'Fetching data')
 * // Output: ℹ️ [1/3] Fetching data
 * ```
 */
export function logStep(step: number, total: number, message: string): void {
  console.log(`ℹ️ [${step}/${total}] ${message}`);
}

/**
 * Log a progress update within a step.
 *
 * @param current - Current progress
 * @param total - Total items
 * @param message - Progress description
 *
 * @example
 * ```typescript
 * logProgress(5, 10, 'Processing items')
 * // Output:   → 5/10 Processing items
 * ```
 */
export function logProgress(
  current: number,
  total: number,
  message: string,
): void {
  console.log(`  → ${current}/${total} ${message}`);
}

/**
 * Log a section header for visual organization.
 *
 * @param title - Section title
 *
 * @example
 * ```typescript
 * logSection('Discovery Results')
 * // Output:
 * // ════════════════════════════════════════
 * // Discovery Results
 * // ════════════════════════════════════════
 * ```
 */
export function logSection(title: string): void {
  const line = "═".repeat(40);
  console.log(`\n${line}`);
  console.log(title);
  console.log(`${line}\n`);
}

/**
 * Log a divider line.
 */
export function logDivider(): void {
  console.log("─".repeat(40));
}
