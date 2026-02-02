/**
 * QA Cache Module - Caches expensive QA check results to skip unchanged checks on re-run
 *
 * Provides caching for type safety, security, and test checks keyed by:
 * - File content hash (git diff hash)
 * - Check type
 * - Configuration hash
 *
 * @example
 * ```typescript
 * import { QACache } from './qa-cache';
 *
 * const cache = new QACache();
 *
 * // Check cache before running expensive check
 * const cached = await cache.get('security');
 * if (cached && !cached.isStale) {
 *   console.log('Using cached security scan results');
 *   return cached.result;
 * }
 *
 * // Run check and cache result
 * const result = await runSecurityScan();
 * await cache.set('security', result);
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { z } from "zod";

/**
 * Check types that can be cached
 */
export const CHECK_TYPES = [
  "type-safety",
  "deleted-tests",
  "scope",
  "size",
  "security",
  "semgrep",
  "build",
  "tests",
] as const;

export type CheckType = (typeof CHECK_TYPES)[number];

/**
 * Schema for a single cached check result
 */
export const CachedCheckResultSchema = z.object({
  /** Type of check */
  checkType: z.enum(CHECK_TYPES),
  /** Git diff hash when check was run */
  diffHash: z.string(),
  /** Config hash when check was run */
  configHash: z.string(),
  /** Timestamp when cached */
  cachedAt: z.string().datetime(),
  /** Time-to-live in milliseconds */
  ttl: z.number().positive(),
  /** The actual check result */
  result: z.object({
    /** Whether the check passed */
    passed: z.boolean(),
    /** Summary message */
    message: z.string(),
    /** Optional details (counts, warnings, etc.) */
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type CachedCheckResult = z.infer<typeof CachedCheckResultSchema>;

/**
 * Schema for the complete cache file
 */
export const QACacheSchema = z.object({
  /** Cache version for backwards compatibility */
  version: z.literal(1),
  /** When the cache was last updated */
  lastUpdated: z.string().datetime(),
  /** Cached check results keyed by check type */
  checks: z.record(z.string(), CachedCheckResultSchema),
});

export type QACacheState = z.infer<typeof QACacheSchema>;

/**
 * Cache configuration options
 */
export interface QACacheOptions {
  /** Path to cache directory (default: .sequant/.cache/qa/) */
  cacheDir?: string;
  /** Default TTL in milliseconds (default: 1 hour) */
  defaultTtl?: number;
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * Result of cache lookup
 */
export interface CacheLookupResult {
  /** Whether cache hit occurred */
  hit: boolean;
  /** Whether cached result is stale (expired TTL) */
  isStale: boolean;
  /** The cached result (if hit) */
  result?: CachedCheckResult["result"];
  /** Reason for cache miss */
  missReason?: "not-found" | "hash-mismatch" | "expired" | "corrupted";
}

/**
 * Default TTL: 1 hour
 */
const DEFAULT_TTL = 60 * 60 * 1000;

/**
 * Default cache directory
 */
const DEFAULT_CACHE_DIR = ".sequant/.cache/qa";

/**
 * Files that invalidate all caches when changed
 */
const GLOBAL_INVALIDATION_FILES = [
  "package-lock.json",
  "package.json",
  "tsconfig.json",
  ".sequant/settings.json",
];

/**
 * Per-check invalidation file patterns
 */
const CHECK_INVALIDATION_PATTERNS: Record<CheckType, RegExp[]> = {
  "type-safety": [/tsconfig.*\.json$/, /\.ts$/, /\.tsx$/],
  "deleted-tests": [/\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/],
  scope: [], // Uses git diff hash
  size: [], // Uses git diff hash
  security: [/\.ts$/, /\.tsx$/, /\.js$/, /\.jsx$/],
  semgrep: [/\.ts$/, /\.tsx$/, /\.js$/, /\.jsx$/, /semgrep.*\.ya?ml$/],
  build: [/\.ts$/, /\.tsx$/, /\.js$/, /\.jsx$/, /tsconfig.*\.json$/],
  tests: [/\.test\.[jt]sx?$/, /\.spec\.[jt]sx?$/, /jest\.config/],
};

/**
 * QA Cache Manager
 *
 * Manages caching of expensive QA check results to improve re-run performance.
 */
export class QACache {
  private cacheDir: string;
  private defaultTtl: number;
  private verbose: boolean;
  private cachedState: QACacheState | null = null;

  constructor(options: QACacheOptions = {}) {
    this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.defaultTtl = options.defaultTtl ?? DEFAULT_TTL;
    this.verbose = options.verbose ?? false;
  }

  /**
   * Get the cache file path
   */
  getCachePath(): string {
    return path.join(this.cacheDir, "cache.json");
  }

  /**
   * Compute hash of git diff between main and HEAD
   *
   * This provides a content-based cache key that changes when code changes.
   */
  computeDiffHash(): string {
    try {
      // Get the diff content between main and HEAD
      const diff = execSync("git diff main...HEAD", {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      // Hash the diff content
      return crypto
        .createHash("sha256")
        .update(diff)
        .digest("hex")
        .slice(0, 16);
    } catch {
      // If git command fails, return a unique hash to force fresh run
      this.log("Failed to compute diff hash, using timestamp fallback");
      return crypto
        .createHash("sha256")
        .update(Date.now().toString())
        .digest("hex")
        .slice(0, 16);
    }
  }

  /**
   * Compute hash of configuration files that affect checks
   */
  computeConfigHash(checkType: CheckType): string {
    const files = this.getConfigFilesForCheck(checkType);
    const contents: string[] = [];

    for (const file of files) {
      if (fs.existsSync(file)) {
        try {
          contents.push(fs.readFileSync(file, "utf-8"));
        } catch {
          // Ignore read errors
        }
      }
    }

    return crypto
      .createHash("sha256")
      .update(contents.join("\n"))
      .digest("hex")
      .slice(0, 16);
  }

  /**
   * Get configuration files that affect a specific check type
   */
  private getConfigFilesForCheck(checkType: CheckType): string[] {
    const baseFiles = ["tsconfig.json", "package.json"];

    switch (checkType) {
      case "type-safety":
      case "build":
        return [...baseFiles, "tsconfig.build.json"];
      case "semgrep":
        return [
          ...baseFiles,
          ".semgrep.yml",
          ".semgrepignore",
          "semgrep.config.yaml",
        ];
      case "tests":
        return [
          ...baseFiles,
          "jest.config.js",
          "jest.config.ts",
          "vitest.config.ts",
        ];
      case "security":
        return baseFiles;
      default:
        return baseFiles;
    }
  }

  /**
   * Check if global invalidation files have changed
   */
  async checkGlobalInvalidation(): Promise<boolean> {
    try {
      const changedFiles = execSync("git diff main...HEAD --name-only", {
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);

      for (const file of changedFiles) {
        if (GLOBAL_INVALIDATION_FILES.includes(file)) {
          this.log(`Global invalidation triggered by: ${file}`);
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if files matching check-specific patterns have changed
   */
  async checkTypeSpecificInvalidation(checkType: CheckType): Promise<boolean> {
    const patterns = CHECK_INVALIDATION_PATTERNS[checkType];
    if (patterns.length === 0) {
      return false;
    }

    try {
      const changedFiles = execSync("git diff main...HEAD --name-only", {
        encoding: "utf-8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);

      for (const file of changedFiles) {
        for (const pattern of patterns) {
          if (pattern.test(file)) {
            this.log(`Check ${checkType} invalidated by: ${file}`);
            return true;
          }
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Read the current cache state
   */
  async getState(): Promise<QACacheState> {
    if (this.cachedState) {
      return this.cachedState;
    }

    const cachePath = this.getCachePath();

    if (!fs.existsSync(cachePath)) {
      const emptyState = this.createEmptyState();
      this.cachedState = emptyState;
      return emptyState;
    }

    try {
      const content = fs.readFileSync(cachePath, "utf-8");
      const parsed = JSON.parse(content);
      const state = QACacheSchema.parse(parsed);
      this.cachedState = state;
      return state;
    } catch {
      // Graceful degradation: corrupted cache -> fresh state (AC-6)
      this.log("Cache corrupted or invalid, creating fresh cache");
      const emptyState = this.createEmptyState();
      this.cachedState = emptyState;
      return emptyState;
    }
  }

  /**
   * Write cache state to disk
   */
  async saveState(state: QACacheState): Promise<void> {
    QACacheSchema.parse(state);

    state.lastUpdated = new Date().toISOString();

    // Ensure cache directory exists
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    const cachePath = this.getCachePath();

    // Write atomically using temp file
    const tempPath = `${cachePath}.tmp.${process.pid}`;

    try {
      fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
      fs.renameSync(tempPath, cachePath);
      this.cachedState = state;
      this.log(`Cache saved: ${cachePath}`);
    } catch (error) {
      // Clean up temp file on error
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw error;
    }
  }

  /**
   * Get cached result for a check type
   */
  async get(checkType: CheckType): Promise<CacheLookupResult> {
    const state = await this.getState();
    const cached = state.checks[checkType];

    if (!cached) {
      return { hit: false, isStale: false, missReason: "not-found" };
    }

    // Check if TTL has expired
    const cachedTime = new Date(cached.cachedAt).getTime();
    const now = Date.now();
    if (now - cachedTime > cached.ttl) {
      return { hit: false, isStale: true, missReason: "expired" };
    }

    // Check if diff hash matches
    const currentDiffHash = this.computeDiffHash();
    if (cached.diffHash !== currentDiffHash) {
      return { hit: false, isStale: false, missReason: "hash-mismatch" };
    }

    // Check if config hash matches
    const currentConfigHash = this.computeConfigHash(checkType);
    if (cached.configHash !== currentConfigHash) {
      return { hit: false, isStale: false, missReason: "hash-mismatch" };
    }

    return {
      hit: true,
      isStale: false,
      result: cached.result,
    };
  }

  /**
   * Cache a check result
   */
  async set(
    checkType: CheckType,
    result: CachedCheckResult["result"],
    ttl?: number,
  ): Promise<void> {
    const state = await this.getState();

    const cachedResult: CachedCheckResult = {
      checkType,
      diffHash: this.computeDiffHash(),
      configHash: this.computeConfigHash(checkType),
      cachedAt: new Date().toISOString(),
      ttl: ttl ?? this.defaultTtl,
      result,
    };

    state.checks[checkType] = cachedResult;

    await this.saveState(state);
    this.log(`Cached ${checkType} result`);
  }

  /**
   * Clear cache for a specific check type
   */
  async clear(checkType: CheckType): Promise<void> {
    const state = await this.getState();
    delete state.checks[checkType];
    await this.saveState(state);
    this.log(`Cleared cache for ${checkType}`);
  }

  /**
   * Clear all cached results
   */
  async clearAll(): Promise<void> {
    const emptyState = this.createEmptyState();
    await this.saveState(emptyState);
    this.log("Cleared all cache");
  }

  /**
   * Get cache status for all check types
   */
  async getStatus(): Promise<
    Record<CheckType, { hit: boolean; missReason?: string }>
  > {
    const status: Record<string, { hit: boolean; missReason?: string }> = {};

    for (const checkType of CHECK_TYPES) {
      const result = await this.get(checkType);
      status[checkType] = {
        hit: result.hit,
        missReason: result.missReason,
      };
    }

    return status as Record<CheckType, { hit: boolean; missReason?: string }>;
  }

  /**
   * Create an empty cache state
   */
  private createEmptyState(): QACacheState {
    return {
      version: 1,
      lastUpdated: new Date().toISOString(),
      checks: {},
    };
  }

  /**
   * Log a message if verbose mode is enabled
   */
  private log(message: string): void {
    if (this.verbose) {
      console.log(`[qa-cache] ${message}`);
    }
  }

  /**
   * Clear the in-memory cache (forces re-read on next access)
   */
  clearMemoryCache(): void {
    this.cachedState = null;
  }
}

/**
 * Default cache instance
 */
let defaultCache: QACache | null = null;

/**
 * Get the default QA cache instance
 */
export function getQACache(options?: QACacheOptions): QACache {
  if (!defaultCache || options) {
    defaultCache = new QACache(options);
  }
  return defaultCache;
}

/**
 * Reset the default cache instance (for testing)
 */
export function resetQACache(): void {
  defaultCache = null;
}
