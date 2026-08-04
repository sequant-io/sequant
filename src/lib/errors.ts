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
 * Recognized rate-limit *window* vocabulary — limit types whose exhaustion is
 * a pause that reopens at `resetsAt`, not a wallet state. `five_hour` is the
 * subscription session window; `seven_day` is prefix-matched because the SDK
 * emits model-qualified variants (`seven_day*`, see {@link formatResetTime}).
 *
 * Deliberately an allowlist (#860 AC-3): this encodes an inference about
 * Anthropic's payload vocabulary, so an unlisted type (e.g. `overage`) must
 * fail closed to the terminal billing path rather than into a five-hour sleep.
 */
const WAITABLE_WINDOW_TYPE_RE = /^(five_hour|seven_day)/;

/**
 * True when the rate-limit info describes an exhausted *window* that will
 * reopen at a known future time: a recognized window `rateLimitType` plus a
 * `resetsAt` still in the future (#860 AC-1).
 *
 * This is the discriminator between "subscription window closed until 07:00"
 * and "account needs credits". The fields that would answer that directly
 * (`canUserPurchaseCredits`, `hasChargeableSavedPaymentMethod`) are absent
 * from every real captured payload, so the window shape is the proxy — and
 * any unrecognized shape returns false (fail closed, #860 AC-3).
 *
 * Explicitly informational statuses (`allowed` / `allowed_warning`) are never
 * waitable. The driver retains marker-carrying warnings as failure-grade
 * (pre-#732 semantics, unchanged), so a stale "you are nearing your limit"
 * warning can be misattributed to an unrelated phase failure — classifying it
 * waitable would upgrade that misattribution from a cheap immediate halt to a
 * multi-hour sleep. The 26 real captures carry no `status` field at all, so
 * absent status stays waitable; only a status that affirmatively says
 * "not a rejection" is excluded.
 */
export function isWaitableWindow(
  info: RateLimitInfoLike,
  now: number = Date.now(),
): boolean {
  if (info.status === "allowed" || info.status === "allowed_warning") {
    return false;
  }
  if (typeof info.rateLimitType !== "string") return false;
  if (!WAITABLE_WINDOW_TYPE_RE.test(info.rateLimitType)) return false;
  if (typeof info.resetsAt !== "number") return false;
  return resetsAtToMs(info.resetsAt) > now;
}

/**
 * Vocabulary-drift telemetry for the #860 fail-closed path: returns a hint
 * string when a payload was terminal ONLY because its `rateLimitType` is not
 * in the recognized window allowlist — i.e. it carries `out_of_credits` plus a
 * live future `resetsAt` and a *present but unrecognized* window type, and no
 * explicit `credits_required`. If Anthropic renames or adds a window type,
 * the halt message names the rejected type instead of silently reading as an
 * ordinary wallet failure. A missing `rateLimitType` is NOT drift evidence
 * (API-account payloads may legitimately omit it), so no hint fires there.
 */
export function unrecognizedWindowHint(
  info: RateLimitInfoLike,
  now: number = Date.now(),
): string | null {
  if (info.errorCode === "credits_required") return null;
  if (info.overageDisabledReason !== "out_of_credits") return null;
  if (info.status === "allowed" || info.status === "allowed_warning") {
    return null;
  }
  if (typeof info.rateLimitType !== "string") return null;
  if (WAITABLE_WINDOW_TYPE_RE.test(info.rateLimitType)) return null;
  if (typeof info.resetsAt !== "number") return null;
  if (resetsAtToMs(info.resetsAt) <= now) return null;
  return `unrecognized window type "${info.rateLimitType}" with a future reset — treated as terminal (auto-wait recognizes five_hour/seven_day)`;
}

/**
 * True when the info carries an explicit billing/credits marker, regardless
 * of whether a live window would make it waitable. This is the pre-#860
 * `isBillingFailure` predicate, kept for failure-*detection* sites
 * ({@link isRateLimitFailureInfo}) whose retention semantics must not narrow.
 */
function hasBillingMarkers(info: RateLimitInfoLike): boolean {
  return (
    info.errorCode === "credits_required" ||
    info.overageDisabledReason === "out_of_credits"
  );
}

/**
 * True when the rate-limit info represents a billing/credits failure (which
 * waiting cannot fix), rather than a transient throttle or an exhausted
 * window.
 *
 * Narrowed by #860: a subscription plan hitting its five-hour cap with
 * overage disabled emits `overageDisabledReason: "out_of_credits"` *plus* a
 * window type and a live `resetsAt` — a pause, not a wallet failure. That
 * shape is excluded here so it classifies as a retryable {@link RateLimitError}
 * and `--auto-wait` (#804) can act on it. An explicit
 * `errorCode: "credits_required"` stays terminal even alongside window
 * evidence — it is the SDK's direct "purchase needed" signal (#860 AC-2).
 * Anything short of the full recognized window shape remains terminal
 * (fail closed, #860 AC-3).
 */
export function isBillingFailure(
  info: RateLimitInfoLike,
  now: number = Date.now(),
): boolean {
  if (info.errorCode === "credits_required") return true;
  return (
    info.overageDisabledReason === "out_of_credits" &&
    !isWaitableWindow(info, now)
  );
}

/**
 * True when the rate-limit info represents an actual failure (rejection or
 * billing), as opposed to an informational `allowed` / `allowed_warning`
 * event. The driver uses this to avoid mis-attributing a stale warning event
 * to an unrelated phase failure.
 *
 * Built on the raw billing *markers*, not the #860-narrowed classification:
 * the captured five-hour payloads cannot prove they carried
 * `status: "rejected"`, so narrowing here could silently drop the very events
 * #860 exists to keep (they'd fall back to a metadata-less assistant error and
 * auto-wait would stay inert). Retention semantics are unchanged; only the
 * billing-vs-waitable *classification* narrowed.
 */
export function isRateLimitFailureInfo(info: RateLimitInfoLike): boolean {
  return info.status === "rejected" || hasBillingMarkers(info);
}

/**
 * Normalize a `resetsAt` timestamp to milliseconds. The SDK does not pin the
 * unit, so use the same heuristic everywhere a `resetsAt` is compared or
 * displayed: values below ~1e12 are seconds, otherwise milliseconds.
 */
export function resetsAtToMs(resetsAt: number): number {
  return resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
}

/**
 * Format a Unix timestamp (seconds or ms) as a local time string.
 *
 * Bare `HH:MM` when the reset falls on the current local calendar day;
 * date-qualified `MM-DD HH:MM` otherwise. Also used for #804's auto-wait wake
 * time (a wake is `resetsAt + buffer`, already in ms, which `resetsAtToMs`
 * passes through unchanged) so both render in one convention.
 *
 * Multi-day windows
 * (`rateLimitType: seven_day*`) can reset days out — a bare `HH:MM` there reads
 * as "later today" and misleads the user (#732 QA follow-up), so the date is
 * included whenever the reset is not today.
 */
export function formatResetTime(resetsAt: number): string {
  const ms = resetsAtToMs(resetsAt);
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${hh}:${mm}`;
  }
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${mon}-${day} ${hh}:${mm}`;
}

/**
 * Build a user-facing message from rate-limit info, naming the real cause:
 * - billing/credits → "Out of credits" (enriched with purchasable vs hard
 *   limit when the ≥0.3.181 `canUserPurchaseCredits` field is present)
 * - transient throttle → "Rate limited — resets at HH:MM" (date-qualified as
 *   "MM-DD HH:MM" when the reset is not today; reset time omitted entirely when
 *   `resetsAt` is absent)
 *
 * `now` feeds the #860 waitable-window classification so message and error
 * type are derived against the same instant (and tests can pin the clock).
 * A waitable window renders through the rate-limited branch — its reset time
 * is the actionable fact; "Out of credits" would misname a pause as a wallet
 * failure.
 */
export function formatRateLimitMessage(
  info: RateLimitInfoLike,
  now: number = Date.now(),
): string {
  if (isBillingFailure(info, now)) {
    // #860 drift telemetry: when the ONLY reason this is terminal is an
    // unrecognized window type, say so — the message is the one channel that
    // reaches run output, logs, and `PhaseResult.error` on every display path.
    const hint = unrecognizedWindowHint(info, now);
    const suffix = hint ? ` (${hint})` : "";
    if (info.canUserPurchaseCredits === true) {
      return `Out of credits — purchasable${suffix}`;
    }
    if (info.canUserPurchaseCredits === false) {
      return `Out of credits — hard limit${suffix}`;
    }
    return `Out of credits${suffix}`;
  }
  if (info.resetsAt !== undefined) {
    return `Rate limited — resets at ${formatResetTime(info.resetsAt)}`;
  }
  return "Rate limited";
}

/**
 * Construct the appropriate typed error from structured rate-limit info.
 * Billing/credits failures become a non-retryable {@link BillingError};
 * transient throttles AND exhausted-but-reopening windows (#860) become a
 * retryable {@link RateLimitError}. `now` pins the waitable-window check to
 * one instant across message and classification.
 */
export function createRateLimitError(
  info: RateLimitInfoLike,
  now: number = Date.now(),
): RateLimitError | BillingError {
  const message = formatRateLimitMessage(info, now);
  const metadata: RateLimitMetadata = {
    resetsAt: info.resetsAt,
    rateLimitType: info.rateLimitType,
    overageDisabledReason: info.overageDisabledReason,
    errorCode: info.errorCode,
    canUserPurchaseCredits: info.canUserPurchaseCredits,
    hasChargeableSavedPaymentMethod: info.hasChargeableSavedPaymentMethod,
  };
  return isBillingFailure(info, now)
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
