/**
 * Agent driver registry.
 *
 * Simple map-based registry — not a plugin system.
 * New drivers are registered by adding entries to DRIVERS.
 */

import type { AgentDriver } from "./agent-driver.js";
import type {
  AiderSettings,
  CodexSettings,
  OpencodeSettings,
} from "../../settings.js";
import { ClaudeCodeDriver } from "./claude-code.js";
import { AiderDriver } from "./aider.js";
import { OpencodeDriver } from "./opencode.js";
import { CodexDriver } from "./codex.js";

export type {
  AgentDriver,
  AgentExecutionConfig,
  AgentPhaseResult,
  ModelUsageEntry,
  ResumeHandle,
} from "./agent-driver.js";

const DRIVERS: Record<string, (opts?: DriverOptions) => AgentDriver> = {
  "claude-code": () => new ClaudeCodeDriver(),
  aider: (opts) => new AiderDriver(opts?.aiderSettings),
  opencode: (opts) => new OpencodeDriver(opts?.opencodeSettings),
  codex: (opts) => new CodexDriver(opts?.codexSettings),
};

export interface DriverOptions {
  aiderSettings?: AiderSettings;
  opencodeSettings?: OpencodeSettings;
  codexSettings?: CodexSettings;
}

/**
 * Every registered driver name (#1096).
 *
 * `DRIVERS` stays module-private and stays the single enumeration source: the
 * conformance suite builds its `describe.each` from this, so adding a driver
 * to the map without adding a conformance adapter fails the suite. Reading the
 * names out of `getDriver`'s "Available drivers: …" error string would work
 * too, and is rejected — it couples the suite to a message format.
 */
export function listDriverNames(): string[] {
  return Object.keys(DRIVERS);
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
