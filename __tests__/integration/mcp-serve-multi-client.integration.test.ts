/**
 * Integration tests for MCP Server SSE multi-client handling
 * Issue #390: SSE Transport Improvements — Multi-Client
 *
 * Covers:
 * - AC-1: Second SSE connection rejected with 409 Conflict
 * - AC-3: Health endpoint reports connection status
 * - AC-4: Multi-client scenario test coverage
 * - AC-5: Disconnect cleanup (sseTransport nulled on close)
 */

import { describe, it, expect, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as path from "path";

// Check if MCP SDK is available — integration tests need the serve command to work (#396)
const mcpSdkAvailable = await import("@modelcontextprotocol/sdk/server/mcp.js")
  .then(() => true)
  .catch(() => false);

const TEST_DIR = `/tmp/sequant-mcp-multi-client-test-${process.pid}-${Date.now()}`;

// Track spawned processes for cleanup
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

function waitForServer(port: number, timeoutMs = 10000): Promise<void> {
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
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body, headers: res.headers }),
        );
      })
      .on("error", reject);
  });
}

/**
 * Open an SSE connection and return the response (long-lived).
 * Caller must destroy the request when done.
 */
function openSseConnection(
  port: number,
): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}/sse`, (res) => {
      resolve({ req, res });
    });
    req.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        reject(err);
      }
    });
  });
}

/** Helper to wait for a brief period (ms). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const binPath = path.resolve(__dirname, "../../bin/cli.ts");
  const child = spawn("npx", ["tsx", binPath, "serve", ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    detached: true,
  });
  spawnedProcesses.push(child);
  return child;
}

afterEach(() => {
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

describe.skipIf(!mcpSdkAvailable)(
  "MCP Server — Multi-Client SSE (#390)",
  () => {
    // AC-1: Second SSE connection handling — reject with 409 Conflict
    describe("AC-1: Second SSE connection rejected with 409", () => {
      it("should reject a second SSE client with 409 Conflict", async () => {
        const port = await getAvailablePort();
        const child = spawnServe([
          "--transport",
          "sse",
          "--port",
          String(port),
        ]);
        await waitForServer(port);

        // Connect first SSE client
        const first = await openSseConnection(port);
        expect(first.res.statusCode).toBe(200);

        // Second client should be rejected with 409
        const second = await httpGet(`http://localhost:${port}/sse`);
        expect(second.status).toBe(409);

        const body = JSON.parse(second.body);
        expect(body.error).toBe("conflict");
        expect(body.message).toContain("already connected");

        // Cleanup
        first.req.destroy();
        killProcessGroup(child, "SIGTERM");
      }, 15000);

      describe("error handling", () => {
        it("should allow a new client after the first disconnects", async () => {
          const port = await getAvailablePort();
          const child = spawnServe([
            "--transport",
            "sse",
            "--port",
            String(port),
          ]);
          await waitForServer(port);

          // Connect first client, then disconnect
          const first = await openSseConnection(port);
          expect(first.res.statusCode).toBe(200);
          first.req.destroy();

          // Wait for server to detect disconnect
          await delay(500);

          // New client should be accepted
          const second = await openSseConnection(port);
          expect(second.res.statusCode).toBe(200);

          // Cleanup
          second.req.destroy();
          killProcessGroup(child, "SIGTERM");
        }, 15000);

        it("should return proper JSON error body on 409 rejection", async () => {
          const port = await getAvailablePort();
          const child = spawnServe([
            "--transport",
            "sse",
            "--port",
            String(port),
          ]);
          await waitForServer(port);

          // Connect first client
          const first = await openSseConnection(port);
          expect(first.res.statusCode).toBe(200);

          // Second client gets 409 with well-formed JSON
          const second = await httpGet(`http://localhost:${port}/sse`);
          expect(second.status).toBe(409);

          const body = JSON.parse(second.body);
          expect(body).toHaveProperty("error", "conflict");
          expect(body).toHaveProperty("message");
          expect(typeof body.message).toBe("string");
          expect(body.message.length).toBeGreaterThan(0);

          // Cleanup
          first.req.destroy();
          killProcessGroup(child, "SIGTERM");
        }, 15000);
      });
    });

    // AC-3: Health endpoint reports connection status
    describe("AC-3: Health endpoint reports connection status", () => {
      it("should report connected: false before any client connects", async () => {
        const port = await getAvailablePort();
        const child = spawnServe([
          "--transport",
          "sse",
          "--port",
          String(port),
        ]);
        await waitForServer(port);

        const health = await httpGet(`http://localhost:${port}/health`);
        expect(health.status).toBe(200);

        const body = JSON.parse(health.body);
        expect(body).toEqual({
          status: "ok",
          transport: "sse",
          connected: false,
        });

        killProcessGroup(child, "SIGTERM");
      }, 15000);

      it("should report connected: true after a client connects", async () => {
        const port = await getAvailablePort();
        const child = spawnServe([
          "--transport",
          "sse",
          "--port",
          String(port),
        ]);
        await waitForServer(port);

        // Connect a client
        const first = await openSseConnection(port);
        expect(first.res.statusCode).toBe(200);

        const health = await httpGet(`http://localhost:${port}/health`);
        const body = JSON.parse(health.body);
        expect(body.connected).toBe(true);

        // Cleanup
        first.req.destroy();
        killProcessGroup(child, "SIGTERM");
      }, 15000);

      it("should report connected: false after client disconnects", async () => {
        const port = await getAvailablePort();
        const child = spawnServe([
          "--transport",
          "sse",
          "--port",
          String(port),
        ]);
        await waitForServer(port);

        // Connect then disconnect
        const first = await openSseConnection(port);
        expect(first.res.statusCode).toBe(200);
        first.req.destroy();

        // Wait for server to detect disconnect
        await delay(500);

        const health = await httpGet(`http://localhost:${port}/health`);
        const body = JSON.parse(health.body);
        expect(body.connected).toBe(false);

        killProcessGroup(child, "SIGTERM");
      }, 15000);

      describe("error handling", () => {
        it("should still return valid health JSON when connection state is transitioning", async () => {
          const port = await getAvailablePort();
          const child = spawnServe([
            "--transport",
            "sse",
            "--port",
            String(port),
          ]);
          await waitForServer(port);

          // Rapidly connect and immediately destroy
          const first = await openSseConnection(port);
          first.req.destroy();

          // Immediately check health — should return valid JSON regardless of state
          const health = await httpGet(`http://localhost:${port}/health`);
          expect(health.status).toBe(200);

          const body = JSON.parse(health.body);
          expect(body).toHaveProperty("status", "ok");
          expect(body).toHaveProperty("transport", "sse");
          expect(typeof body.connected).toBe("boolean");

          killProcessGroup(child, "SIGTERM");
        }, 15000);
      });
    });

    // AC-4: Test coverage for multi-client scenarios
    describe("AC-4: Multi-client scenario coverage", () => {
      it("should handle rapid sequential connect attempts", async () => {
        const port = await getAvailablePort();
        const child = spawnServe([
          "--transport",
          "sse",
          "--port",
          String(port),
        ]);
        await waitForServer(port);

        // Connect first client
        const first = await openSseConnection(port);
        expect(first.res.statusCode).toBe(200);

        // Fire 5 rapid concurrent connection attempts
        const attempts = await Promise.all(
          Array.from({ length: 5 }, () =>
            httpGet(`http://localhost:${port}/sse`),
          ),
        );

        // All should be rejected with 409
        for (const attempt of attempts) {
          expect(attempt.status).toBe(409);
        }

        // Server should still be healthy
        const health = await httpGet(`http://localhost:${port}/health`);
        expect(health.status).toBe(200);
        expect(JSON.parse(health.body).connected).toBe(true);

        // Cleanup
        first.req.destroy();
        killProcessGroup(child, "SIGTERM");
      }, 20000);

      it("should handle concurrent connect and disconnect", async () => {
        const port = await getAvailablePort();
        const child = spawnServe([
          "--transport",
          "sse",
          "--port",
          String(port),
        ]);
        await waitForServer(port);

        // Connect, disconnect, reconnect cycle
        const first = await openSseConnection(port);
        expect(first.res.statusCode).toBe(200);
        first.req.destroy();

        await delay(500);

        // After disconnect, a new client should connect fine
        const second = await openSseConnection(port);
        expect(second.res.statusCode).toBe(200);

        // Health should show connected
        const health = await httpGet(`http://localhost:${port}/health`);
        expect(JSON.parse(health.body).connected).toBe(true);

        // Disconnect second, reconnect third
        second.req.destroy();
        await delay(500);

        const third = await openSseConnection(port);
        expect(third.res.statusCode).toBe(200);

        // Server stable after flurry of connections
        const health2 = await httpGet(`http://localhost:${port}/health`);
        expect(health2.status).toBe(200);
        expect(JSON.parse(health2.body).connected).toBe(true);

        // Cleanup
        third.req.destroy();
        killProcessGroup(child, "SIGTERM");
      }, 20000);
    });

    // AC-5: Disconnect cleanup
    describe("AC-5: Disconnect cleanup", () => {
      it("should clean up sseTransport reference when client disconnects", async () => {
        const port = await getAvailablePort();
        const child = spawnServe([
          "--transport",
          "sse",
          "--port",
          String(port),
        ]);
        await waitForServer(port);

        // Connect client
        const first = await openSseConnection(port);
        expect(first.res.statusCode).toBe(200);

        // Disconnect
        first.req.destroy();
        await delay(500);

        // Transport ref should be cleaned up — new client should succeed
        const second = await openSseConnection(port);
        expect(second.res.statusCode).toBe(200);

        // Health should show connected
        const health = await httpGet(`http://localhost:${port}/health`);
        expect(JSON.parse(health.body).connected).toBe(true);

        // Cleanup
        second.req.destroy();
        killProcessGroup(child, "SIGTERM");
      }, 15000);

      describe("error handling", () => {
        it("should handle abrupt client disconnect (network failure)", async () => {
          const port = await getAvailablePort();
          const child = spawnServe([
            "--transport",
            "sse",
            "--port",
            String(port),
          ]);
          await waitForServer(port);

          // Connect and immediately destroy socket (simulate network failure)
          const first = await openSseConnection(port);
          first.res.socket?.destroy();

          // Wait for server to detect the abrupt disconnect
          await delay(1000);

          // Health should show disconnected
          const health = await httpGet(`http://localhost:${port}/health`);
          expect(JSON.parse(health.body).connected).toBe(false);

          // New client should be able to connect
          const second = await openSseConnection(port);
          expect(second.res.statusCode).toBe(200);

          // Cleanup
          second.req.destroy();
          killProcessGroup(child, "SIGTERM");
        }, 15000);
      });
    });
  },
);
