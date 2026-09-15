/**
 * Executor-side wiring for the codex driver (#497 AC-5).
 *
 * Mirrors phase-executor.opencode.test.ts's structure exactly (#862 AC-3):
 * the same two connective lines that nothing else covers — `codexSettings`
 * threading into `getDriver`, and the dry-run driver line naming "codex".
 *
 * The dry-run print path is `resolveDriverName`, which read only
 * `aiderSettings`/`opencodeSettings` before this change. Without
 * `codexSettings` threaded there too, a codex run resolves its driver through
 * a settings-blind call — and because the printed name is "codex" either way,
 * only an assertion on the `getDriver` call itself catches it.
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
    usesSdkMcp: false,
    executePhase: executePhaseMock,
    isAvailable: vi.fn().mockResolvedValue(true),
    canResume: vi.fn().mockReturnValue(false),
  };
}

describe("497 AC-5: executor wiring for the codex driver", () => {
  let executePhaseMock: ReturnType<typeof vi.fn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    executePhaseMock = vi.fn().mockResolvedValue({
      success: true,
      output: "### Verdict: READY_FOR_MERGE",
    });
    vi.mocked(getDriver).mockReturnValue(
      makeMockDriver("codex", executePhaseMock),
    );
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it("497 AC-5 threads codexSettings into getDriver", async () => {
    const config: ExecutionConfig = {
      ...baseConfig(),
      agent: "codex",
      codexSettings: { model: "gpt-5-codex" },
    };

    await executePhaseWithRetry(1058, "qa", config);

    expect(vi.mocked(getDriver)).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        codexSettings: { model: "gpt-5-codex" },
      }),
    );
  });

  it("497 AC-5 prints the resolved codex driver in a dry run without --verbose", async () => {
    const config: ExecutionConfig = {
      ...baseConfig(),
      agent: "codex",
      dryRun: true,
      verbose: false,
    };

    await executePhaseWithRetry(1058, "qa", config);

    const output = consoleLogSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("Driver: codex");
    // A dry run must not reach the driver.
    expect(executePhaseMock).not.toHaveBeenCalled();
  });

  it("497 AC-5 a dry run with a configured model still names it in the plan", async () => {
    // AC-5's named regression: `resolveDriverName` (phase-executor.ts:1255-1260)
    // must forward `codexSettings` to `getDriver`, not just
    // `aiderSettings`/`opencodeSettings` — a dry run resolving the driver
    // through a settings-blind call would still print "Driver: codex" (the
    // name never changes), which is exactly why asserting on the printed
    // text alone would NOT catch this regression. Assert on the getDriver
    // call itself instead.
    const config: ExecutionConfig = {
      ...baseConfig(),
      agent: "codex",
      dryRun: true,
      codexSettings: { model: "gpt-5-codex" },
    };

    await executePhaseWithRetry(1058, "qa", config);

    expect(vi.mocked(getDriver)).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        codexSettings: { model: "gpt-5-codex" },
      }),
    );
  });

  it("497 AC-5 names the running phase in AgentExecutionConfig", async () => {
    await executePhaseWithRetry(1058, "qa", {
      ...baseConfig(),
      agent: "codex",
    });

    const agentConfig: AgentExecutionConfig = executePhaseMock.mock.calls[0][1];
    expect(agentConfig.phase).toBe("qa");
  });
});
