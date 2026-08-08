/**
 * Test stub for #914 AC-6 — AiderDriver is unaffected by
 * `run.phases.<phase>.{model,effort}`. AiderDriver only ever reads its own
 * `AiderSettings.model` (constructor-injected), never `AgentExecutionConfig`,
 * so this asserts the spawned args are byte-identical whether or not the
 * new per-phase `model`/`effort` fields are present on the config object
 * `executePhase` receives.
 *
 * This test can only fully compile once `AgentExecutionConfig` gains
 * `model`/`effort` (#914 AC-4) — see the `@ts-expect-error` below, which
 * documents that gap rather than hiding it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AiderDriver } from "./aider.js";
import * as childProcess from "child_process";
import type { AgentExecutionConfig } from "./agent-driver.js";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

const mockSpawn = vi.mocked(childProcess.spawn);

function createMockProcess() {
  const proc = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === "close") setTimeout(() => cb(0, null), 0);
    }),
    kill: vi.fn(),
  };
  return proc;
}

function baseConfig(): AgentExecutionConfig {
  return {
    cwd: "/tmp/test-914",
    env: {},
    phaseTimeout: 300,
    verbose: false,
    mcp: false,
  };
}

describe("#914 AC-6: AiderDriver ignores run.phases model/effort", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("spawns identical args with and without config.model/config.effort set", async () => {
    // Given: run.phases.exec.model = "sonnet" resolved into the config object
    // (as buildExecutionConfig -> phase-executor would do), but Aider's own
    // settings.model is what actually drives its --model flag.
    const withPolicy: AgentExecutionConfig = {
      ...baseConfig(),
      // @ts-expect-error — model/effort not yet declared on AgentExecutionConfig (#914 AC-4)
      model: "sonnet",
      // @ts-expect-error — model/effort not yet declared on AgentExecutionConfig (#914 AC-4)
      effort: "medium",
    };

    mockSpawn.mockReturnValue(createMockProcess() as never);
    const driverWithPolicy = new AiderDriver();
    await driverWithPolicy.executePhase("prompt", withPolicy);
    const argsWithPolicy = mockSpawn.mock.calls[0][1] as string[];

    vi.resetAllMocks();
    mockSpawn.mockReturnValue(createMockProcess() as never);
    const driverWithoutPolicy = new AiderDriver();
    await driverWithoutPolicy.executePhase("prompt", baseConfig());
    const argsWithoutPolicy = mockSpawn.mock.calls[0][1] as string[];

    // Then: Aider's args are unchanged by the presence of run.phases config.
    expect(argsWithPolicy).toEqual(argsWithoutPolicy);
    expect(argsWithPolicy).not.toContain("sonnet");
  });
});
