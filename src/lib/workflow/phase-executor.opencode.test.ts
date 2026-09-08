/**
 * Executor-side wiring for the opencode driver (#862 AC-3, OQ-2).
 *
 * Two connective lines inside the unexported `executePhase` that nothing else
 * covers:
 *
 * 1. `AgentExecutionConfig.phase` — opencode dispatches `run --command <phase>`
 *    and is otherwise handed only a prompt string, so without this the driver
 *    cannot name the command and every phase silently degrades to a bare
 *    prompt with no skill and no marker.
 * 2. The dry-run driver line — `--agent opencode --dry-run` used to print a
 *    plan indistinguishable from a claude-code one.
 *
 * Driven through the public `executePhaseWithRetry` entry point (the "test via
 * public API" pattern used by the #914 sibling file), with `getDriver` mocked
 * so nothing spawns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
    phases: ["qa"],
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
  name: string,
  executePhaseMock: ReturnType<typeof vi.fn>,
): AgentDriver {
  return {
    name,
    resolvesSkills: true,
    executePhase: executePhaseMock,
    isAvailable: vi.fn().mockResolvedValue(true),
    canResume: vi.fn().mockReturnValue(false),
  };
}

describe("862 AC-3: executor wiring for the opencode driver", () => {
  let executePhaseMock: ReturnType<typeof vi.fn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    executePhaseMock = vi.fn().mockResolvedValue({
      success: true,
      output: "### Verdict: READY_FOR_MERGE",
    });
    vi.mocked(getDriver).mockReturnValue(
      makeMockDriver("opencode", executePhaseMock),
    );
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it("862 AC-3 names the running phase in AgentExecutionConfig", async () => {
    await executePhaseWithRetry(862, "qa", baseConfig());

    const agentConfig: AgentExecutionConfig = executePhaseMock.mock.calls[0][1];
    // Without this the opencode driver cannot build `--command qa`, so the
    // phase runs with no skill and the AC-4 marker check never applies.
    expect(agentConfig.phase).toBe("qa");
  });

  it("862 AC-3 threads opencodeSettings into getDriver", async () => {
    const config: ExecutionConfig = {
      ...baseConfig(),
      agent: "opencode",
      opencodeSettings: { model: "openrouter/anthropic/claude-sonnet-5" },
    };

    await executePhaseWithRetry(862, "qa", config);

    expect(vi.mocked(getDriver)).toHaveBeenCalledWith(
      "opencode",
      expect.objectContaining({
        opencodeSettings: { model: "openrouter/anthropic/claude-sonnet-5" },
      }),
    );
  });

  it("862 AC-3 prints the resolved driver in a dry run without --verbose", async () => {
    const config: ExecutionConfig = {
      ...baseConfig(),
      agent: "opencode",
      dryRun: true,
      verbose: false,
    };

    await executePhaseWithRetry(862, "qa", config);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Driver: opencode");
    // A dry run must not reach the driver.
    expect(executePhaseMock).not.toHaveBeenCalled();
  });

  it("862 AC-3 a dry run with an unknown driver still prints a plan", async () => {
    vi.mocked(getDriver).mockImplementation(() => {
      throw new Error('Unknown agent driver "nope"');
    });
    const config: ExecutionConfig = {
      ...baseConfig(),
      agent: "nope",
      dryRun: true,
    };

    await executePhaseWithRetry(862, "qa", config);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("unknown driver");
  });
});
