/**
 * Error classifier — categorizes phase failures from stderr content.
 *
 * Refactored (AC-7): Returns typed SequantError instances instead of string
 * categories. Exit codes are the primary signal; stderr patterns are secondary.
 */

import {
  SequantError,
  ContextOverflowError,
  ApiError,
  HookFailureError,
  BuildError,
  TimeoutError,
  SubprocessError,
} from "../errors.js";

/** All recognized error categories (kept for backwards compatibility). */
export const ERROR_CATEGORIES = [
  "context_overflow",
  "api_error",
  "hook_failure",
  "build_error",
  "timeout",
  "unknown",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * Map from error type name to legacy category string.
 * Used for backwards-compatible log storage (AC-8).
 */
export function errorTypeToCategory(error: SequantError): ErrorCategory {
  switch (error.name) {
    case "ContextOverflowError":
      return "context_overflow";
    case "ApiError":
      return "api_error";
    case "HookFailureError":
      return "hook_failure";
    case "BuildError":
      return "build_error";
    case "TimeoutError":
      return "timeout";
    default:
      return "unknown";
  }
}

/**
 * Ordered list of classifiers. First match wins (highest priority first).
 */
const CLASSIFIERS: {
  category: ErrorCategory;
  patterns: RegExp[];
  /** Extract metadata from the matched line */
  extract?: (line: string) => Record<string, unknown>;
}[] = [
  {
    category: "context_overflow",
    patterns: [
      /context window/i,
      /token limit/i,
      /context length/i,
      /max.?context/i,
      /exceeded.*context/i,
    ],
  },
  {
    category: "timeout",
    patterns: [/timeout/i, /timed?\s*out/i, /SIGTERM/, /deadline exceeded/i],
    extract: (line: string) => {
      const match = line.match(/(\d+)\s*(?:s|ms|seconds?|milliseconds?)/i);
      if (match) {
        const value = parseInt(match[1], 10);
        // If the unit looks like seconds (or no unit after number), convert to ms
        const isMs = /ms|milliseconds?/i.test(match[0]);
        return { timeoutMs: isMs ? value : value * 1000 };
      }
      return {};
    },
  },
  {
    category: "api_error",
    patterns: [
      /rate.?limit/i,
      /\b429\b/,
      /api.*error/i,
      /auth.*fail/i,
      /unauthorized/i,
      /\b503\b/,
      /\b502\b/,
      /overloaded/i,
    ],
    extract: (line: string) => {
      const statusMatch = line.match(/\b(429|502|503|401|403)\b/);
      return statusMatch ? { statusCode: parseInt(statusMatch[1], 10) } : {};
    },
  },
  {
    category: "hook_failure",
    patterns: [
      /hook.*fail/i,
      /pre-?commit/i,
      /HOOK_BLOCKED/i,
      /blocked by hook/i,
    ],
    extract: (line: string) => {
      const hookMatch = line.match(
        /(?:hook|pre-?commit|HOOK_BLOCKED)[:\s]*(.{0,50})/i,
      );
      return hookMatch ? { hook: hookMatch[1]?.trim() || "unknown" } : {};
    },
  },
  {
    category: "build_error",
    patterns: [
      /typescript.*error/i,
      /TS\d{4,5}:/,
      /syntax\s*error/i,
      /cannot find module/i,
      /compilation.*fail/i,
      /build.*fail/i,
      /eslint/i,
      /npm ERR!/,
    ],
    extract: (line: string) => {
      if (/TS\d{4,5}:/.test(line)) {
        const codeMatch = line.match(/(TS\d{4,5}):/);
        return { toolchain: "tsc", errorCode: codeMatch?.[1] };
      }
      if (/eslint/i.test(line)) return { toolchain: "eslint" };
      if (/npm ERR!/.test(line)) return { toolchain: "npm" };
      return { toolchain: "unknown" };
    },
  },
];

/**
 * Classify stderr lines into a typed SequantError instance (AC-7).
 *
 * Exit codes are the primary signal; stderr patterns are secondary.
 * Returns a typed error instance with structured metadata.
 *
 * @param stderrLines - Lines from stderr
 * @param exitCode - Process exit code (primary signal)
 * @returns Typed SequantError subclass instance
 */
export function classifyError(
  stderrLines: string[],
  exitCode?: number,
): SequantError {
  const combinedStderr = stderrLines?.join(" ") ?? "";

  // Primary signal: exit code (AC-7)
  if (exitCode !== undefined) {
    // 143 = SIGTERM, often timeout
    if (exitCode === 143 || exitCode === 137) {
      return new TimeoutError(
        `Process killed with signal (exit code ${exitCode})`,
        { timeoutMs: undefined, phase: undefined },
      );
    }
  }

  // Secondary signal: stderr pattern matching
  if (stderrLines && stderrLines.length > 0) {
    for (const { category, patterns, extract } of CLASSIFIERS) {
      for (const line of stderrLines) {
        for (const pattern of patterns) {
          if (pattern.test(line)) {
            const metadata = extract?.(line) ?? {};
            return createErrorForCategory(category, line, metadata, exitCode);
          }
        }
      }
    }
  }

  // Fallback: SubprocessError with exit code
  return new SubprocessError(combinedStderr || "Unknown error", {
    exitCode,
    command: undefined,
    stderr: combinedStderr || undefined,
  });
}

/**
 * Create a typed error instance from a legacy category string.
 */
function createErrorForCategory(
  category: ErrorCategory,
  message: string,
  metadata: Record<string, unknown>,
  exitCode?: number,
): SequantError {
  switch (category) {
    case "context_overflow":
      return new ContextOverflowError(message, metadata);
    case "api_error":
      return new ApiError(message, {
        statusCode: metadata.statusCode as number | undefined,
        endpoint: metadata.endpoint as string | undefined,
      });
    case "hook_failure":
      return new HookFailureError(message, {
        hook: metadata.hook as string | undefined,
        reason: metadata.reason as string | undefined,
      });
    case "build_error":
      return new BuildError(message, {
        toolchain: metadata.toolchain as string | undefined,
        errorCode: metadata.errorCode as string | undefined,
      });
    case "timeout":
      return new TimeoutError(message, {
        timeoutMs: metadata.timeoutMs as number | undefined,
      });
    default:
      return new SubprocessError(message, { exitCode });
  }
}
