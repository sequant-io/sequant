/**
 * Version freshness checks for sequant
 *
 * Provides utilities to check if the current version is up to date
 * with the latest version on npm.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PACKAGE_NAME = "sequant";
const NPM_REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const VERSION_CHECK_TIMEOUT = 3000; // 3 seconds
const CACHE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface VersionCache {
  latestVersion: string;
  checkedAt: string;
}

export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  isOutdated: boolean;
  isLocalInstall?: boolean;
  error?: string;
}

/**
 * Get the global cache directory path
 */
export function getCacheDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".cache", "sequant");
}

/**
 * Get the version cache file path
 */
export function getCachePath(): string {
  return path.join(getCacheDir(), "version-check.json");
}

/**
 * Get the current version from package.json
 */
export function getCurrentVersion(): string {
  try {
    // Walk up from current directory until we find sequant's package.json
    // Works from both source (src/lib/) and compiled (dist/src/lib/) locations
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
      const candidate = path.resolve(dir, "package.json");
      try {
        const content = fs.readFileSync(candidate, "utf8");
        const pkg = JSON.parse(content);
        if (pkg.name === "sequant") {
          return pkg.version || "0.0.0";
        }
      } catch {
        // Not found, continue searching
      }
      dir = path.dirname(dir);
    }
    return "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Check if running from a local node_modules install (vs npx cache)
 *
 * Local installs are in: <project>/node_modules/sequant/
 * npx installs are in: ~/.npm/_npx/<hash>/node_modules/sequant/
 *
 * This matters because:
 * - Local installs should be updated with: npm update sequant
 * - npx installs should be updated with: npx sequant@latest
 */
export function isLocalNodeModulesInstall(): boolean {
  // Check if our path contains node_modules/sequant but NOT in .npm/_npx
  const normalizedPath = __dirname.replace(/\\/g, "/");

  // Running from local node_modules (not npx cache)
  const inNodeModules = normalizedPath.includes("/node_modules/sequant");
  const inNpxCache =
    normalizedPath.includes("/.npm/_npx/") ||
    normalizedPath.includes("\\.npm\\_npx\\");

  return inNodeModules && !inNpxCache;
}

/**
 * Read the version cache
 */
export function readCache(): VersionCache | null {
  try {
    const cachePath = getCachePath();
    if (!fs.existsSync(cachePath)) {
      return null;
    }
    const content = fs.readFileSync(cachePath, "utf8");
    return JSON.parse(content) as VersionCache;
  } catch {
    return null;
  }
}

/**
 * Write to the version cache
 */
export function writeCache(latestVersion: string): void {
  try {
    const cacheDir = getCacheDir();
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    const cache: VersionCache = {
      latestVersion,
      checkedAt: new Date().toISOString(),
    };
    fs.writeFileSync(getCachePath(), JSON.stringify(cache, null, 2));
  } catch {
    // Silent failure - caching is optional
  }
}

/**
 * Check if the cache is still fresh (within 24 hours)
 */
export function isCacheFresh(cache: VersionCache): boolean {
  try {
    const checkedAt = new Date(cache.checkedAt).getTime();
    const now = Date.now();
    return now - checkedAt < CACHE_EXPIRY_MS;
  } catch {
    return false;
  }
}

/**
 * Fetch the latest version from npm registry with timeout
 */
export async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT);

  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { version?: string };
    return data.version || null;
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

/**
 * Compare two semantic versions
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a: string, b: string): number {
  const parseVersion = (v: string): number[] => {
    return v
      .replace(/^v/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  };

  const aParts = parseVersion(a);
  const bParts = parseVersion(b);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal < bVal) return -1;
    if (aVal > bVal) return 1;
  }

  return 0;
}

/**
 * Check if the current version is outdated
 */
export function isOutdated(
  currentVersion: string,
  latestVersion: string,
): boolean {
  return compareVersions(currentVersion, latestVersion) < 0;
}

/**
 * Get the version warning message
 *
 * For local node_modules installs, recommends `npm update sequant`
 * For npx usage, recommends `npx sequant@latest`
 */
export function getVersionWarning(
  currentVersion: string,
  latestVersion: string,
  isLocal?: boolean,
): string {
  const isLocalInstall = isLocal ?? isLocalNodeModulesInstall();

  if (isLocalInstall) {
    return `sequant ${latestVersion} is available (you have ${currentVersion})
   Run: npm update sequant
   Note: You have sequant as a local dependency. npx uses your node_modules version.`;
  }

  return `sequant ${latestVersion} is available (you have ${currentVersion})
   Run: npx sequant@latest`;
}

/**
 * Check version freshness (thorough - for doctor command)
 * Always fetches from npm registry
 */
export async function checkVersionThorough(): Promise<VersionCheckResult> {
  const currentVersion = getCurrentVersion();
  const isLocal = isLocalNodeModulesInstall();

  const latestVersion = await fetchLatestVersion();

  if (!latestVersion) {
    return {
      currentVersion,
      latestVersion: null,
      isOutdated: false,
      isLocalInstall: isLocal,
      error: "Could not fetch latest version",
    };
  }

  // Update cache with fresh data
  writeCache(latestVersion);

  return {
    currentVersion,
    latestVersion,
    isOutdated: isOutdated(currentVersion, latestVersion),
    isLocalInstall: isLocal,
  };
}

/**
 * Check version freshness (cached - for run command)
 * Uses cache if available and fresh, otherwise fetches (non-blocking)
 */
export async function checkVersionCached(): Promise<VersionCheckResult> {
  const currentVersion = getCurrentVersion();
  const isLocal = isLocalNodeModulesInstall();

  // Check cache first
  const cache = readCache();
  if (cache && isCacheFresh(cache)) {
    return {
      currentVersion,
      latestVersion: cache.latestVersion,
      isOutdated: isOutdated(currentVersion, cache.latestVersion),
      isLocalInstall: isLocal,
    };
  }

  // Fetch new version (with timeout)
  const latestVersion = await fetchLatestVersion();

  if (!latestVersion) {
    // Use stale cache if available, otherwise silent failure
    if (cache) {
      return {
        currentVersion,
        latestVersion: cache.latestVersion,
        isOutdated: isOutdated(currentVersion, cache.latestVersion),
        isLocalInstall: isLocal,
      };
    }
    return {
      currentVersion,
      latestVersion: null,
      isOutdated: false,
      isLocalInstall: isLocal,
    };
  }

  // Update cache
  writeCache(latestVersion);

  return {
    currentVersion,
    latestVersion,
    isOutdated: isOutdated(currentVersion, latestVersion),
    isLocalInstall: isLocal,
  };
}
