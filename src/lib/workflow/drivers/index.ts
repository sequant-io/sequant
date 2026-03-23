/**
 * Agent driver registry.
 *
 * Simple map-based registry — not a plugin system.
 * New drivers are registered by adding entries to DRIVERS.
 */

import type { AgentDriver } from "./agent-driver.js";
import type { AiderSettings } from "../../settings.js";
import { ClaudeCodeDriver } from "./claude-code.js";
import { AiderDriver } from "./aider.js";

export type {
  AgentDriver,
  AgentExecutionConfig,
  AgentPhaseResult,
} from "./agent-driver.js";

const DRIVERS: Record<string, (opts?: DriverOptions) => AgentDriver> = {
  "claude-code": () => new ClaudeCodeDriver(),
  aider: (opts) => new AiderDriver(opts?.aiderSettings),
};

export interface DriverOptions {
  aiderSettings?: AiderSettings;
}

/**
 * Get an agent driver by name.
 *
 * @param name - Driver name (default: "claude-code")
 * @param options - Optional driver-specific settings
 * @throws Error if driver name is unknown
 */
export function getDriver(
  name: string = "claude-code",
  options?: DriverOptions,
): AgentDriver {
  const factory = DRIVERS[name];
  if (!factory) {
    const available = Object.keys(DRIVERS).join(", ");
    throw new Error(
      `Unknown agent driver "${name}". Available drivers: ${available}`,
    );
  }
  return factory(options);
}
