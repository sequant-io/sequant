import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDriver } from "./index.js";
import { AiderDriver } from "./aider.js";
import * as childProcess from "child_process";

// Mock child_process for AiderDriver
vi.mock("child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

const mockSpawn = vi.mocked(childProcess.spawn);

/** Create a mock child process that resolves immediately */
function createQuickMockProcess(
  exitCode: number,
  stdout: string[] = [],
  stderr: string[] = [],
) {
  const stdoutListeners: Array<(data: Buffer) => void> = [];
  const stderrListeners: Array<(data: Buffer) => void> = [];
  const processListeners: Record<
    string,
    Array<(...args: unknown[]) => void>
  > = {};

  const proc = {
    stdout: {
      on: vi.fn((_event: string, cb: (data: Buffer) => void) => {
        stdoutListeners.push(cb);
      }),
    },
    stderr: {
      on: vi.fn((_event: string, cb: (data: Buffer) => void) => {
        stderrListeners.push(cb);
      }),
    },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!processListeners[event]) processListeners[event] = [];
      processListeners[event].push(cb);
    }),
    kill: vi.fn(),
  };

  setTimeout(() => {
    for (const chunk of stdout) {
      stdoutListeners.forEach((cb) => cb(Buffer.from(chunk)));
    }
    for (const chunk of stderr) {
      stderrListeners.forEach((cb) => cb(Buffer.from(chunk)));
    }
    processListeners["close"]?.forEach((cb) => cb(exitCode, null));
  }, 0);

  return proc;
}

describe("AiderDriver - Integration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // AC-8: Verbose streaming (integration-level)
  describe("AC-8: verbose streaming integration", () => {
    it("should stream output incrementally via onOutput callback", async () => {
      const proc = createQuickMockProcess(0, [
        "Starting...\n",
        "Working...\n",
        "Done!\n",
      ]);
      mockSpawn.mockReturnValue(proc as never);

      const chunks: string[] = [];
      const driver = new AiderDriver();
      const result = await driver.executePhase("echo test", {
        cwd: "/tmp/test",
        env: {},
        phaseTimeout: 300,
        verbose: true,
        mcp: false,
        onOutput: (text) => chunks.push(text),
      });

      expect(result.success).toBe(true);
      expect(chunks.length).toBe(3);
      expect(chunks[0]).toBe("Starting...\n");
    });
  });

  // AC-10: Doctor checks Aider availability
  describe("AC-10: doctor aider check", () => {
    it("should report available when aider is on PATH", async () => {
      vi.mocked(childProcess.execSync).mockReturnValue(
        Buffer.from("/usr/local/bin/aider"),
      );

      const driver = new AiderDriver();
      expect(await driver.isAvailable()).toBe(true);
    });

    it("should report unavailable when aider is not on PATH", async () => {
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        throw new Error("not found");
      });

      const driver = new AiderDriver();
      expect(await driver.isAvailable()).toBe(false);
    });
  });

  // AC-14: Dry-run shows transformed prompts
  describe("AC-14: dry-run shows transformed prompts", () => {
    it("should pass self-contained prompts to aider (not skill invocations)", async () => {
      const proc = createQuickMockProcess(0, ["ok"]);
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const prompt = `Read GitHub issue #123 using 'gh issue view 123'.
         Create a spec comment on the issue.`;
      await driver.executePhase(prompt, {
        cwd: "/tmp/test",
        env: {},
        phaseTimeout: 300,
        verbose: false,
        mcp: false,
      });

      // Verify the prompt was passed directly to --message
      const args = mockSpawn.mock.calls[0][1] as string[];
      const messageIdx = args.indexOf("--message");
      expect(messageIdx).toBeGreaterThan(-1);
      expect(args[messageIdx + 1]).toContain("Read GitHub issue #123");
    });
  });

  // Error scenarios
  describe("error scenarios", () => {
    it("should handle aider not installed gracefully", async () => {
      const error: NodeJS.ErrnoException = new Error("spawn aider ENOENT");
      error.code = "ENOENT";

      const processListeners: Record<
        string,
        Array<(...args: unknown[]) => void>
      > = {};
      const proc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          if (!processListeners[event]) processListeners[event] = [];
          processListeners[event].push(cb);
        }),
        kill: vi.fn(),
      };
      mockSpawn.mockReturnValue(proc as never);
      setTimeout(() => {
        processListeners["error"]?.forEach((cb) => cb(error));
      }, 0);

      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", {
        cwd: "/tmp/test",
        env: {},
        phaseTimeout: 300,
        verbose: false,
        mcp: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found|install/i);
    });

    it("should handle aider crashing mid-execution", async () => {
      const proc = createQuickMockProcess(137, ["partial output"]);
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", {
        cwd: "/tmp/test",
        env: {},
        phaseTimeout: 300,
        verbose: false,
        mcp: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exited with code 137/);
    });

    it("should handle concurrent aider invocations safely", async () => {
      // Two concurrent calls should not corrupt each other's output
      const proc1 = createQuickMockProcess(0, ["output-1"]);
      const proc2 = createQuickMockProcess(0, ["output-2"]);
      mockSpawn.mockReturnValueOnce(proc1 as never);
      mockSpawn.mockReturnValueOnce(proc2 as never);

      const driver = new AiderDriver();
      const config = {
        cwd: "/tmp/test",
        env: {},
        phaseTimeout: 300,
        verbose: false,
        mcp: false,
      };

      const [result1, result2] = await Promise.all([
        driver.executePhase("prompt-1", config),
        driver.executePhase("prompt-2", config),
      ]);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result1.output).toContain("output-1");
      expect(result2.output).toContain("output-2");
    });
  });

  // Driver registry integration
  describe("driver registry", () => {
    it("should return AiderDriver for 'aider' name", () => {
      const driver = getDriver("aider");
      expect(driver.name).toBe("aider");
      expect(driver).toBeInstanceOf(AiderDriver);
    });

    it("should pass aider settings through registry", () => {
      const driver = getDriver("aider", {
        aiderSettings: { model: "gpt-4o" },
      });
      expect(driver.name).toBe("aider");
    });
  });
});
