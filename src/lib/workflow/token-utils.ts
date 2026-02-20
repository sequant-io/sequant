/**
 * Token usage utilities for pipeline observability (AC-5, AC-6)
 *
 * Reads token usage files written by the SessionEnd hook and
 * aggregates them for metrics recording.
 */

import * as fs from "fs";
import * as path from "path";

/**
 * Token usage data from a single session file
 */
export interface TokenUsageData {
  /** Input tokens consumed */
  input_tokens: number;
  /** Output tokens generated */
  output_tokens: number;
  /** Tokens used for cache creation */
  cache_creation_tokens?: number;
  /** Tokens read from cache */
  cache_read_tokens?: number;
  /** Optional timestamp when captured */
  timestamp?: string;
  /** Optional session ID */
  session_id?: string;
}

/**
 * Aggregated token usage across all sessions in a run
 */
export interface AggregatedTokenUsage {
  /** Total input tokens */
  inputTokens: number;
  /** Total output tokens */
  outputTokens: number;
  /** Total cache tokens (creation + read) */
  cacheTokens: number;
  /** Grand total tokens (input + output) */
  tokensUsed: number;
}

/**
 * Default directory for token usage files
 */
export const TOKEN_USAGE_DIR = ".sequant";

/**
 * Token usage file pattern
 */
export const TOKEN_FILE_PATTERN = /^\.token-usage-.*\.json$/;

/**
 * Check if a filename matches the token usage file pattern
 */
export function isTokenUsageFile(filename: string): boolean {
  return TOKEN_FILE_PATTERN.test(filename);
}

/**
 * Extract session ID from a token usage filename
 *
 * @param filename - The token file name (e.g., ".token-usage-abc123.json")
 * @returns The session ID portion, or undefined if not parseable
 */
export function extractSessionId(filename: string): string | undefined {
  const match = filename.match(/^\.token-usage-(.+)\.json$/);
  return match?.[1];
}

/**
 * Parse a single token usage JSON file
 *
 * @param filePath - Absolute path to the token file
 * @returns Parsed TokenUsageData or null if invalid
 */
export function parseTokenJsonFile(filePath: string): TokenUsageData | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.trim()) {
      return null;
    }

    const data = JSON.parse(content);

    // Validate it's an object
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return null;
    }

    // Extract fields with validation
    const inputTokens =
      typeof data.input_tokens === "number" ? data.input_tokens : 0;
    const outputTokens =
      typeof data.output_tokens === "number" ? data.output_tokens : 0;
    const cacheCreationTokens =
      typeof data.cache_creation_tokens === "number"
        ? data.cache_creation_tokens
        : 0;
    const cacheReadTokens =
      typeof data.cache_read_tokens === "number" ? data.cache_read_tokens : 0;

    // Treat negative values as 0
    return {
      input_tokens: Math.max(0, inputTokens),
      output_tokens: Math.max(0, outputTokens),
      cache_creation_tokens: Math.max(0, cacheCreationTokens),
      cache_read_tokens: Math.max(0, cacheReadTokens),
      timestamp:
        typeof data.timestamp === "string" ? data.timestamp : undefined,
      session_id:
        typeof data.session_id === "string" ? data.session_id : undefined,
    };
  } catch {
    // JSON parse error, file not found, permission denied, etc.
    return null;
  }
}

/**
 * Read all token usage files from a directory
 *
 * @param directory - Path to directory containing token files (default: .sequant)
 * @returns Array of parsed token usage data
 */
export function readTokenUsageFiles(
  directory: string = TOKEN_USAGE_DIR,
): TokenUsageData[] {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const results: TokenUsageData[] = [];

  try {
    const files = fs.readdirSync(directory);

    for (const filename of files) {
      if (!isTokenUsageFile(filename)) {
        continue;
      }

      const filePath = path.join(directory, filename);
      const data = parseTokenJsonFile(filePath);
      if (data) {
        results.push(data);
      }
    }
  } catch {
    // Directory read error - return empty array
    return [];
  }

  return results;
}

/**
 * Aggregate token usage from multiple session files
 *
 * @param tokenData - Array of token usage data from readTokenUsageFiles
 * @returns Aggregated totals
 */
export function aggregateTokenUsage(
  tokenData: TokenUsageData[],
): AggregatedTokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheTokens = 0;

  for (const data of tokenData) {
    inputTokens += data.input_tokens;
    outputTokens += data.output_tokens;
    cacheTokens +=
      (data.cache_creation_tokens ?? 0) + (data.cache_read_tokens ?? 0);
  }

  return {
    inputTokens,
    outputTokens,
    cacheTokens,
    tokensUsed: inputTokens + outputTokens,
  };
}

/**
 * Read and aggregate all token usage for a run, then cleanup
 *
 * This is the main entry point for run.ts to get token metrics.
 *
 * @param directory - Path to directory containing token files (default: .sequant)
 * @param cleanup - Whether to delete token files after reading (default: true)
 * @returns Aggregated token usage
 */
export function getTokenUsageForRun(
  directory: string = TOKEN_USAGE_DIR,
  cleanup: boolean = true,
): AggregatedTokenUsage {
  const tokenData = readTokenUsageFiles(directory);
  const aggregated = aggregateTokenUsage(tokenData);

  // Clean up token files after reading
  if (cleanup && tokenData.length > 0) {
    cleanupTokenFiles(directory);
  }

  return aggregated;
}

/**
 * Delete all token usage files from a directory
 *
 * @param directory - Path to directory containing token files
 */
export function cleanupTokenFiles(directory: string = TOKEN_USAGE_DIR): void {
  if (!fs.existsSync(directory)) {
    return;
  }

  try {
    const files = fs.readdirSync(directory);

    for (const filename of files) {
      if (!isTokenUsageFile(filename)) {
        continue;
      }

      const filePath = path.join(directory, filename);
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore individual file deletion errors
      }
    }
  } catch {
    // Directory read error - ignore
  }
}
