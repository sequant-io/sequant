/**
 * Integration tests for MCP Progress Notifications (#421)
 *
 * Tests AC-2 (phase transition → progress notification flow),
 * AC-5 (backward compatibility with existing behavior),
 * and error scenarios.
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

// Mock fs so resolveCliBinary falls through to npx fallback
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

/** Progress event from onprogress callback */
interface ProgressEvent {
  progress: number;
  total: number;
  message?: string;
}

/** Create a mock ChildProcess with controllable stdout chunks for phase simulation */
function createMockProcessWithPhaseOutput(opts: {
  exitCode?: number | null;
  stdout?: string;
  stdoutChunks?: string[];
  stderrChunks?: string[];
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
    if (opts.stdoutChunks) {
      for (const chunk of opts.stdoutChunks) {
        stdoutEmitter.emit("data", Buffer.from(chunk));
      }
    } else if (opts.stdout) {
      stdoutEmitter.emit("data", Buffer.from(opts.stdout));
    }
    if (opts.stderrChunks) {
      for (const chunk of opts.stderrChunks) {
        stderrEmitter.emit("data", Buffer.from(chunk));
      }
    }
    proc.emit("close", opts.exitCode ?? 0);
  };

  queueMicrotask(emit);
  return proc;
}

// Check if MCP SDK is available
const mcpSdkAvailable = await import("@modelcontextprotocol/sdk/server/mcp.js")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!mcpSdkAvailable)(
  "MCP Progress Notifications - Integration (#421)",
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

    describe("AC-2: Phase transitions emit notifications/progress", () => {
      it("should emit progress notifications for each phase start on stdout", async () => {
        const progressEvents: ProgressEvent[] = [];

        mockedSpawn.mockImplementation(() =>
          createMockProcessWithPhaseOutput({
            exitCode: 0,
            stdoutChunks: [
              "\u23F3     spec (1/3)...\n",
              "\u2713     spec (1/3) (10s)\n",
              "\u23F3     exec (2/3)...\n",
              "\u2713     exec (2/3) (20s)\n",
              "\u23F3     qa (3/3)...\n",
              "\u2713     qa (3/3) (5s)\n",
            ],
          }),
        );

        await client.callTool(
          { name: "sequant_run", arguments: { issues: [421] } },
          undefined,
          {
            onprogress: (evt: ProgressEvent) => {
              progressEvents.push(evt);
            },
            timeout: 10000,
          },
        );

        await new Promise((r) => setTimeout(r, 50));

        // Should emit 3 notifications (one per phase START, not completions)
        expect(progressEvents).toHaveLength(3);
        expect(progressEvents[0]).toMatchObject({
          progress: 1,
          total: 3,
        });
        expect(progressEvents[0].message).toContain("spec");
        expect(progressEvents[1]).toMatchObject({
          progress: 2,
          total: 3,
        });
        expect(progressEvents[1].message).toContain("exec");
        expect(progressEvents[2]).toMatchObject({
          progress: 3,
          total: 3,
        });
        expect(progressEvents[2].message).toContain("qa");
      });

      it("should include incrementing progress counter", async () => {
        const progressValues: number[] = [];

        mockedSpawn.mockImplementation(() =>
          createMockProcessWithPhaseOutput({
            exitCode: 0,
            stdoutChunks: [
              "\u23F3     spec (1/3)...\n",
              "\u23F3     exec (2/3)...\n",
              "\u23F3     qa (3/3)...\n",
            ],
          }),
        );

        await client.callTool(
          { name: "sequant_run", arguments: { issues: [421] } },
          undefined,
          {
            onprogress: (evt: ProgressEvent) => {
              progressValues.push(evt.progress);
            },
            timeout: 10000,
          },
        );

        await new Promise((r) => setTimeout(r, 50));

        expect(progressValues).toEqual([1, 2, 3]);
      });

      it("should include issue number in progress message", async () => {
        const messages: string[] = [];

        mockedSpawn.mockImplementation(() =>
          createMockProcessWithPhaseOutput({
            exitCode: 0,
            stdoutChunks: ["\u23F3     spec (1/3)...\n"],
          }),
        );

        await client.callTool(
          { name: "sequant_run", arguments: { issues: [421] } },
          undefined,
          {
            onprogress: (evt: ProgressEvent) => {
              if (evt.message) messages.push(evt.message);
            },
            timeout: 10000,
          },
        );

        await new Promise((r) => setTimeout(r, 50));

        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain("421");
        expect(messages[0]).toContain("spec");
      });

      it("validates assumption: PhaseSpinner format is parseable", async () => {
        const { parsePhaseStart } = await import("../../src/mcp/tools/run.js");

        // PhaseSpinner start format: "⏳     <phase> (<N>/<M>)..."
        expect(parsePhaseStart("\u23F3     spec (1/3)...")).toEqual({
          phase: "spec",
          phaseIndex: 1,
          totalPhases: 3,
        });

        // PhaseSpinner with minimal whitespace
        expect(parsePhaseStart("\u23F3 exec (2/3)...")).toEqual({
          phase: "exec",
          phaseIndex: 2,
          totalPhases: 3,
        });

        // Completion lines should NOT match
        expect(parsePhaseStart("\u2713     spec (1/3) (10s)")).toBeNull();
        expect(parsePhaseStart("\u2717     exec (2/3) (5s): error")).toBeNull();
      });
    });

    describe("AC-5: Existing behavior unchanged", () => {
      it("should not break response structure when progress is enabled", async () => {
        mockedSpawn.mockImplementation(() =>
          createMockProcessWithPhaseOutput({
            exitCode: 0,
            stdoutChunks: [
              "\u23F3     spec (1/3)...\n",
              "\u23F3     exec (2/3)...\n",
              "\u23F3     qa (3/3)...\n",
            ],
          }),
        );

        const result = await client.callTool(
          { name: "sequant_run", arguments: { issues: [421] } },
          undefined,
          {
            onprogress: () => {},
            timeout: 10000,
          },
        );

        expect(result.isError).toBeFalsy();
        const data = JSON.parse(
          (result.content as Array<{ type: string; text: string }>)[0].text,
        );
        expect(data.status).toBe("success");
        expect(data).toHaveProperty("summary");
        expect(data).toHaveProperty("phases");
      });

      it("should maintain backward compatibility with no-token clients", async () => {
        mockedSpawn.mockImplementation(() =>
          createMockProcessWithPhaseOutput({
            exitCode: 0,
            stdout: "output",
          }),
        );

        const result = await client.callTool({
          name: "sequant_run",
          arguments: { issues: [421] },
        });

        expect(result.isError).toBeFalsy();
        const data = JSON.parse(
          (result.content as Array<{ type: string; text: string }>)[0].text,
        );
        expect(data.status).toBe("success");
      });
    });

    describe("Error scenarios", () => {
      it("should handle subprocess with no phase patterns", async () => {
        const progressEvents: ProgressEvent[] = [];

        mockedSpawn.mockImplementation(() =>
          createMockProcessWithPhaseOutput({
            exitCode: 0,
            stdoutChunks: ["some random warning\n", "another log line\n"],
          }),
        );

        const result = await client.callTool(
          { name: "sequant_run", arguments: { issues: [421] } },
          undefined,
          {
            onprogress: (evt: ProgressEvent) => {
              progressEvents.push(evt);
            },
            timeout: 10000,
          },
        );

        await new Promise((r) => setTimeout(r, 50));

        expect(result.isError).toBeFalsy();
        expect(progressEvents).toHaveLength(0);
      });

      it("should handle partial/malformed phase output", async () => {
        const progressEvents: ProgressEvent[] = [];

        mockedSpawn.mockImplementation(() =>
          createMockProcessWithPhaseOutput({
            exitCode: 0,
            stdoutChunks: [
              "\u23F3 spec\n", // missing (N/M)
              "random noise\n",
              "\u23F3     exec (2/3)...\n", // valid
            ],
          }),
        );

        const result = await client.callTool(
          { name: "sequant_run", arguments: { issues: [421] } },
          undefined,
          {
            onprogress: (evt: ProgressEvent) => {
              progressEvents.push(evt);
            },
            timeout: 10000,
          },
        );

        await new Promise((r) => setTimeout(r, 50));

        expect(result.isError).toBeFalsy();
        // Only the valid line should trigger a notification
        expect(progressEvents).toHaveLength(1);
      });

      it("should handle concurrent runs with separate progress tracking", async () => {
        const events1: ProgressEvent[] = [];
        const events2: ProgressEvent[] = [];

        mockedSpawn.mockImplementation(() =>
          createMockProcessWithPhaseOutput({
            exitCode: 0,
            stdoutChunks: ["\u23F3     spec (1/3)...\n"],
          }),
        );

        // Fire both runs concurrently
        const [result1, result2] = await Promise.all([
          client.callTool(
            { name: "sequant_run", arguments: { issues: [100] } },
            undefined,
            {
              onprogress: (evt: ProgressEvent) => {
                events1.push(evt);
              },
              timeout: 10000,
            },
          ),
          client.callTool(
            { name: "sequant_run", arguments: { issues: [200] } },
            undefined,
            {
              onprogress: (evt: ProgressEvent) => {
                events2.push(evt);
              },
              timeout: 10000,
            },
          ),
        ]);

        await new Promise((r) => setTimeout(r, 50));

        expect(result1.isError).toBeFalsy();
        expect(result2.isError).toBeFalsy();
        expect(events1.length).toBeGreaterThanOrEqual(1);
        expect(events2.length).toBeGreaterThanOrEqual(1);
      });
    });
  },
);
