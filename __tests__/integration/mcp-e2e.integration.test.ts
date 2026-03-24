// @tautology-skip: E2E tests exercise production code via real protocol connections
/**
 * E2E integration tests for MCP Server with real protocol clients
 * Issue #414: MCP server E2E tests with real protocol client
 *
 * Tests the full path: Real MCP Client → protocol → sequant serve → handler → response
 * Complements existing unit tests (src/mcp/*.test.ts) and integration tests
 * (mcp-serve*.integration.test.ts) which use mocks or InMemoryTransport.
 */

import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as net from "net";
import * as os from "os";

// AC-9: SDK optional guard — skip cleanly when SDK not installed (#396)
const mcpSdkAvailable = await import("@modelcontextprotocol/sdk/server/mcp.js")
  .then(() => true)
  .catch(() => false);

const TEST_DIR = path.join(
  os.tmpdir(),
  `sequant-mcp-e2e-${process.pid}-${Date.now()}`,
);

// Track clients for cleanup (StdioClientTransport spawns internal processes)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const activeClients: any[] = [];

// Track manually spawned server processes for cleanup
const spawnedProcesses: ChildProcess[] = [];

function getAvailablePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
  });
}

function waitForServer(port: number, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      http
        .get(`http://localhost:${port}/health`, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            retry();
          }
        })
        .on("error", retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(
          new Error(
            `Server on port ${port} did not start within ${timeoutMs}ms`,
          ),
        );
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
}

function httpGet(url: string): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body, headers: res.headers }),
        );
      })
      .on("error", reject);
  });
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    process.kill(-child.pid!, signal);
  } catch {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

function spawnServe(args: string[]): ChildProcess {
  // Inline import to avoid top-level side effects when SDK missing
  const { spawn } = require("child_process");
  const binPath = path.resolve(__dirname, "../../bin/cli.ts");
  const child = spawn("npx", ["tsx", binPath, "serve", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    detached: true,
  });
  spawnedProcesses.push(child);
  return child;
}

// AC-10: Use temp directories for isolation — no writes to real .sequant/
beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  // Close any active SDK clients
  for (const client of activeClients) {
    try {
      await client.close();
    } catch {
      /* client may already be disconnected */
    }
  }
  activeClients.length = 0;

  // Kill any manually spawned server processes
  for (const proc of spawnedProcesses) {
    killProcessGroup(proc, "SIGKILL");
  }
  spawnedProcesses.length = 0;
});

