/**
 * Tests for `run.fullQa` (#982): the setting → `buildExecutionConfig` →
 * phase-executor env wiring that lets `sequant run` force full-weight QA
 * the same way `sequant ready` already does unconditionally.
 *
 * - AC-2: `run.fullQa: true` in settings reaches `SEQUANT_FULL_QA=1` in the
 *   qa phase agent env via the real `buildExecutionConfig` resolver (no
 *   mocks on the resolver itself — only the driver boundary is mocked).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../agents-md.js", () => ({
  readAgentsMd: vi.fn().mockResolvedValue(null),
}));
vi.mock("./drivers/index.js", () => ({
  getDriver: vi.fn(),
}));

import { executePhaseWithRetry } from "./phase-executor.js";
import { getDriver } from "./drivers/index.js";
import type { AgentDriver } from "./drivers/agent-driver.js";
import { buildExecutionConfig, resolveRunOptions } from "./config-resolver.js";
import { DEFAULT_SETTINGS, validateSettings } from "../settings.js";
import type { SequantSettings } from "../settings.js";
import type { RunOptions } from "./types.js";

function settingsWith(run: Partial<SequantSettings["run"]>): SequantSettings {
  return {
    ...DEFAULT_SETTINGS,
    run: { ...DEFAULT_SETTINGS.run, ...run },
  } as SequantSettings;
}

function mockDriver(): AgentDriver {
  return {
    name: "claude-code",
    resolvesSkills: false,
    executePhase: vi.fn().mockResolvedValue({ success: true, output: "ok" }),
    isAvailable: vi.fn().mockResolvedValue(true),
    canResume: vi.fn().mockReturnValue(false),
  };
}

beforeEach(() => {
  vi.mocked(getDriver).mockReset();
  vi.mocked(getDriver).mockReturnValue(mockDriver());
});

describe("run.fullQa (#982)", () => {
  it("run.fullQa is a registered settings key — validateSettings emits no 'Unknown key' warning for it", () => {
    // QA finding on #982: the key resolved correctly but KNOWN_KEYS.run did
    // not list it, so every documented `run.fullQa: true` produced a false
    // "Unknown key 'run.fullQa' in settings.json (ignored)" warning.
    const { warnings } = validateSettings({
      version: "1.0",
      run: { fullQa: true },
    });
    expect(warnings.filter((w) => w.path.includes("fullQa"))).toEqual([]);
  });

  it("AC-2: run.fullQa: true reaches SEQUANT_FULL_QA=1 in the qa phase agent env", async () => {
    const settings = settingsWith({ fullQa: true });
    // Real resolver — this is what makes the test cover the wiring, not just
    // the env-building line in isolation.
    const config = buildExecutionConfig(
      resolveRunOptions({} as RunOptions, settings),
      settings,
      1,
    );
    expect(config.fullQa).toBe(true);

    await executePhaseWithRetry(982, "qa", config);

    const driver = vi.mocked(getDriver).mock.results[0]?.value as AgentDriver;
    const executePhaseMock = vi.mocked(driver.executePhase);
    expect(executePhaseMock).toHaveBeenCalled();
    const agentConfig = executePhaseMock.mock.calls[0]?.[1];
    expect(agentConfig?.env.SEQUANT_FULL_QA).toBe("1");
  });

  it("AC-4: run.fullQa unset (default false) leaves SEQUANT_FULL_QA absent from the qa env", async () => {
    const settings = settingsWith({});
    const config = buildExecutionConfig(
      resolveRunOptions({} as RunOptions, settings),
      settings,
      1,
    );
    expect(config.fullQa).toBe(false);

    await executePhaseWithRetry(982, "qa", config);

    const driver = vi.mocked(getDriver).mock.results[0]?.value as AgentDriver;
    const executePhaseMock = vi.mocked(driver.executePhase);
    const agentConfig = executePhaseMock.mock.calls[0]?.[1];
    expect(agentConfig?.env.SEQUANT_FULL_QA).toBeUndefined();
  });

  it("AC-3: the CLI's fullQa option (mirroring --full-qa) beats settings.run.fullQa", async () => {
    const settings = settingsWith({ fullQa: false });
    const config = buildExecutionConfig(
      resolveRunOptions({ fullQa: true } as RunOptions, settings),
      settings,
      1,
    );
    expect(config.fullQa).toBe(true);
  });
});
