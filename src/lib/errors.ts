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

// ─── Rate-limit / billing errors (#732) ─────────────────────────────────────

/**
 * Metadata carried by {@link RateLimitError} / {@link BillingError}.
 *
 * Fields mirror the structured signals the Claude Agent SDK emits via
 * `rate_limit_event` (`SDKRateLimitInfo`). The `canUserPurchaseCredits` /
 * `hasChargeableSavedPaymentMethod` fields arrived in SDK 0.3.181 and are
 * optional so older streams (or absent fields) degrade gracefully.
 */
export interface RateLimitMetadata {
  [key: string]: unknown;
  /** Unix timestamp (seconds or ms) at which the limit resets. */
  resetsAt?: number;
  /** Which limit window was hit (five_hour, seven_day, overage, …). */
  rateLimitType?: string;
  /** Why overage/billing was disabled (e.g. `out_of_credits`). */
  overageDisabledReason?: string;
  /** SDK error code; `credits_required` indicates a billing failure. */
  errorCode?: string;
  /** Whether the user can self-serve purchase credits (≥0.3.181). */
  canUserPurchaseCredits?: boolean;
  /** Whether a chargeable payment method is on file (≥0.3.181). */
  hasChargeableSavedPaymentMethod?: boolean;
}

/**
 * Transient rate-limit error (HTTP 429-style throttle, overloaded API).
 *
 * Retryable: waiting and re-running can succeed once the limit window resets.
 */
export class RateLimitError extends SequantError {
  declare readonly metadata: RateLimitMetadata;

  constructor(
    message: string,
    metadata: RateLimitMetadata = {},
    cause?: Error,
  ) {
    super(message, { isRetryable: true, metadata, cause });
    this.name = "RateLimitError";
  }
}

/**
 * Billing / out-of-credits error.
 *
 * NOT retryable: a no-MCP retry (or any retry) cannot refill credits, so the
 * executor must surface the real cause instead of looping. Drives the #592
 * fallback-noise skip in phase-executor.
 */
export class BillingError extends SequantError {
  declare readonly metadata: RateLimitMetadata;

  constructor(
    message: string,
    metadata: RateLimitMetadata = {},
    cause?: Error,
  ) {
    super(message, { isRetryable: false, metadata, cause });
    this.name = "BillingError";
  }
}

/**
 * Structural subset of the SDK's `SDKRateLimitInfo` consumed when building a
 * rate-limit error. Declared here (not imported from the SDK) so `errors.ts`
 * stays SDK-free — only the driver owns the `@anthropic-ai/claude-agent-sdk`
 * import.
 */
export interface RateLimitInfoLike {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageDisabledReason?: string;
  errorCode?: string;
  canUserPurchaseCredits?: boolean;
  hasChargeableSavedPaymentMethod?: boolean;
}

/**
 * True when the rate-limit info represents a billing/credits failure (which a
 * retry cannot fix), rather than a transient throttle.
 */
export function isBillingFailure(info: RateLimitInfoLike): boolean {
  return (
    info.errorCode === "credits_required" ||
    info.overageDisabledReason === "out_of_credits"
  );
}

/**
 * True when the rate-limit info represents an actual failure (rejection or
 * billing), as opposed to an informational `allowed` / `allowed_warning`
 * event. The driver uses this to avoid mis-attributing a stale warning event
 * to an unrelated phase failure.
 */
export function isRateLimitFailureInfo(info: RateLimitInfoLike): boolean {
  return info.status === "rejected" || isBillingFailure(info);
}

/** Format a Unix timestamp (seconds or ms) as a local `HH:MM` string. */
function formatResetTime(resetsAt: number): string {
  // Heuristic: values below ~1e12 are seconds, otherwise milliseconds.
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Build a user-facing message from rate-limit info, naming the real cause:
 * - billing/credits → "Out of credits" (enriched with purchasable vs hard
 *   limit when the ≥0.3.181 `canUserPurchaseCredits` field is present)
 * - transient throttle → "Rate limited — resets at HH:MM" (reset time omitted
 *   when `resetsAt` is absent)
 */
export function formatRateLimitMessage(info: RateLimitInfoLike): string {
  if (isBillingFailure(info)) {
    if (info.canUserPurchaseCredits === true) {
      return "Out of credits — purchasable";
    }
    if (info.canUserPurchaseCredits === false) {
      return "Out of credits — hard limit";
    }
    return "Out of credits";
  }
  if (info.resetsAt !== undefined) {
    return `Rate limited — resets at ${formatResetTime(info.resetsAt)}`;
  }
  return "Rate limited";
}

/**
 * Construct the appropriate typed error from structured rate-limit info.
 * Billing/credits failures become a non-retryable {@link BillingError};
 * transient throttles become a retryable {@link RateLimitError}.
 */
export function createRateLimitError(
  info: RateLimitInfoLike,
): RateLimitError | BillingError {
  const message = formatRateLimitMessage(info);
  const metadata: RateLimitMetadata = {
    resetsAt: info.resetsAt,
    rateLimitType: info.rateLimitType,
    overageDisabledReason: info.overageDisabledReason,
    errorCode: info.errorCode,
    canUserPurchaseCredits: info.canUserPurchaseCredits,
    hasChargeableSavedPaymentMethod: info.hasChargeableSavedPaymentMethod,
  };
  return isBillingFailure(info)
    ? new BillingError(message, metadata)
    : new RateLimitError(message, metadata);
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
  RateLimitError: RateLimitError as never,
  BillingError: BillingError as never,
};