afterAll(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe.skipIf(!mcpSdkAvailable)("MCP Server — E2E (#414)", () => {
  // ─── Helpers ───────────────────────────────────────────────────────

  /** Create an SDK client connected via stdio transport */
  async function createStdioClient() {
    const { Client } =
      await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } =
      await import("@modelcontextprotocol/sdk/client/stdio.js");

    const binPath = path.resolve(__dirname, "../../bin/cli.ts");
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", binPath, "serve", "--transport", "stdio"],
      env: { ...process.env, HOME: TEST_DIR },
    });

    const client = new Client({ name: "e2e-stdio", version: "1.0.0" });
    await client.connect(transport);
    activeClients.push(client);
    return client;
  }

  /** Create an SDK client connected via SSE transport to a running server */
  async function createSseClient(port: number) {
    const { Client } =
      await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } =
      await import("@modelcontextprotocol/sdk/client/sse.js");

    const transport = new SSEClientTransport(
      new URL(`http://localhost:${port}/sse`),
    );
    const client = new Client({ name: "e2e-sse", version: "1.0.0" });
    await client.connect(transport);
    activeClients.push(client);
    return client;
  }

  // ─── Stdio E2E ─────────────────────────────────────────────────────

  describe("Stdio E2E", () => {
    // AC-1: Tool discovery via real stdio protocol
    it("AC-1: should discover all tools via stdio protocol", async () => {
      const client = await createStdioClient();

      const { tools } = await client.listTools();
      const toolNames = tools.map((t: { name: string }) => t.name).sort();
      expect(toolNames).toEqual([
        "sequant_logs",
        "sequant_run",
        "sequant_status",
      ]);

      // Each tool should have a valid input schema
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    }, 20000);

    // AC-2: Resource discovery via real stdio protocol
    it("AC-2: should discover resources via stdio protocol", async () => {
      const client = await createStdioClient();

      const { resources } = await client.listResources();
      const uris = resources.map((r: { uri: string }) => r.uri).sort();
      expect(uris).toEqual(["sequant://config", "sequant://state"]);
    }, 20000);

    // AC-3: Tool call round-trip via real stdio protocol
    it("AC-3: should round-trip sequant_status call via stdio", async () => {
      const client = await createStdioClient();

      const result = await client.callTool({
        name: "sequant_status",
        arguments: { issue: 99999 },
      });

      // Should get a well-formed MCP response (not a protocol error)
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);

      // Response should contain parseable JSON with not_tracked status
      const textContent = result.content.find(
        (c: { type: string }) => c.type === "text",
      );
      expect(textContent).toBeDefined();
      const data = JSON.parse(textContent.text);
      expect(data.status).toBe("not_tracked");
    }, 20000);

    // AC-4: Resource read round-trip via real stdio protocol
    it("AC-4: should round-trip sequant://config read via stdio", async () => {
      const client = await createStdioClient();

      const result = await client.readResource({
        uri: "sequant://config",
      });

      // Should get valid content without protocol error
      expect(result).toBeDefined();
      expect(result.contents).toBeDefined();
      expect(Array.isArray(result.contents)).toBe(true);
      expect(result.contents.length).toBeGreaterThan(0);

      const content = result.contents[0];
      expect(content.uri).toBe("sequant://config");
      expect(typeof content.text).toBe("string");

      // Content should be parseable JSON (settings or default)
      expect(() => JSON.parse(content.text as string)).not.toThrow();
    }, 20000);
  });

  // ─── SSE E2E ───────────────────────────────────────────────────────

  describe("SSE E2E", () => {
    // AC-5: SSE client connection and tool call via SDK
    it("AC-5: should connect SDK client and call tool via SSE", async () => {
      const port = await getAvailablePort();
      spawnServe(["--transport", "sse", "--port", String(port)]);
      await waitForServer(port);

      const client = await createSseClient(port);

      // Verify all tools are listed
      const { tools } = await client.listTools();
      const toolNames = tools.map((t: { name: string }) => t.name).sort();
      expect(toolNames).toEqual([
        "sequant_logs",
        "sequant_run",
        "sequant_status",
      ]);

      // Call sequant_status and verify full round-trip
      const result = await client.callTool({
        name: "sequant_status",
        arguments: { issue: 99999 },
      });
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();

      const textContent = result.content.find(
        (c: { type: string }) => c.type === "text",
      );
      expect(textContent).toBeDefined();
      const data = JSON.parse(textContent.text);
      expect(data.status).toBe("not_tracked");
    }, 20000);

    // AC-6: Health endpoint reports connected during SDK session
    it("AC-6: should report connected: true during active SDK connection", async () => {
      const port = await getAvailablePort();
      spawnServe(["--transport", "sse", "--port", String(port)]);
      await waitForServer(port);

      const client = await createSseClient(port);

      // Health should report connected: true while SDK client is active
      const { body } = await httpGet(`http://localhost:${port}/health`);
      const health = JSON.parse(body);
      expect(health).toEqual({
        status: "ok",
        transport: "sse",
        connected: true,
      });

      // Verify the client is functional (not just connected at HTTP level)
      const { tools } = await client.listTools();
      expect(tools.length).toBe(3);
    }, 20000);

    // AC-7: Multi-client rejection with SDK transport
    it("AC-7: should reject second SSE client connection", async () => {
      const port = await getAvailablePort();
      spawnServe(["--transport", "sse", "--port", String(port)]);
      await waitForServer(port);

      // First client connects successfully via SDK
      const client1 = await createSseClient(port);
      const { tools } = await client1.listTools();
      expect(tools.length).toBe(3);

      // Second connection attempt should receive 409
      const httpRes = await httpGet(`http://localhost:${port}/sse`);
      expect(httpRes.status).toBe(409);
      const errorBody = JSON.parse(httpRes.body);
      expect(errorBody.error).toBe("conflict");
      expect(errorBody.message).toContain("already connected");

      // SDK SSEClientTransport should also fail to connect
      const { SSEClientTransport } =
        await import("@modelcontextprotocol/sdk/client/sse.js");
      const { Client } =
        await import("@modelcontextprotocol/sdk/client/index.js");

      const transport2 = new SSEClientTransport(
        new URL(`http://localhost:${port}/sse`),
      );
      const client2 = new Client({
        name: "e2e-sse-rejected",
        version: "1.0.0",
      });

      await expect(
        Promise.race([
          client2.connect(transport2),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Expected connection rejection")),
              5000,
            ),
          ),
        ]),
      ).rejects.toThrow();

      // Clean up second client attempt
      try {
        await client2.close();
      } catch {
        /* expected — never fully connected */
      }
    }, 25000);
  });

  // ─── Graceful Shutdown ─────────────────────────────────────────────

  describe("Graceful shutdown", () => {
    // AC-8: SIGTERM causes clean disconnect
    it("AC-8: should disconnect SSE client cleanly on SIGTERM", async () => {
      const port = await getAvailablePort();
      const serverProcess = spawnServe([
        "--transport",
        "sse",
        "--port",
        String(port),
      ]);

      // Capture server stderr for protocol error detection
      const stderrChunks: string[] = [];
      serverProcess.stderr?.on("data", (chunk: Buffer) =>
        stderrChunks.push(chunk.toString()),
      );

      await waitForServer(port);

      const client = await createSseClient(port);

      // Verify client is functional
      const { tools } = await client.listTools();
      expect(tools.length).toBe(3);

      // Send SIGTERM to server process group
      const exitPromise = new Promise<number | null>((resolve) => {
        serverProcess.on("exit", (code) => resolve(code));
      });
      killProcessGroup(serverProcess, "SIGTERM");

      // Server should exit cleanly
      const exitCode = await exitPromise;
      expect(exitCode === 0 || exitCode === null).toBe(true);

      // No protocol-level errors in server stderr
      // (broken pipe or JSON parse errors indicate unclean shutdown)
      const stderr = stderrChunks.join("");
      expect(stderr).not.toMatch(/broken pipe/i);
      expect(stderr).not.toMatch(/EPIPE/i);
      expect(stderr).not.toMatch(/JSON.*parse|parse.*JSON/i);
    }, 25000);
  });
});
