/**
 * #1150 — per-phase agent selection inside `executePhase`.
 *
 * `executePhase` is unexported, so these drive it through
 * `executePhaseWithRetry` without an injected `executePhaseFn`, as
 * `phase-executor.phase-policy.test.ts` does. The registry is mocked only to
 * hand back REAL driver instances (ClaudeCodeDriver, CodexDriver) whose
 * `executePhase` is stubbed — so which driver ran, and each driver's own
 * `canResume` contract, are the production code under test.
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
import { ClaudeCodeDriver } from "./drivers/claude-code.js";
import { CodexDriver } from "./drivers/codex.js";
import type { ExecutionConfig } from "./types.js";
import type {
  AgentDriver,
  AgentExecutionConfig,
  ResumeHandle,
} from "./drivers/agent-driver.js";

function baseConfig(): ExecutionConfig {
  return {
    phases: ["exec", "qa"],
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
    retry: false,
  };
}

describe("#1150: executePhase dispatches each phase to its own driver", () => {
  let drivers: Record<string, AgentDriver>;
  let ran: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    const claude = new ClaudeCodeDriver();
    const codex = new CodexDriver();
    ran = {
      "claude-code": vi.fn().mockResolvedValue({ success: true, output: "" }),
      codex: vi.fn().mockResolvedValue({ success: true, output: "" }),
    };
    claude.executePhase = ran["claude-code"];
    codex.executePhase = ran.codex;
    drivers = { "claude-code": claude, codex };
    vi.mocked(getDriver).mockReset();
    vi.mocked(getDriver).mockImplementation(
      (name = "claude-code") => drivers[name],
    );
  });

  it("AC-3: run.agent codex + phases.qa.agent claude-code runs exec on codex and qa on claude-code", async () => {
    const config: ExecutionConfig = {
      ...baseConfig(),
      agent: "codex",
      phasePolicies: { qa: { agent: "claude-code" } },
    };

    await executePhaseWithRetry(1150, "exec", config);
    expect(ran.codex).toHaveBeenCalledTimes(1);
    expect(ran["claude-code"]).not.toHaveBeenCalled();

    await executePhaseWithRetry(1150, "qa", config);
    expect(ran["claude-code"]).toHaveBeenCalledTimes(1);
    expect(ran.codex).toHaveBeenCalledTimes(1);
  });

  it("AC-7: a resume handle from exec's codex driver is not passed to qa's claude-code driver", async () => {
    const config: ExecutionConfig = {
      ...baseConfig(),
      agent: "codex",
      phasePolicies: { qa: { agent: "claude-code" } },
    };
    const codexHandle: ResumeHandle = {
      driver: "codex",
      token: "thread-1",
      originCwd: process.cwd(),
    };

    // The same handle IS eligible when the phase stays on codex, so the
    // negative case below is about the driver change, not a bad handle.
    await executePhaseWithRetry(1150, "exec", config, codexHandle);
    const execConfig: AgentExecutionConfig = ran.codex.mock.calls[0][1];
    expect(execConfig.resumeHandle).toEqual(codexHandle);

    await executePhaseWithRetry(1150, "qa", config, codexHandle);
    const qaConfig: AgentExecutionConfig = ran["claude-code"].mock.calls[0][1];
    expect(qaConfig.resumeHandle).toBeUndefined();
    expect(qaConfig.sessionId).toBeUndefined();
  });

  it("AC-9: with no per-phase agent, every phase uses the run-level driver", async () => {
    const config: ExecutionConfig = { ...baseConfig(), agent: "codex" };

    await executePhaseWithRetry(1150, "exec", config);
    await executePhaseWithRetry(1150, "qa", config);

    expect(ran.codex).toHaveBeenCalledTimes(2);
    expect(ran["claude-code"]).not.toHaveBeenCalled();
  });
});
