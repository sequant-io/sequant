/**
 * Plugin version sync utilities
 *
 * Ensures plugin.json and marketplace.json versions stay in sync with package.json version.
 * Used by CI validation and /release skill.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface VersionSyncResult {
  inSync: boolean;
  packageVersion: string | null;
  pluginVersion: string | null;
  marketplaceVersion?: string | null;
  error?: string;
}

/**
 * Check if package.json and plugin.json versions are in sync
 *
 * @param projectRoot - Root directory of the project
 * @returns Sync status with version details
 */
export function checkVersionSync(
  projectRoot: string = process.cwd(),
): VersionSyncResult {
  const packageJsonPath = join(projectRoot, "package.json");
  const pluginJsonPath = join(projectRoot, ".claude-plugin", "plugin.json");

  // Check package.json exists
  if (!existsSync(packageJsonPath)) {
    return {
      inSync: false,
      packageVersion: null,
      pluginVersion: null,
      error: "package.json not found",
    };
  }

  // Check plugin.json exists
  if (!existsSync(pluginJsonPath)) {
    return {
      inSync: false,
      packageVersion: null,
      pluginVersion: null,
      error: "plugin.json not found",
    };
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, "utf8"));

    const packageVersion = packageJson.version || null;
    const pluginVersion = pluginJson.version || null;

    if (!packageVersion) {
      return {
        inSync: false,
        packageVersion: null,
        pluginVersion,
        error: "package.json missing version field",
      };
    }

    if (!pluginVersion) {
      return {
        inSync: false,
        packageVersion,
        pluginVersion: null,
        error: "plugin.json missing version field",
      };
    }

    // Also check marketplace.json if it exists
    const marketplaceJsonPath = join(
      projectRoot,
      ".claude-plugin",
      "marketplace.json",
    );
    let marketplaceVersion: string | null = null;
    if (existsSync(marketplaceJsonPath)) {
      const marketplaceJson = JSON.parse(
        readFileSync(marketplaceJsonPath, "utf8"),
      );
      marketplaceVersion = marketplaceJson.plugins?.[0]?.version || null;

      if (marketplaceVersion && marketplaceVersion !== packageVersion) {
        return {
          inSync: false,
          packageVersion,
          pluginVersion,
          marketplaceVersion,
          error: `marketplace.json plugins[0].version (${marketplaceVersion}) does not match package.json (${packageVersion})`,
        };
      }
    }

    return {
      inSync: packageVersion === pluginVersion,
      packageVersion,
      pluginVersion,
      marketplaceVersion,
    };
  } catch (e) {
    return {
      inSync: false,
      packageVersion: null,
      pluginVersion: null,
      error: `Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Get a helpful error message for version mismatch
 *
 * @param result - Version sync result
 * @returns Human-readable error message with fix command
 */
export function getVersionMismatchMessage(result: VersionSyncResult): string {
  if (result.inSync) {
    return `✓ Versions are in sync: ${result.packageVersion}`;
  }

  if (result.error) {
    return `✗ Version sync check failed: ${result.error}`;
  }

  const lines = [
    `✗ Version mismatch!`,
    `  package.json:      ${result.packageVersion}`,
    `  plugin.json:       ${result.pluginVersion}`,
  ];

  if (result.marketplaceVersion) {
    lines.push(`  marketplace.json:  ${result.marketplaceVersion}`);
  }

  lines.push(
    ``,
    `Run ./scripts/release.sh <version> to sync all version files.`,
  );

  return lines.join("\n");
}
