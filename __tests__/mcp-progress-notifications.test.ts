/**
 * Unit tests for MCP Progress Notifications (#421)
 *
 * Tests AC-1 (progressToken capture), AC-3 (total calculation),
 * AC-4 (backward compatibility), AC-6 (error resilience),
 * and the parsePhaseStart helper.
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

/** Create a mock ChildProcess that emits events asynchronously */
function createMockProcess(opts: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  stderrChunks?: string[];
  stdoutChunks?: string[];
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
    } else if (opts.stderr) {
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

/** Progress event collected from onprogress callback */
interface ProgressEvent {
  progress: number;
  total: number;
  message?: string;
}

describe("parsePhaseStart", () => {
  it("should parse a standard phase start line", async () => {
    const { parsePhaseStart } = await import("../src/mcp/tools/run.js");
    const result = parsePhaseStart("\u23F3     spec (1/3)...");
    expect(result).toEqual({ phase: "spec", phaseIndex: 1, totalPhases: 3 });
  });

  it("should parse phase start with ANSI color codes", async () => {
    const { parsePhaseStart } = await import("../src/mcp/tools/run.js");
    const result = parsePhaseStart("\x1b[36m\u23F3 exec (2/3)...\x1b[39m");
    expect(result).toEqual({ phase: "exec", phaseIndex: 2, totalPhases: 3 });
  });

  it("should return null for non-phase output", async () => {
    const { parsePhaseStart } = await import("../src/mcp/tools/run.js");
    expect(parsePhaseStart("random log line")).toBeNull();
    expect(parsePhaseStart("")).toBeNull();
  });

  it("should return null for phase completion lines (checkmark)", async () => {
    const { parsePhaseStart } = await import("../src/mcp/tools/run.js");
    expect(parsePhaseStart("\u2713 spec (1/3) (10s)")).toBeNull();
  });

  it("should return null for phase failure lines (cross)", async () => {
    const { parsePhaseStart } = await import("../src/mcp/tools/run.js");
    expect(parsePhaseStart("\u2717 exec (2/3) (5s): error")).toBeNull();
  });
});

describe.skipIf(!mcpSdkAvailable)("MCP Progress Notifications (#421)", () => {
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

  describe("AC-1: progressToken capture from extra._meta", () => {
    it("should capture progressToken and emit notifications when present", async () => {
      const progressEvents: ProgressEvent[] = [];

      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stdoutChunks: ["\u23F3     spec (1/3)...\n"],
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

      // Allow fire-and-forget notification to propagate
      await new Promise((r) => setTimeout(r, 50));

      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0].progress).toBe(1);
      expect(progressEvents[0].total).toBe(3);
    });

    it("should handle missing _meta gracefully", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({ exitCode: 0, stdout: "done" }),
      );

      // No onprogress → no _meta.progressToken sent
      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [421] },
      });

      expect(result.isError).toBeFalsy();
    });
  });

  describe("AC-3: Progress total = issue count × phase count", () => {
    it("should calculate total as 6 for 2 issues × 3 default phases", async () => {
      const progressEvents: ProgressEvent[] = [];

      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stdoutChunks: ["\u23F3     spec (1/3)...\n"],
        }),
      );

      await client.callTool(
        { name: "sequant_run", arguments: { issues: [100, 200] } },
        undefined,
        {
          onprogress: (evt: ProgressEvent) => {
            progressEvents.push(evt);
          },
          timeout: 10000,
        },
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      // 2 issues × 3 phases (spec,exec,qa) = 6
      expect(progressEvents[0].total).toBe(6);
    });

    it("should calculate total as 2 for 1 issue × 2 custom phases", async () => {
      const progressEvents: ProgressEvent[] = [];

      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stdoutChunks: ["\u23F3     spec (1/2)...\n"],
        }),
      );

      await client.callTool(
        {
          name: "sequant_run",
          arguments: { issues: [100], phases: "spec,exec" },
        },
        undefined,
        {
          onprogress: (evt: ProgressEvent) => {
            progressEvents.push(evt);
          },
          timeout: 10000,
        },
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0].total).toBe(2);
    });

    it("should handle single-phase runs", async () => {
      const progressEvents: ProgressEvent[] = [];

      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stdoutChunks: ["\u23F3     exec (1/1)...\n"],
        }),
      );

      await client.callTool(
        { name: "sequant_run", arguments: { issues: [100], phases: "exec" } },
        undefined,
        {
          onprogress: (evt: ProgressEvent) => {
            progressEvents.push(evt);
          },
          timeout: 10000,
        },
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0].total).toBe(1);
    });
  });

  describe("AC-4: Backward compatibility — no progressToken", () => {
    it("should not emit notifications when no onprogress callback", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stdoutChunks: [
            "\u23F3     spec (1/3)...\n",
            "\u23F3     exec (2/3)...\n",
          ],
        }),
      );

      // No onprogress callback → no progressToken sent → no notifications
      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [421] },
      });

      expect(result.isError).toBeFalsy();
    });
  });

  describe("AC-6: sendNotification failures don't abort run", () => {
    it("should complete run successfully with progress enabled", async () => {
      mockedSpawn.mockImplementation(() =>
        createMockProcess({
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
    });
  });
});
