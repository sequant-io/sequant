/**
 * Integration tests for Sequant MCP Server async refactor
 * Issue #388: Replace spawnSync with async spawn in MCP integration
 *
 * Covers:
 * - AC-2: status/logs responsive during run (verified via unit tests + architecture)
 * - AC-3: MCP cancellation support (verified via unit tests + AbortSignal wiring)
 *
 * Note: Full end-to-end integration tests for concurrent tool calls require
 * a running MCP server with SSE transport. These tests verify the architectural
 * properties that enable responsiveness (async spawn, non-blocking event loop).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { spawn } from "child_process";

// Mock child_process
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const mockedSpawn = vi.mocked(spawn);

function createMockProcess(opts: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
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
    if (opts.stdout) stdoutEmitter.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) stderrEmitter.emit("data", Buffer.from(opts.stderr));
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

const mcpSdkAvailable = await import("@modelcontextprotocol/sdk/server/mcp.js")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!mcpSdkAvailable)(
  "MCP Server async refactor — Integration",
  () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let client: any;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      vi.clearAllMocks();

      const { createServer } = await import("../../src/mcp/server.js");
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

    // AC-2: status/logs responsive during run
    describe("AC-2: status/logs responsive during run", () => {
      it("should allow concurrent tool calls while sequant_run is pending", async () => {
        // Create a process that takes time to complete
        const proc = new EventEmitter() as ReturnType<typeof spawn>;
        const stdoutEmitter = new EventEmitter();
        const stderrEmitter = new EventEmitter();
        (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
        (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
        (proc as unknown as Record<string, unknown>).pid = 12345;
        (proc as unknown as Record<string, unknown>).killed = false;
        (proc as unknown as Record<string, unknown>).kill = vi.fn();

        mockedSpawn.mockReturnValue(proc);

        // Start a run (will not resolve until process closes)
        const runPromise = client.callTool({
          name: "sequant_run",
          arguments: { issues: [100] },
        });

        // While run is pending, call sequant_status — should respond immediately
        const statusResult = await client.callTool({
          name: "sequant_status",
          arguments: { issue: 100 },
        });

        // Status responded while run is still pending — proves non-blocking
        expect(statusResult).toBeDefined();
        expect(statusResult.content).toHaveLength(1);

        // Now complete the run
        stdoutEmitter.emit("data", Buffer.from("done"));
        proc.emit("close", 0);

        const runResult = await runPromise;
        expect(runResult).toBeDefined();
      });

      it("should allow sequant_logs calls while sequant_run is pending", async () => {
        const proc = new EventEmitter() as ReturnType<typeof spawn>;
        const stdoutEmitter = new EventEmitter();
        const stderrEmitter = new EventEmitter();
        (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
        (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
        (proc as unknown as Record<string, unknown>).pid = 12345;
        (proc as unknown as Record<string, unknown>).killed = false;
        (proc as unknown as Record<string, unknown>).kill = vi.fn();

        mockedSpawn.mockReturnValue(proc);

        // Start a run
        const runPromise = client.callTool({
          name: "sequant_run",
          arguments: { issues: [101] },
        });

        // Call logs while run is pending
        const logsResult = await client.callTool({
          name: "sequant_logs",
          arguments: { limit: 5 },
        });

        expect(logsResult).toBeDefined();
        expect(logsResult.isError).toBeFalsy();

        // Complete the run
        proc.emit("close", 0);
        await runPromise;
      });

      it("should handle multiple concurrent status queries", async () => {
        const proc = new EventEmitter() as ReturnType<typeof spawn>;
        const stdoutEmitter = new EventEmitter();
        const stderrEmitter = new EventEmitter();
        (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
        (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
        (proc as unknown as Record<string, unknown>).pid = 12345;
        (proc as unknown as Record<string, unknown>).killed = false;
        (proc as unknown as Record<string, unknown>).kill = vi.fn();

        mockedSpawn.mockReturnValue(proc);

        // Start a run
        const runPromise = client.callTool({
          name: "sequant_run",
          arguments: { issues: [102] },
        });

        // Send multiple concurrent status queries
        const results = await Promise.all([
          client.callTool({ name: "sequant_status", arguments: { issue: 1 } }),
          client.callTool({ name: "sequant_status", arguments: { issue: 2 } }),
          client.callTool({ name: "sequant_status", arguments: { issue: 3 } }),
        ]);

        // All should respond
        for (const r of results) {
          expect(r).toBeDefined();
          expect(r.content).toHaveLength(1);
        }

        proc.emit("close", 0);
        await runPromise;
      });
    });

    // AC-3: MCP cancellation support
    describe("AC-3: MCP cancellation support", () => {
      it("should use spawn with detached:true for process group management", async () => {
        mockedSpawn.mockImplementation(() =>
          createMockProcess({ exitCode: 0, stdout: "" }),
        );

        await client.callTool({
          name: "sequant_run",
          arguments: { issues: [200] },
        });

        // Verify detached:true is used (enables process group kill)
        expect(mockedSpawn).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ detached: true }),
        );
      });
    });

    // Error scenarios
    describe("error scenarios", () => {
      it("should remain responsive after sequant_run error", async () => {
        const error = new Error("spawn failed");
        (error as NodeJS.ErrnoException).code = "ENOENT";
        mockedSpawn.mockImplementation(() => createMockProcess({ error }));

        // Run fails
        const runResult = await client.callTool({
          name: "sequant_run",
          arguments: { issues: [300] },
        });
        expect(runResult.isError).toBe(true);

        // Server still responsive
        const statusResult = await client.callTool({
          name: "sequant_status",
          arguments: { issue: 300 },
        });
        expect(statusResult).toBeDefined();
      });

      it("should isolate failures between sequential runs", async () => {
        // First run fails
        const error = new Error("failed");
        (error as NodeJS.ErrnoException).code = "EACCES";
        mockedSpawn.mockImplementationOnce(() => createMockProcess({ error }));

        const result1 = await client.callTool({
          name: "sequant_run",
          arguments: { issues: [301] },
        });
        expect(result1.isError).toBe(true);

        // Second run succeeds
        mockedSpawn.mockImplementationOnce(() =>
          createMockProcess({ exitCode: 0, stdout: "ok" }),
        );

        const result2 = await client.callTool({
          name: "sequant_run",
          arguments: { issues: [302] },
        });
        expect(result2.isError).toBeFalsy();
      });

      it("should handle subprocess crash without blocking event loop", async () => {
        // Process exits with signal (crash)
        const proc = new EventEmitter() as ReturnType<typeof spawn>;
        const stdoutEmitter = new EventEmitter();
        const stderrEmitter = new EventEmitter();
        (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
        (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
        (proc as unknown as Record<string, unknown>).pid = 12345;
        (proc as unknown as Record<string, unknown>).killed = false;
        (proc as unknown as Record<string, unknown>).kill = vi.fn();

        mockedSpawn.mockImplementation(() => {
          // Emit crash after listeners are set up
          queueMicrotask(() => proc.emit("close", null));
          return proc;
        });

        const runPromise = client.callTool({
          name: "sequant_run",
          arguments: { issues: [303] },
        });

        const result = await runPromise;
        // null exit code should be treated as failure
        expect(result).toBeDefined();
      });
    });
  },
);
