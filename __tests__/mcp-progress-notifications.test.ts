/**
 * Unit tests for MCP Progress Notifications (#421)
 *
 * Tests AC-1 (progressToken capture), AC-3 (total calculation),
 * AC-4 (backward compatibility), AC-6 (error resilience),
 * and the parseProgressLine / createLineBuffer helpers.
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
interface ProgressNotification {
  progress: number;
  total: number;
  message?: string;
}

/** Helper: build a SEQUANT_PROGRESS line as the batch executor emits it */
function progressLine(issue: number, phase: string): string {
  return `SEQUANT_PROGRESS:${JSON.stringify({ issue, phase })}\n`;
}

describe("parseProgressLine", () => {
  it("should parse a valid progress line", async () => {
    const { parseProgressLine } = await import("../src/mcp/tools/run.js");
    const result = parseProgressLine(
      'SEQUANT_PROGRESS:{"issue":123,"phase":"spec"}',
    );
    expect(result).toEqual({ issue: 123, phase: "spec" });
  });

  it("should return null for non-progress lines", async () => {
    const { parseProgressLine } = await import("../src/mcp/tools/run.js");
    expect(parseProgressLine("random log line")).toBeNull();
    expect(parseProgressLine("")).toBeNull();
    expect(parseProgressLine("SEQUANT_OTHER:{}")).toBeNull();
  });

  it("should return null for malformed JSON", async () => {
    const { parseProgressLine } = await import("../src/mcp/tools/run.js");
    expect(parseProgressLine("SEQUANT_PROGRESS:{bad json}")).toBeNull();
  });

  it("should return null for JSON missing required fields", async () => {
    const { parseProgressLine } = await import("../src/mcp/tools/run.js");
    expect(parseProgressLine('SEQUANT_PROGRESS:{"issue":123}')).toBeNull();
    expect(parseProgressLine('SEQUANT_PROGRESS:{"phase":"spec"}')).toBeNull();
    expect(
      parseProgressLine(
        'SEQUANT_PROGRESS:{"issue":"not-a-number","phase":"spec"}',
      ),
    ).toBeNull();
  });
});

