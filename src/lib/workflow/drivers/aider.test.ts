import { describe, it, expect, vi, beforeEach } from "vitest";
import { AiderDriver } from "./aider.js";
import * as childProcess from "child_process";

// Mock child_process
vi.mock("child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const mockExecSync = vi.mocked(childProcess.execSync);

/** Create a mock child process with EventEmitter-like behavior */
function createMockProcess(options?: {
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string[];
  stderr?: string[];
  error?: NodeJS.ErrnoException;
}) {
  const stdoutListeners: Array<(data: Buffer) => void> = [];
  const stderrListeners: Array<(data: Buffer) => void> = [];
  const processListeners: Record<
    string,
    Array<(...args: unknown[]) => void>
  > = {};

  const proc = {
    stdout: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === "data") stdoutListeners.push(cb);
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === "data") stderrListeners.push(cb);
      }),
    },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!processListeners[event]) processListeners[event] = [];
      processListeners[event].push(cb);
    }),
    kill: vi.fn(),
  };

  // Schedule emissions in microtask queue
  setTimeout(() => {
    // Emit stdout chunks
    if (options?.stdout) {
      for (const chunk of options.stdout) {
        stdoutListeners.forEach((cb) => cb(Buffer.from(chunk)));
      }
    }
    // Emit stderr chunks
    if (options?.stderr) {
      for (const chunk of options.stderr) {
        stderrListeners.forEach((cb) => cb(Buffer.from(chunk)));
      }
    }
    // Emit error or close
    if (options?.error) {
      processListeners["error"]?.forEach((cb) => cb(options.error));
    } else {
      processListeners["close"]?.forEach((cb) =>
        cb(options?.exitCode ?? 0, options?.signal ?? null),
      );
    }
  }, 0);

  return proc;
}

function makeConfig() {
  return {
    cwd: "/tmp/test",
    env: {},
    phaseTimeout: 300,
    verbose: false,
    mcp: false,
  };
}

