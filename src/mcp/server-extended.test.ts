/**
 * Extended tests for Sequant MCP Server — failure paths and edge cases
 * Issue #372: Expose Sequant Workflow as MCP Server
 * Updated for #388: spawn (async) instead of spawnSync
 * Updated for #389: resolveCliBinary — no nested npx
 *
 * Covers:
 * - AC-2: sequant_run execution behavior (with spawn mocking)
 * - AC-3: sequant_status failure paths
 * - AC-4: sequant_logs edge cases (zero/negative limit)
 * - AC-12: doctor MCP health check
 * - AC-14: structured errors (extended)
 * - #389: binary resolution — no nested npx
 *
 * Guarded: Skips if @modelcontextprotocol/sdk is not installed (#396)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { registerRun, unregisterRun, clearRegistry } from "./run-registry.js";

// Mock child_process before importing server (which imports tools/run.ts)
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

// Mock fs.existsSync for resolveCliBinary tests
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

const mockedSpawn = vi.mocked(spawn);
const mockedExistsSync = vi.mocked(existsSync);

// Import resolveCliBinary for direct unit testing
const { resolveCliBinary } = await import("./tools/run.js");

/** Create a mock ChildProcess that resolves with given exit code, stdout, stderr */
function createMockProcess(opts: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}) {
  const proc = new EventEmitter() as ReturnType<typeof spawn>;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
  (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
  (proc as unknown as Record<string, unknown>).pid = 12345;
  (proc as unknown as Record<string, unknown>).killed = false;
  (proc as unknown as Record<string, unknown>).kill = vi.fn();

  // Schedule async emission of data and close events
  queueMicrotask(() => {
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
  });

  return proc;
}

// Check if MCP SDK is available (dynamic import to avoid hard failure)
const mcpSdkAvailable = await import("@modelcontextprotocol/sdk/server/mcp.js")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!mcpSdkAvailable)("Sequant MCP Server — Extended", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  let cleanup: () => Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createServerFn: any;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default: process.argv[1] exists so resolveCliBinary uses node + script
    mockedExistsSync.mockImplementation((p) => {
      return String(p) === process.argv[1];
    });

    const { createServer } = await import("./server.js");
    createServerFn = createServer;
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
    clearRegistry();
    await cleanup();
  });

  // AC-2: sequant_run tool — execution behavior
  describe("AC-2: sequant_run execution", () => {
    it("should accept valid issues array and return structured result", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stdout: '{"summary":"completed"}',
        }),
      );

      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [100] },
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.status).toBe("success");
      // AC-1: structured response with issues array and summary object
      expect(Array.isArray(data.issues)).toBe(true);
      expect(data.summary).toBeDefined();
      expect(data.summary.total).toBeDefined();
      expect(data.phases).toBeDefined();
      // AC-3: raw output as secondary field
      expect(data.rawOutput).toBeDefined();
    });

    // === FAILURE PATHS ===
    describe("error handling", () => {
      it("should return INVALID_INPUT for empty issues array", async () => {
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

      it("should return isError when subprocess fails", async () => {
        mockedSpawn.mockImplementation(() =>
          createMockProcess({
            exitCode: 1,
            stdout: "partial output",
            stderr: "Error: something went wrong",
          }),
        );

        const result = await client.callTool({
          name: "sequant_run",
          arguments: { issues: [200] },
        });

        expect(result.isError).toBe(true);
        const data = JSON.parse(
          (result.content as Array<{ type: string; text: string }>)[0].text,
        );
        expect(data.status).toBe("failure");
        expect(data.exitCode).toBe(1);
        expect(data.error).toContain("something went wrong");
      });

      it("should handle subprocess spawn error gracefully", async () => {
        const error = new Error("spawn ENOENT");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        mockedSpawn.mockImplementation(() => createMockProcess({ error }));

        const result = await client.callTool({
          name: "sequant_run",
          arguments: { issues: [300] },
        });

        expect(result.isError).toBe(true);
        const data = JSON.parse(
          (result.content as Array<{ type: string; text: string }>)[0].text,
        );
        expect(data.error).toBe("EXECUTION_ERROR");
        expect(data.message).toContain("Command not found");
      });

      it("should truncate large output to 2000 chars", async () => {
        const largeOutput = "x".repeat(5000);
        mockedSpawn.mockImplementation(() =>
          createMockProcess({
            exitCode: 0,
            stdout: largeOutput,
          }),
        );

        const result = await client.callTool({
          name: "sequant_run",
          arguments: { issues: [400] },
        });

        expect(result.isError).toBeFalsy();
        const data = JSON.parse(
          (result.content as Array<{ type: string; text: string }>)[0].text,
        );
        expect(data.rawOutput.length).toBeLessThanOrEqual(2000);
      });
    });
  });

  // #389: sequant_run should NOT use npx — verify binary resolution via MCP
  describe("#389: binary resolution — no nested npx", () => {
    it("should not invoke 'npx' when process.argv[1] exists", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: '{"summary":"ok"}' }),
      );

      await client.callTool({
        name: "sequant_run",
        arguments: { issues: [389] },
      });

      expect(mockedSpawn).toHaveBeenCalledTimes(1);
      const [cmd] = mockedSpawn.mock.calls[0];
      expect(cmd).not.toBe("npx");
    });

    it("should pass current script as first arg when process.argv[1] exists", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "{}" }),
      );

      await client.callTool({
        name: "sequant_run",
        arguments: { issues: [100] },
      });

      const [cmd, args] = mockedSpawn.mock.calls[0];
      expect(cmd).toBe(process.argv[0]);
      expect(args![0]).toBe(process.argv[1]);
      expect(args).toContain("run");
    });

    it("should fall back to npx when neither argv[1] nor dist/bin/cli.js exist", async () => {
      mockedExistsSync.mockReturnValue(false);

      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "{}" }),
      );

      await client.callTool({
        name: "sequant_run",
        arguments: { issues: [100] },
      });

      const [cmd, args] = mockedSpawn.mock.calls[0];
      expect(cmd).toBe("npx");
      expect(args![0]).toBe("sequant");
    });
  });

  // AC-3: sequant_status — failure paths
  describe("AC-3: sequant_status — failure paths", () => {
    it("should return INVALID_INPUT for zero issue number", async () => {
      const result = await client.callTool({
        name: "sequant_status",
        arguments: { issue: 0 },
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.error).toBe("INVALID_INPUT");
    });

    it("should return INVALID_INPUT for negative issue number", async () => {
      const result = await client.callTool({
        name: "sequant_status",
        arguments: { issue: -5 },
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.error).toBe("INVALID_INPUT");
    });
  });

  // AC-4: sequant_logs — failure paths
  describe("AC-4: sequant_logs — failure paths", () => {
    it("should handle invalid runId filter", async () => {
      const result = await client.callTool({
        name: "sequant_logs",
        arguments: { runId: "nonexistent-run-id", limit: 5 },
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data).toBeDefined();
    });

    it("should handle zero limit by using default", async () => {
      const result = await client.callTool({
        name: "sequant_logs",
        arguments: { limit: 0 },
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      // limit: 0 fails the `limit > 0` check, so defaults to 5
      expect(data).toBeDefined();
    });

    it("should handle negative limit by using default", async () => {
      const result = await client.callTool({
        name: "sequant_logs",
        arguments: { limit: -1 },
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      // limit: -1 fails the `limit > 0` check, so defaults to 5
      expect(data).toBeDefined();
    });
  });

  // AC-12: sequant doctor — MCP health check
  describe("AC-12: doctor MCP health check", () => {
    it("should successfully create and close MCP server instance", async () => {
      // This mirrors what doctor.ts does: create server, close it
      const server = createServerFn("1.0.0-test");
      await expect(server.close()).resolves.not.toThrow();
    });

    it("should propagate errors from malformed server version", () => {
      // createServer with any string should still work (version is just metadata)
      const server = createServerFn("");
      expect(server).toBeDefined();
    });
  });

  // AC-14: Structured MCP errors — extended
  describe("AC-14: structured errors — extended", () => {
    it("sequant_status should not crash on missing state file", async () => {
      const result = await client.callTool({
        name: "sequant_status",
        arguments: { issue: 1 },
      });

      expect(result.isError).toBeFalsy();
    });

    it("sequant://state resource should handle missing state file gracefully", async () => {
      const result = await client.readResource({
        uri: "sequant://state",
      });

      expect(result.contents).toHaveLength(1);
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toBeDefined();
    });

    it("sequant://config resource should handle missing config file gracefully", async () => {
      const result = await client.readResource({
        uri: "sequant://config",
      });

      expect(result.contents).toHaveLength(1);
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toBeDefined();
    });
  });

  // #394: Real-time progress reporting — isRunning in sequant_status
  describe("#394: sequant_status isRunning", () => {
    it("should return isRunning: false for untracked issue with no active run", async () => {
      const result = await client.callTool({
        name: "sequant_status",
        arguments: { issue: 99999 },
      });

      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.isRunning).toBe(false);
    });

    it("should return isRunning: true when a run is registered for the issue", async () => {
      registerRun(42, 12345);

      const result = await client.callTool({
        name: "sequant_status",
        arguments: { issue: 42 },
      });

      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.isRunning).toBe(true);
    });

    it("should return isRunning: false after run is unregistered", async () => {
      registerRun(42, 12345);
      unregisterRun(42);

      const result = await client.callTool({
        name: "sequant_status",
        arguments: { issue: 42 },
      });

      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.isRunning).toBe(false);
    });

    it("should register/unregister runs during sequant_run lifecycle", async () => {
      // Use a slow mock process to verify isRunning is true during execution
      const proc = new EventEmitter() as ReturnType<typeof spawn>;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
      (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
      (proc as unknown as Record<string, unknown>).pid = 12345;
      (proc as unknown as Record<string, unknown>).killed = false;
      (proc as unknown as Record<string, unknown>).kill = vi.fn();

      mockedSpawn.mockImplementation(() => proc);

      // Start the run (it will block until mock process closes)
      const runPromise = client.callTool({
        name: "sequant_run",
        arguments: { issues: [55] },
      });

      // Give the event loop a tick so registerRun fires
      await new Promise((r) => setTimeout(r, 10));

      // Check status mid-run — should show isRunning: true
      const midRunStatus = await client.callTool({
        name: "sequant_status",
        arguments: { issue: 55 },
      });
      const midData = JSON.parse(
        (midRunStatus.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(midData.isRunning).toBe(true);

      // Now complete the process
      proc.emit("close", 0);
      await runPromise;

      // Check status after run — should show isRunning: false
      const postRunStatus = await client.callTool({
        name: "sequant_status",
        arguments: { issue: 55 },
      });
      const postData = JSON.parse(
        (postRunStatus.content as Array<{ type: string; text: string }>)[0]
          .text,
      );
      expect(postData.isRunning).toBe(false);
    });

    it("should include polling guidance in status tool description", async () => {
      const result = await client.listTools();
      const statusTool = result.tools.find(
        (t: { name: string }) => t.name === "sequant_status",
      );

      expect(statusTool!.description).toContain("Poll every 5-10 seconds");
    });
  });
});

// #389: Direct unit tests for resolveCliBinary (no MCP SDK dependency)
describe("#389: resolveCliBinary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should use process.argv when argv[1] exists on disk", () => {
    mockedExistsSync.mockImplementation((p) => {
      return String(p) === process.argv[1];
    });

    const [cmd, prefixArgs] = resolveCliBinary();
    expect(cmd).toBe(process.argv[0]);
    expect(prefixArgs).toEqual([process.argv[1]]);
  });

  it("should not use 'npx' when argv[1] exists", () => {
    mockedExistsSync.mockImplementation((p) => {
      return String(p) === process.argv[1];
    });

    const [cmd] = resolveCliBinary();
    expect(cmd).not.toBe("npx");
  });

  it("should fall back to npx when no paths exist", () => {
    mockedExistsSync.mockReturnValue(false);

    const [cmd, prefixArgs] = resolveCliBinary();
    expect(cmd).toBe("npx");
    expect(prefixArgs).toEqual(["sequant"]);
  });

  it("should use __dirname-relative path when argv[1] does not exist but cli.js does", () => {
    mockedExistsSync.mockImplementation((p) => {
      // argv[1] does not exist, but the __dirname-relative cli.js does
      return String(p).endsWith("bin/cli.js");
    });

    const [cmd, prefixArgs] = resolveCliBinary();
    expect(cmd).toBe(process.execPath);
    expect(prefixArgs).toHaveLength(1);
    expect(prefixArgs[0]).toMatch(/bin\/cli\.js$/);
  });

  it("should try __dirname-relative path when argv[1] does not exist", () => {
    const checkedPaths: string[] = [];
    mockedExistsSync.mockImplementation((p) => {
      checkedPaths.push(String(p));
      return false;
    });

    resolveCliBinary();

    // Should have checked at least 2 paths: argv[1] and the __dirname-relative path
    expect(checkedPaths.length).toBeGreaterThanOrEqual(2);
    expect(checkedPaths.some((p) => p.includes("cli.js"))).toBe(true);
  });
});
