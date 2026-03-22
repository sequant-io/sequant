/**
 * Platform provider registry.
 *
 * Simple map-based registry — not a plugin system.
 * New providers are registered by adding entries to PLATFORMS.
 */

import type { PlatformProvider } from "./platform-provider.js";
import { GitHubProvider } from "./github.js";

export type {
  PlatformProvider,
  Issue,
  CreatePROptions,
  PRInfo,
  PRStatus,
  Comment,
} from "./platform-provider.js";

export { GitHubProvider } from "./github.js";
export type {
  PRMergeStatus,
  ClosedIssueRaw,
  CreatePRCliResult,
} from "./github.js";

const PLATFORMS: Record<string, () => PlatformProvider> = {
  github: () => new GitHubProvider(),
};

/**
 * Get a platform provider by name.
 *
 * @param name - Provider name (default: "github")
 * @throws Error if provider name is unknown
 */
export function getPlatform(name: string = "github"): PlatformProvider {
  const factory = PLATFORMS[name];
  if (!factory) {
    const available = Object.keys(PLATFORMS).join(", ");
    throw new Error(
      `Unknown platform provider "${name}". Available providers: ${available}`,
    );
  }
  return factory();
}
