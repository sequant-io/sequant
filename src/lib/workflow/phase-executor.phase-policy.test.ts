/**
 * Gap-fix test for #914 — the connective wiring inside `executePhase`
 * (unexported) that reads `config.phasePolicies?.[phase]` and turns it into
 * `AgentExecutionConfig.model`/`.effort`. Every other hop of this feature is
 * independently tested (both `ExecutionConfig` producers build
 * `phasePolicies` correctly; `ClaudeCodeDriver` forwards
 * `AgentExecutionConfig.model`/`.effort` into `query()` options correctly),
 * but nothing previously drove the real `executePhase` body end-to-end, so a
 * regression in this specific line would have gone uncaught.
 *
 * `executePhase` has no export, so this drives it through the public
 * `executePhaseWithRetry` entry point without passing the 8th
 * (`executePhaseFn`) argument — letting it fall through to the real internal
 * `executePhase`, per the "test via public API" pattern already used
 * elsewhere in this file. `getDriver` is mocked so no real agent/git/worktree
 * work happens; the mock driver's `executePhase` call is what's asserted on.
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
import type { ExecutionConfig } from "./types.js";
import type {
  AgentExecutionConfig,
  AgentDriver,
} from "./drivers/agent-driver.js";

function baseConfig(): ExecutionConfig {
  return {
    phases: ["loop"],
    phaseTimeout: 600,
    qualityLoop: false,
    maxIterations: 3,
    skipVerification: false,
    sequential: false,
    concurrency: 3,
    parallel: false,
    verbose: false,
    noSmartTests: false,
    dryRun: false,
    mcp: false,
    retry: true,
  };
}

function makeMockDriver(
  executePhaseMock: ReturnType<typeof vi.fn>,
): AgentDriver {
  return {
    name: "claude-code",
    resolvesSkills: true,
    executePhase: executePhaseMock,
    isAvailable: vi.fn().mockResolvedValue(true),
    canResume: vi.fn().mockReturnValue(false),
  };
}

describe("#914 gap-fix: executePhase forwards config.phasePolicies[phase] to the driver", () => {
  let executePhaseMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executePhaseMock = vi.fn().mockResolvedValue({
      success: true,
      output: "done",
    });
    vi.mocked(getDriver).mockReturnValue(makeMockDriver(executePhaseMock));
  });

  it("forwards the resolved model/effort for the running phase into AgentExecutionConfig", async () => {
    const config: ExecutionConfig = {
      ...baseConfig(),
      phasePolicies: { loop: { model: "sonnet", effort: "medium" } },
    };

    await executePhaseWithRetry(914, "loop", config);

    expect(executePhaseMock).toHaveBeenCalledTimes(1);
    const agentConfig: AgentExecutionConfig = executePhaseMock.mock.calls[0][1];
    expect(agentConfig.model).toBe("sonnet");
    expect(agentConfig.effort).toBe("medium");
  });

  it("only applies the entry for the phase actually running, not other configured phases", async () => {
    const config: ExecutionConfig = {
      ...baseConfig(),
      phasePolicies: {
        qa: { model: "opus", effort: "high" },
        loop: { model: "sonnet" },
      },
    };

    await executePhaseWithRetry(914, "loop", config);

    const agentConfig: AgentExecutionConfig = executePhaseMock.mock.calls[0][1];
    expect(agentConfig.model).toBe("sonnet");
    expect(agentConfig.effort).toBeUndefined();
  });

  it("omits model/effort entirely when phasePolicies has no entry for the running phase (AC-3 parity)", async () => {
    const config: ExecutionConfig = {
      ...baseConfig(),
      phasePolicies: { qa: { model: "opus" } },
    };

    await executePhaseWithRetry(914, "loop", config);

    const agentConfig: AgentExecutionConfig = executePhaseMock.mock.calls[0][1];
    expect("model" in agentConfig).toBe(false);
    expect("effort" in agentConfig).toBe(false);
  });

  it("omits model/effort entirely when phasePolicies is absent", async () => {
    const config: ExecutionConfig = baseConfig();

    await executePhaseWithRetry(914, "loop", config);

    const agentConfig: AgentExecutionConfig = executePhaseMock.mock.calls[0][1];
    expect("model" in agentConfig).toBe(false);
    expect("effort" in agentConfig).toBe(false);
  });
});
