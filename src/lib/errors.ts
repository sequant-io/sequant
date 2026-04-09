/**
 * Structured error types for Sequant workflow failures (AC-6, AC-10).
 *
 * Provides typed error subclasses with metadata instead of string categories,
 * enabling `instanceof` checks and `isRetryable` property for retry decisions.
 */

/**
 * Base error class for all Sequant errors.
 *
 * Subclasses set `isRetryable` to indicate whether the error is generally
 * recoverable. The executor still decides based on config + attempt count.
 */
export class SequantError extends Error {
  /** Whether this error type is generally retryable */
  readonly isRetryable: boolean;
  /** Structured metadata for diagnostics */
  readonly metadata: Record<string, unknown>;

  constructor(
    message: string,
    options?: {
      isRetryable?: boolean;
      metadata?: Record<string, unknown>;
      cause?: Error;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "SequantError";
    this.isRetryable = options?.isRetryable ?? false;
    this.metadata = options?.metadata ?? {};
  }

  /** Serialize to a plain object for JSON logging */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      isRetryable: this.isRetryable,
      metadata: this.metadata,
      stack: this.stack,
    };
  }
}

// ─── Subclasses (AC-6) ──────────────────────────────────────────────────────

export interface ContextOverflowMetadata {
  [key: string]: unknown;
  maxTokens?: number;
  usedTokens?: number;
}

/** Token/context limit exceeded */
export class ContextOverflowError extends SequantError {
  declare readonly metadata: ContextOverflowMetadata;

  constructor(
    message: string,
    metadata: ContextOverflowMetadata = {},
    cause?: Error,
  ) {
    super(message, { isRetryable: true, metadata, cause });
    this.name = "ContextOverflowError";
  }
}

export interface ApiErrorMetadata {
  [key: string]: unknown;
  statusCode?: number;
  endpoint?: string;
}

/** Rate limits, 503, auth failures (with HTTP status code if available) */
export class ApiError extends SequantError {
  declare readonly metadata: ApiErrorMetadata;

  constructor(message: string, metadata: ApiErrorMetadata = {}, cause?: Error) {
    // Retryable for transient errors (429, 502, 503), not for auth (401, 403)
    const retryableStatuses = new Set([429, 502, 503]);
    const isRetryable = metadata.statusCode
      ? retryableStatuses.has(metadata.statusCode)
      : false;
    super(message, { isRetryable, metadata, cause });
    this.name = "ApiError";
  }
}

export interface HookFailureMetadata {
  [key: string]: unknown;
  hook?: string;
  reason?: string;
}

/** Pre-commit hook failure (with hook name) */
export class HookFailureError extends SequantError {
  declare readonly metadata: HookFailureMetadata;

  constructor(
    message: string,
    metadata: HookFailureMetadata = {},
    cause?: Error,
  ) {
    super(message, { isRetryable: false, metadata, cause });
    this.name = "HookFailureError";
  }
}

export interface BuildErrorMetadata {
  [key: string]: unknown;
  toolchain?: string;
  errorCode?: string;
  file?: string;
  line?: number;
}

/** TypeScript, ESLint, npm errors (with file/line if parseable) */
export class BuildError extends SequantError {
  declare readonly metadata: BuildErrorMetadata;

  constructor(
    message: string,
    metadata: BuildErrorMetadata = {},
    cause?: Error,
  ) {
    super(message, { isRetryable: false, metadata, cause });
    this.name = "BuildError";
  }
}

export interface TimeoutErrorMetadata {
  [key: string]: unknown;
  timeoutMs?: number;
  phase?: string;
}

/** Phase exceeded time limit (with configured timeout value) */
export class TimeoutError extends SequantError {
  declare readonly metadata: TimeoutErrorMetadata;

  constructor(
    message: string,
    metadata: TimeoutErrorMetadata = {},
    cause?: Error,
  ) {
    super(message, { isRetryable: false, metadata, cause });
    this.name = "TimeoutError";
  }
}

export interface SubprocessErrorMetadata {
  [key: string]: unknown;
  command?: string;
  exitCode?: number;
  stderr?: string;
}

/** git/gh command failed (with command, exit code, stderr) */
export class SubprocessError extends SequantError {
  declare readonly metadata: SubprocessErrorMetadata;

  constructor(
    message: string,
    metadata: SubprocessErrorMetadata = {},
    cause?: Error,
  ) {
    // Signal-based exits (128+signal) are generally retryable (e.g., 143 = SIGTERM)
    const exitCode = metadata.exitCode;
    const isRetryable =
      exitCode !== undefined && exitCode >= 128 && exitCode <= 192;
    super(message, { isRetryable, metadata, cause });
    this.name = "SubprocessError";
  }
}

/**
 * Map of error type names to their constructors.
 * Used for deserialization from logs.
 */
export const ERROR_TYPE_MAP: Record<
  string,
  new (
    message: string,
    metadata?: Record<string, unknown>,
    cause?: Error,
  ) => SequantError
> = {
  SequantError: SequantError as never,
  ContextOverflowError: ContextOverflowError as never,
  ApiError: ApiError as never,
  HookFailureError: HookFailureError as never,
  BuildError: BuildError as never,
  TimeoutError: TimeoutError as never,
  SubprocessError: SubprocessError as never,
};