describe("createLineBuffer", () => {
  it("should yield complete lines", async () => {
    const { createLineBuffer } = await import("../src/mcp/tools/run.js");
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));

    buffer("line1\nline2\n");
    expect(lines).toEqual(["line1", "line2"]);
  });

  it("should buffer incomplete lines across chunks", async () => {
    const { createLineBuffer } = await import("../src/mcp/tools/run.js");
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));

    buffer("partial");
    expect(lines).toEqual([]);

    buffer(" complete\n");
    expect(lines).toEqual(["partial complete"]);
  });

  it("should handle multiple chunks building one line", async () => {
    const { createLineBuffer } = await import("../src/mcp/tools/run.js");
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));

    buffer("SEQUANT_");
    buffer("PROGRESS:");
    buffer('{"issue":1,"phase":"spec"}\n');

    expect(lines).toEqual(['SEQUANT_PROGRESS:{"issue":1,"phase":"spec"}']);
  });

  it("should skip empty lines", async () => {
    const { createLineBuffer } = await import("../src/mcp/tools/run.js");
    const lines: string[] = [];
    const buffer = createLineBuffer((line) => lines.push(line));

    buffer("line1\n\nline2\n");
    expect(lines).toEqual(["line1", "line2"]);
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
      const progressEvents: ProgressNotification[] = [];

      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stderrChunks: [progressLine(421, "spec")],
        }),
      );

      await client.callTool(
        { name: "sequant_run", arguments: { issues: [421] } },
        undefined,
        {
          onprogress: (evt: ProgressNotification) => {
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

  describe("AC-2: Issue number from structured progress lines", () => {
    it("should include correct issue number from progress event", async () => {
      const messages: string[] = [];

      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stderrChunks: [progressLine(421, "spec")],
        }),
      );

      await client.callTool(
        { name: "sequant_run", arguments: { issues: [421] } },
        undefined,
        {
          onprogress: (evt: ProgressNotification) => {
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

    it("should attribute correct issue numbers in parallel runs", async () => {
      const messages: string[] = [];

      // Simulate parallel interleaved output: issue 100 spec, issue 200 spec, issue 100 exec
      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stderrChunks: [
            progressLine(100, "spec"),
            progressLine(200, "spec"),
            progressLine(100, "exec"),
          ],
        }),
      );

      await client.callTool(
        { name: "sequant_run", arguments: { issues: [100, 200] } },
        undefined,
        {
          onprogress: (evt: ProgressNotification) => {
            if (evt.message) messages.push(evt.message);
          },
          timeout: 10000,
        },
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(3);
      expect(messages[0]).toContain("100");
      expect(messages[0]).toContain("spec");
      expect(messages[1]).toContain("200");
      expect(messages[1]).toContain("spec");
      expect(messages[2]).toContain("100");
      expect(messages[2]).toContain("exec");
    });
  });

  describe("AC-3: Progress total = issue count × phase count", () => {
    it("should calculate total as 6 for 2 issues × 3 default phases", async () => {
      const progressEvents: ProgressNotification[] = [];

      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stderrChunks: [progressLine(100, "spec")],
        }),
      );

      await client.callTool(
        { name: "sequant_run", arguments: { issues: [100, 200] } },
        undefined,
        {
          onprogress: (evt: ProgressNotification) => {
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
      const progressEvents: ProgressNotification[] = [];

      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stderrChunks: [progressLine(100, "spec")],
        }),
      );

      await client.callTool(
        {
          name: "sequant_run",
          arguments: { issues: [100], phases: "spec,exec" },
        },
        undefined,
        {
          onprogress: (evt: ProgressNotification) => {
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
      const progressEvents: ProgressNotification[] = [];

      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stderrChunks: [progressLine(100, "exec")],
        }),
      );

      await client.callTool(
        { name: "sequant_run", arguments: { issues: [100], phases: "exec" } },
        undefined,
        {
          onprogress: (evt: ProgressNotification) => {
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
          stderrChunks: [progressLine(421, "spec"), progressLine(421, "exec")],
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
          stderrChunks: [
            progressLine(421, "spec"),
            progressLine(421, "exec"),
            progressLine(421, "qa"),
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

  describe("Line buffering (chunk boundary safety)", () => {
    it("should handle progress line split across stderr chunks", async () => {
      const progressEvents: ProgressNotification[] = [];

      const fullLine = `SEQUANT_PROGRESS:{"issue":421,"phase":"spec"}\n`;
      const split1 = fullLine.slice(0, 20);
      const split2 = fullLine.slice(20);

      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stderrChunks: [split1, split2],
        }),
      );

      await client.callTool(
        { name: "sequant_run", arguments: { issues: [421] } },
        undefined,
        {
          onprogress: (evt: ProgressNotification) => {
            progressEvents.push(evt);
          },
          timeout: 10000,
        },
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].progress).toBe(1);
    });

    it("should handle multiple progress lines in one chunk", async () => {
      const progressEvents: ProgressNotification[] = [];

      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stderrChunks: [
            progressLine(421, "spec") +
              progressLine(421, "exec") +
              progressLine(421, "qa"),
          ],
        }),
      );

      await client.callTool(
        { name: "sequant_run", arguments: { issues: [421] } },
        undefined,
        {
          onprogress: (evt: ProgressNotification) => {
            progressEvents.push(evt);
          },
          timeout: 10000,
        },
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(progressEvents).toHaveLength(3);
      expect(progressEvents.map((e) => e.progress)).toEqual([1, 2, 3]);
    });

    it("should ignore non-progress stderr lines", async () => {
      const progressEvents: ProgressNotification[] = [];

      mockedSpawn.mockImplementation(() =>
        createMockProcess({
          exitCode: 0,
          stderrChunks: [
            "some warning\n" + progressLine(421, "spec") + "another warning\n",
          ],
        }),
      );

      await client.callTool(
        { name: "sequant_run", arguments: { issues: [421] } },
        undefined,
        {
          onprogress: (evt: ProgressNotification) => {
            progressEvents.push(evt);
          },
          timeout: 10000,
        },
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(progressEvents).toHaveLength(1);
    });
  });
});
