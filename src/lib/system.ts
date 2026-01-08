/**
 * System utility functions for checking prerequisites
 */

import { execSync } from "child_process";

/**
 * Check if a command exists on the system
 */
export function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if gh CLI is authenticated
 */
export function isGhAuthenticated(): boolean {
  try {
    execSync("gh auth status", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get platform-specific install hint for a package
 */
export function getInstallHint(pkg: string): string {
  const platform = process.platform;

  const hints: Record<string, Record<string, string>> = {
    jq: {
      darwin: "brew install jq",
      linux: "apt install jq  # or: yum install jq",
      win32: "choco install jq  # or: scoop install jq",
    },
    gh: {
      darwin: "brew install gh",
      linux: "apt install gh  # see: https://cli.github.com",
      win32: "choco install gh  # or: winget install GitHub.cli",
    },
  };

  const pkgHints = hints[pkg];
  if (!pkgHints) {
    return `Install ${pkg}`;
  }

  return pkgHints[platform] || pkgHints["linux"] || `Install ${pkg}`;
}
