/**
 * #936 (gap fix) — `settings.run.mcpAllowlist` must reach `ExecutionConfig`
 * unchanged, mirroring how `buildExecutionConfig` already threads `mcp`.
 */

import { describe, it, expect } from "vitest";
import { buildExecutionConfig, resolveRunOptions } from "./config-resolver.js";
import type { RunOptions } from "./types.js";
import { DEFAULT_SETTINGS } from "../settings.js";
import type { SequantSettings } from "../settings.js";

function settingsWith(run: Partial<SequantSettings["run"]>): SequantSettings {
  return {
    ...DEFAULT_SETTINGS,
    run: { ...DEFAULT_SETTINGS.run, ...run },
  } as SequantSettings;
}

function resolveWithSettings(run: Partial<SequantSettings["run"]>) {
  const custom = settingsWith(run);
  return buildExecutionConfig(
    resolveRunOptions({} as RunOptions, custom),
    custom,
    1,
  );
}

describe("buildExecutionConfig — mcpAllowlist (#936)", () => {
  it("carries settings.run.mcpAllowlist onto ExecutionConfig unchanged", () => {
    const config = resolveWithSettings({ mcpAllowlist: ["stripe", "notion"] });
    expect(config.mcpAllowlist).toEqual(["stripe", "notion"]);
  });

  it("leaves mcpAllowlist undefined when settings don't configure it", () => {
    const config = resolveWithSettings({});
    expect(config.mcpAllowlist).toBeUndefined();
  });
});