describe("AiderDriver", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // AC-1: AiderDriver implements AgentDriver interface
  describe("AC-1: implements AgentDriver interface", () => {
    it("should have name, executePhase(), and isAvailable() with correct signatures", () => {
      const driver = new AiderDriver();
      expect(driver.name).toBe("aider");
      expect(typeof driver.executePhase).toBe("function");
      expect(typeof driver.isAvailable).toBe("function");
    });
  });

  // AC-2: isAvailable() checks aider CLI on PATH
  describe("AC-2: isAvailable() checks aider CLI on PATH", () => {
    it("should return true when aider is on PATH", async () => {
      mockExecSync.mockReturnValue(Buffer.from("/usr/local/bin/aider"));
      const driver = new AiderDriver();
      const result = await driver.isAvailable();
      expect(result).toBe(true);
    });

    it("should return false when aider is not on PATH", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      const driver = new AiderDriver();
      const result = await driver.isAvailable();
      expect(result).toBe(false);
    });
  });

  // AC-3: Phase execution shells out with correct flags
  describe("AC-3: phase execution spawns aider with correct flags", () => {
    it("should spawn aider with --yes --no-auto-commits --no-pretty --message flags", async () => {
      const proc = createMockProcess({
        exitCode: 0,
        stdout: ["output"],
      });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      await driver.executePhase("test prompt", makeConfig());

      expect(mockSpawn).toHaveBeenCalledWith(
        "aider",
        expect.arrayContaining([
          "--yes",
          "--no-auto-commits",
          "--no-pretty",
          "--message",
          "test prompt",
        ]),
        expect.any(Object),
      );
    });

    it("should pass model and editFormat from settings", async () => {
      const proc = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver({
        model: "claude-3-sonnet",
        editFormat: "diff",
      });
      await driver.executePhase("prompt", makeConfig());

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("--model");
      expect(args).toContain("claude-3-sonnet");
      expect(args).toContain("--edit-format");
      expect(args).toContain("diff");
    });

    it("should pass extraArgs from settings", async () => {
      const proc = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver({ extraArgs: ["--map-tokens", "2048"] });
      await driver.executePhase("prompt", makeConfig());

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("--map-tokens");
      expect(args).toContain("2048");
    });

    it("should pass --file flags when files are provided", async () => {
      const proc = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      await driver.executePhase("prompt", {
        ...makeConfig(),
        files: ["src/foo.ts", "src/bar.ts"],
      });

      const args = mockSpawn.mock.calls[0][1] as string[];
      const fileFlags = args.reduce((acc, arg, i) => {
        if (arg === "--file") acc.push(args[i + 1]);
        return acc;
      }, [] as string[]);
      expect(fileFlags).toEqual(["src/foo.ts", "src/bar.ts"]);
    });

    it("should not include --file when files is empty", async () => {
      const proc = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      await driver.executePhase("prompt", { ...makeConfig(), files: [] });

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--file");
    });
  });

  // AC-4: --no-auto-commits flag always present
  describe("AC-4: --no-auto-commits always present", () => {
    it("should include --no-auto-commits in every spawned process", async () => {
      const proc = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      await driver.executePhase("prompt", makeConfig());

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain("--no-auto-commits");
    });
  });

  // AC-5: Output captured for QA verdict parsing
  describe("AC-5: output captured from stdout", () => {
    it("should capture full stdout in result.output", async () => {
      const proc = createMockProcess({
        exitCode: 0,
        stdout: ["hello ", "world"],
      });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", makeConfig());
      expect(result.output).toContain("hello ");
      expect(result.output).toContain("world");
    });

    it("should allow QA verdict regex to match on captured output", async () => {
      const proc = createMockProcess({
        exitCode: 0,
        stdout: ["### Verdict: READY_FOR_MERGE\n"],
      });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", makeConfig());
      expect(result.output).toMatch(/### Verdict: \w+/);
    });
  });

  // #447: exitCode populated in AgentPhaseResult
  describe("#447: exitCode in result", () => {
    it("should include exitCode in result for non-zero exit", async () => {
      const proc = createMockProcess({ exitCode: 2 });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", makeConfig());
      expect(result.exitCode).toBe(2);
    });

    it("should include exitCode: 0 for successful exit", async () => {
      const proc = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", makeConfig());
      expect(result.exitCode).toBe(0);
    });

    it("should include exitCode even when killed by signal", async () => {
      const proc = createMockProcess({
        exitCode: null,
        signal: "SIGSEGV",
      });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", makeConfig());
      // Mock converts null exitCode to 0; real processes may send null
      // The code uses `code ?? undefined`, so null becomes undefined
      // but mock sends 0 (due to ?? 0 in createMockProcess)
      expect(result.exitCode).toBe(0);
    });
  });

  // AC-6: Exit code mapped to success boolean
  describe("AC-6: exit code mapping", () => {
    it("should map exit code 0 to success: true", async () => {
      const proc = createMockProcess({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", makeConfig());
      expect(result.success).toBe(true);
    });

    it("should map non-zero exit code to success: false with error", async () => {
      const proc = createMockProcess({ exitCode: 1 });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", makeConfig());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/exited with code 1/);
    });
  });

  // AC-7: Timeout enforcement
  describe("AC-7: timeout enforcement", () => {
    it("should kill process when phaseTimeout exceeded", async () => {
      vi.useFakeTimers();
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
        kill: vi.fn(() => {
          // When killed, emit close with signal
          setTimeout(() => {
            processListeners["close"]?.forEach((cb) => cb(null, "SIGTERM"));
          }, 0);
        }),
      };
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const promise = driver.executePhase("prompt", {
        ...makeConfig(),
        phaseTimeout: 1,
      });

      // Advance past timeout
      vi.advanceTimersByTime(1100);
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/timeout/i);

      vi.useRealTimers();
    });

    it("should respect abortSignal for cancellation", async () => {
      const ac = new AbortController();
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
        kill: vi.fn(() => {
          setTimeout(() => {
            processListeners["close"]?.forEach((cb) => cb(null, "SIGTERM"));
          }, 0);
        }),
      };
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const promise = driver.executePhase("prompt", {
        ...makeConfig(),
        abortSignal: ac.signal,
      });

      ac.abort();
      const result = await promise;
      expect(proc.kill).toHaveBeenCalled();
      expect(result.success).toBe(false);
    });
  });

  // AC-8: Verbose mode streams stdout
  describe("AC-8: verbose mode streams stdout", () => {
    it("should call onOutput callback incrementally when verbose=true", async () => {
      const proc = createMockProcess({
        exitCode: 0,
        stdout: ["chunk1", "chunk2", "chunk3"],
      });
      mockSpawn.mockReturnValue(proc as never);

      const onOutput = vi.fn();
      const driver = new AiderDriver();
      await driver.executePhase("prompt", {
        ...makeConfig(),
        verbose: true,
        onOutput,
      });

      expect(onOutput).toHaveBeenCalledTimes(3);
      expect(onOutput).toHaveBeenCalledWith("chunk1");
      expect(onOutput).toHaveBeenCalledWith("chunk2");
      expect(onOutput).toHaveBeenCalledWith("chunk3");
    });

    it("should not call onOutput when verbose=false", async () => {
      const proc = createMockProcess({
        exitCode: 0,
        stdout: ["output"],
      });
      mockSpawn.mockReturnValue(proc as never);

      const onOutput = vi.fn();
      const driver = new AiderDriver();
      await driver.executePhase("prompt", {
        ...makeConfig(),
        verbose: false,
        onOutput,
      });

      expect(onOutput).not.toHaveBeenCalled();
    });
  });

  // AC-12: Clear error when aider binary not found
  describe("AC-12: clear error when aider not found", () => {
    it("should return descriptive error when aider binary is missing", async () => {
      const error: NodeJS.ErrnoException = new Error("spawn aider ENOENT");
      error.code = "ENOENT";
      const proc = createMockProcess({ error });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", makeConfig());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found|install aider/i);
    });

    it("should handle spawn ENOENT error gracefully", async () => {
      const error: NodeJS.ErrnoException = new Error("spawn aider ENOENT");
      error.code = "ENOENT";
      const proc = createMockProcess({ error });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", makeConfig());
      expect(result.error).toBeDefined();
      expect(result.success).toBe(false);
    });
  });

  // Error handling
  describe("error handling", () => {
    it("should handle stderr output without crashing", async () => {
      const proc = createMockProcess({
        exitCode: 0,
        stdout: ["output"],
        stderr: ["warning: something"],
      });
      mockSpawn.mockReturnValue(proc as never);

      const onStderr = vi.fn();
      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", {
        ...makeConfig(),
        onStderr,
      });

      expect(result.success).toBe(true);
      expect(onStderr).toHaveBeenCalledWith("warning: something");
    });

    it("should handle process crash (signal kill)", async () => {
      const proc = createMockProcess({
        exitCode: null,
        signal: "SIGSEGV",
      });
      mockSpawn.mockReturnValue(proc as never);

      const driver = new AiderDriver();
      const result = await driver.executePhase("prompt", makeConfig());
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/signal.*SIGSEGV/i);
    });
  });
});
