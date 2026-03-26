/**
 * Error classifier — categorizes phase failures from stderr content.
 *
 * Pattern-matches stderr lines against known error signatures to produce
 * a structured category for analytics and debugging.
 */

/** All recognized error categories (AC-7: defined as constants). */
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
 * Ordered list of classifiers. First match wins (highest priority first).
 */
const CLASSIFIERS: { category: ErrorCategory; patterns: RegExp[] }[] = [
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
  },
  {
    category: "api_error",
    patterns: [
      /rate.?limit/i,
      /429/,
      /api.*error/i,
      /auth.*fail/i,
      /unauthorized/i,
      /503/,
      /502/,
      /overloaded/i,
    ],
  },
  {
    category: "hook_failure",
    patterns: [
      /hook.*fail/i,
      /pre-?commit/i,
      /HOOK_BLOCKED/i,
      /blocked by hook/i,
    ],
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
  },
];

/**
 * Classify stderr lines into an error category.
 *
 * Scans lines in order; the first classifier whose pattern matches any line wins.
 * Returns "unknown" if no patterns match.
 */
export function classifyError(stderrLines: string[]): ErrorCategory {
  if (!stderrLines || stderrLines.length === 0) {
    return "unknown";
  }

  for (const { category, patterns } of CLASSIFIERS) {
    for (const line of stderrLines) {
      for (const pattern of patterns) {
        if (pattern.test(line)) {
          return category;
        }
      }
    }
  }

  return "unknown";
}
