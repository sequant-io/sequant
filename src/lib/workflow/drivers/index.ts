/**
 * Agent driver registry.
 *
 * Simple map-based registry — not a plugin system.
 * New drivers are registered by adding entries to DRIVERS.
 */

import type { AgentDriver } from "./agent-driver.js";
import { ClaudeCodeDriver } from "./claude-code.js";

export type {
  AgentDriver,
  AgentExecutionConfig,
  AgentPhaseResult,
} from "./agent-driver.js";

const DRIVERS: Record<string, () => AgentDriver> = {
  "claude-code": () => new ClaudeCodeDriver(),
};

/**
 * Get an agent driver by name.
 *
 * @param name - Driver name (default: "claude-code")
 * @throws Error if driver name is unknown
 */
export function getDriver(name: string = "claude-code"): AgentDriver {
  const factory = DRIVERS[name];
  if (!factory) {
    const available = Object.keys(DRIVERS).join(", ");
    throw new Error(
      `Unknown agent driver "${name}". Available drivers: ${available}`,
    );
  }
  return factory();
}
