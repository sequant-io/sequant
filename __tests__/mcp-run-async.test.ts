/**
 * Tests for sequant_run MCP tool async refactor
 * Issue #388: Replace spawnSync with async spawn
 *
 * Covers:
 * - AC-1: spawn instead of spawnSync
 * - AC-4: Output buffered, truncated to 2000 chars
 * - AC-5: Timeout preserved (30 min default)
 * - AC-6: Tests updated for async
 * - Derived AC-7: Handle ENOENT with descriptive error
 * - Derived AC-8: No orphan processes on timeout/cancel
 * - AC-3: MCP cancellation via AbortSignal
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { spawn } from "child_process";

// Mock child_process before importing server
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

// Mock fs so resolveCliBinary falls through to npx fallback,
// and readLatestRunLog returns null (fallback response path)
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(() => Promise.resolve([])),
    readFile: vi.fn(() => Promise.resolve("")),
  };
});

const mockedSpawn = vi.mocked(spawn);

/** Create a mock ChildProcess that emits events asynchronously */
function createMockProcess(opts: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
  /** Delay in ms before emitting events (default: 0 = microtask) */
  delay?: number;
}) {
  const proc = new EventEmitter() as ReturnType<typeof spawn>;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
  (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
  (proc as unknown as Record<string, unknown>).pid = 12345;
  (proc as unknown as Record<string, unknown>).killed = false;
  (proc as unknown as Record<string, unknown>).kill = vi.fn(() => {
    (proc as unknown as Record<string, unknown>).killed = true;
  });

  const emit = () => {
    if (opts.stdout) {
      stdoutEmitter.emit("data", Buffer.from(opts.stdout));
    }
    if (opts.stderr) {
      stderrEmitter.emit("data", Buffer.from(opts.stderr));
    }
    if (opts.error) {
      proc.emit("error", opts.error);
    } else {
      proc.emit("close", opts.exitCode ?? 0);
    }
  };

  if (opts.delay) {
    setTimeout(emit, opts.delay);
  } else {
    queueMicrotask(emit);
  }

  return proc;
}

// Check if MCP SDK is available
const mcpSdkAvailable = await import("@modelcontextprotocol/sdk/server/mcp.js")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!mcpSdkAvailable)("sequant_run tool async refactor", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const { createServer } = await import("../src/mcp/server.js");
    const { Client } =
      await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } =
      await import("@modelcontextprotocol/sdk/inMemory.js");

    const server = createServer("1.0.0-test");
    const clientInstance = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      clientInstance.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    client = clientInstance;
    cleanup = async () => {
      await clientInstance.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  describe("AC-1: spawn instead of spawnSync", () => {
    it("should use child_process.spawn and return Promise that resolves after process exit", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "success output" }),
      );

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [123] },
      });

      expect(mockedSpawn).toHaveBeenCalledOnce();
      expect(result).toBeDefined();
      expect(result.content).toHaveLength(1);
      expect(result.isError).toBeFalsy();
    });

    it("should call spawn with npx and correct command arguments", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "" }),
      );

      await client.callTool({
        name: "sequant_run",
        arguments: { issues: [42] },
      });

      expect(mockedSpawn).toHaveBeenCalledWith(
        "npx",
        ["sequant", "run", "42", "--log-json"],
        expect.objectContaining({
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
          env: expect.objectContaining({
            SEQUANT_ORCHESTRATOR: "mcp-server",
          }),
        }),
      );
    });
  });

  describe("AC-4: Output buffered, truncated to 2000 chars", () => {
    it("should truncate stdout to last 2000 chars when output exceeds limit", async () => {
      const largeOutput = "x".repeat(5000);
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: largeOutput }),
      );

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [456] },
      });

      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.rawOutput.length).toBeLessThanOrEqual(2000);
      expect(data.rawOutput).toBe("x".repeat(2000));
    });

    it("should return full output when it's smaller than 2000 chars", async () => {
      const smallOutput = "hello world";
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: smallOutput }),
      );

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [457] },
      });

      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.rawOutput).toBe("hello world");
    });

    it("should handle empty output gracefully", async () => {
      mockedSpawn.mockImplementation(() => createMockProcess({ exitCode: 0 }));

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [458] },
      });

      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.rawOutput).toBe("");
    });
  });

  describe("AC-5: Timeout preserved (30 min default)", () => {
    it("should reject with timeout error when process does not exit in time", async () => {
      // Test spawnAsync directly with a short timeout to avoid MCP transport interference
      const { spawnAsync } = await import("../src/mcp/tools/run.js");

      // Create a process that never exits
      const proc = new EventEmitter() as ReturnType<typeof spawn>;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
      (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
      (proc as unknown as Record<string, unknown>).pid = 99999;
      (proc as unknown as Record<string, unknown>).killed = false;
      (proc as unknown as Record<string, unknown>).kill = vi.fn();

      mockedSpawn.mockReturnValue(proc);

      // Use a very short timeout (50ms) for fast testing
      await expect(
        spawnAsync("npx", ["test"], { timeout: 50 }),
      ).rejects.toThrow("timed out");
    }, 10000);

    it("should complete normally when process exits before timeout", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "done" }),
      );

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [790] },
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.status).toBe("success");
    });
  });

  describe("AC-6: Tests updated for async", () => {
    it("should return success status with valid issue numbers", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "test output" }),
      );

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [111] },
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.status).toBe("success");
      // Fallback response has empty issues array (no log file to parse)
      expect(data.issues).toEqual([]);
      expect(data.summary.total).toBe(1);
    });

    it("should return error for empty issues array", async () => {
      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [] },
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.error).toBe("INVALID_INPUT");
    });

    it("should return failure status with non-zero exit code", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 2,
          stdout: "partial",
          stderr: "fatal error",
        }),
      );

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [112] },
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.status).toBe("failure");
      expect(data.exitCode).toBe(2);
      expect(data.error).toContain("fatal error");
    });
  });

  describe("Derived AC-7: Handle ENOENT with descriptive error", () => {
    it("should return EXECUTION_ERROR with descriptive message when spawn emits ENOENT", async () => {
      const error = new Error("ENOENT: no such file or directory");
      (error as NodeJS.ErrnoException).code = "ENOENT";
      mockedSpawn.mockImplementation(() => createMockProcess({ error }));

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [222] },
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.error).toBe("EXECUTION_ERROR");
      expect(data.message).toContain("Command not found");
    });

    it("should handle other spawn error codes gracefully", async () => {
      const error = new Error("EACCES: permission denied");
      (error as NodeJS.ErrnoException).code = "EACCES";
      mockedSpawn.mockImplementation(() => createMockProcess({ error }));

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [223] },
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.error).toBe("EXECUTION_ERROR");
      expect(data.message).toContain("Failed to spawn process");
    });
  });

  describe("Derived AC-8: No orphan processes on timeout/cancel", () => {
    it("should kill process group when timeout occurs", async () => {
      // Test spawnAsync directly with a short timeout
      const { spawnAsync } = await import("../src/mcp/tools/run.js");

      // Create a process that never exits
      const proc = new EventEmitter() as ReturnType<typeof spawn>;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
      (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
      (proc as unknown as Record<string, unknown>).pid = 12345;
      (proc as unknown as Record<string, unknown>).killed = false;
      (proc as unknown as Record<string, unknown>).kill = vi.fn();

      mockedSpawn.mockReturnValue(proc);

      // Spy on process.kill to verify group kill
      const processKillSpy = vi
        .spyOn(process, "kill")
        .mockImplementation(() => true);

      await expect(
        spawnAsync("npx", ["test"], { timeout: 50 }),
      ).rejects.toThrow("timed out");

      // Should attempt to kill the process group (negative PID)
      expect(processKillSpy).toHaveBeenCalledWith(-12345, "SIGTERM");

      processKillSpy.mockRestore();
    }, 10000);

    it("should properly clean up process resources after successful execution", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "done" }),
      );

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [334] },
      });

      expect(result.isError).toBeFalsy();
      // Process completed normally — no kill needed
    });

    it("should properly clean up process resources when spawn error occurs", async () => {
      const error = new Error("spawn failed");
      (error as NodeJS.ErrnoException).code = "ENOENT";
      mockedSpawn.mockImplementation(() => createMockProcess({ error }));

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [335] },
      });

      expect(result.isError).toBe(true);
      // Error handled gracefully — no hanging process
    });
  });

  describe("Integration: tool parameters with async spawn", () => {
    it("should pass phases parameter to spawn command arguments", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "" }),
      );

      await client.callTool({
        name: "sequant_run",
        arguments: { issues: [1], phases: "spec,exec" },
      });

      expect(mockedSpawn).toHaveBeenCalledWith(
        "npx",
        ["sequant", "run", "1", "--phases", "spec,exec", "--log-json"],
        expect.anything(),
      );
    });

    it("should pass qualityLoop parameter to spawn command arguments", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "" }),
      );

      await client.callTool({
        name: "sequant_run",
        arguments: { issues: [2], qualityLoop: true },
      });

      expect(mockedSpawn).toHaveBeenCalledWith(
        "npx",
        ["sequant", "run", "2", "--quality-loop", "--log-json"],
        expect.anything(),
      );
    });

    it("should pass agent parameter to spawn command arguments", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "" }),
      );

      await client.callTool({
        name: "sequant_run",
        arguments: { issues: [3], agent: "aider" },
      });

      expect(mockedSpawn).toHaveBeenCalledWith(
        "npx",
        ["sequant", "run", "3", "--agent", "aider", "--log-json"],
        expect.anything(),
      );
    });

    it("should always include --log-json parameter in spawn command", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "" }),
      );

      await client.callTool({
        name: "sequant_run",
        arguments: { issues: [4] },
      });

      const callArgs = mockedSpawn.mock.calls[0][1] as string[];
      expect(callArgs).toContain("--log-json");
    });

    it("should set SEQUANT_ORCHESTRATOR=mcp-server in spawn environment", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "" }),
      );

      await client.callTool({
        name: "sequant_run",
        arguments: { issues: [5] },
      });

      const callOpts = mockedSpawn.mock.calls[0][2] as Record<string, unknown>;
      expect(
        (callOpts.env as Record<string, string>).SEQUANT_ORCHESTRATOR,
      ).toBe("mcp-server");
    });
  });

  describe("AC-3: AbortSignal cancellation", () => {
    it("should reject with cancellation error when signal is aborted", async () => {
      const { spawnAsync } = await import("../src/mcp/tools/run.js");
      // Create a process that hangs (never closes)
      mockedSpawn.mockImplementation(() => {
        const proc = new EventEmitter() as ReturnType<typeof spawn>;
        const stdoutEmitter = new EventEmitter();
        const stderrEmitter = new EventEmitter();
        (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
        (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
        (proc as unknown as Record<string, unknown>).pid = 99999;
        (proc as unknown as Record<string, unknown>).killed = false;
        (proc as unknown as Record<string, unknown>).kill = vi.fn();
        return proc;
      });

      const controller = new AbortController();
      const promise = spawnAsync("npx", ["sequant", "run", "1"], {
        timeout: 60000,
        signal: controller.signal,
      });

      // Abort after a tick
      queueMicrotask(() => controller.abort());

      await expect(promise).rejects.toThrow("Cancelled by client");
    });

    it("should kill process group when signal is aborted", async () => {
      const { spawnAsync } = await import("../src/mcp/tools/run.js");
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

      mockedSpawn.mockImplementation(() => {
        const proc = new EventEmitter() as ReturnType<typeof spawn>;
        const stdoutEmitter = new EventEmitter();
        const stderrEmitter = new EventEmitter();
        (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
        (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
        (proc as unknown as Record<string, unknown>).pid = 55555;
        (proc as unknown as Record<string, unknown>).killed = false;
        (proc as unknown as Record<string, unknown>).kill = vi.fn();
        return proc;
      });

      const controller = new AbortController();
      const promise = spawnAsync("npx", ["sequant", "run", "1"], {
        timeout: 60000,
        signal: controller.signal,
      });

      queueMicrotask(() => controller.abort());

      await expect(promise).rejects.toThrow("Cancelled by client");
      expect(killSpy).toHaveBeenCalledWith(-55555, "SIGTERM");
      killSpy.mockRestore();
    });

    it("should reject immediately when signal is already aborted", async () => {
      const { spawnAsync } = await import("../src/mcp/tools/run.js");

      mockedSpawn.mockImplementation(() => {
        const proc = new EventEmitter() as ReturnType<typeof spawn>;
        const stdoutEmitter = new EventEmitter();
        const stderrEmitter = new EventEmitter();
        (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
        (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
        (proc as unknown as Record<string, unknown>).pid = 77777;
        (proc as unknown as Record<string, unknown>).killed = false;
        (proc as unknown as Record<string, unknown>).kill = vi.fn();
        return proc;
      });

      const controller = new AbortController();
      controller.abort(); // Already aborted

      await expect(
        spawnAsync("npx", ["sequant", "run", "1"], {
          timeout: 60000,
          signal: controller.signal,
        }),
      ).rejects.toThrow("Cancelled by client");
    });
  });

  describe("Edge cases", () => {
    it("should handle multiple issue numbers in a single call", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "" }),
      );

      await client.callTool({
        name: "sequant_run",
        arguments: { issues: [10, 20, 30] },
      });

      expect(mockedSpawn).toHaveBeenCalledWith(
        "npx",
        ["sequant", "run", "10", "20", "30", "--log-json"],
        expect.anything(),
      );
    });

    it("should handle very large issue numbers", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "" }),
      );

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [999999] },
      });

      expect(result.isError).toBeFalsy();
      expect(mockedSpawn).toHaveBeenCalledWith(
        "npx",
        ["sequant", "run", "999999", "--log-json"],
        expect.anything(),
      );
    });

    it("should handle stderr output separately from stdout", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 1,
          stdout: "standard output",
          stderr: "error output",
        }),
      );

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [50] },
      });

      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.rawOutput).toBe("standard output");
      expect(data.error).toBe("error output");
    });

    it("should handle mixed stdout and stderr interleaving", async () => {
      // Both stdout and stderr should be captured independently
      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stdout: "out1out2",
          stderr: "err1err2",
        }),
      );

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [51] },
      });

      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.rawOutput).toContain("out1out2");
    });
  });
});
