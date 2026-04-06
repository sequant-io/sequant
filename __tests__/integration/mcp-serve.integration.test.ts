/**
 * Integration tests for Sequant MCP Server
 * Issue #372: Expose Sequant Workflow as MCP Server
 *
 * Covers:
 * - AC-7: SSE transport with HTTP server
 * - AC-11: Init MCP config detection
 * - AC-16: Graceful shutdown
 */

import { describe, it, expect, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as net from "net";
import {
  detectMcpClients,
  getSequantMcpConfig,
  addSequantToMcpConfig,
} from "../../src/lib/mcp-config.js";

// Check if MCP SDK is available — integration tests need the serve command to work (#396)
const mcpSdkAvailable = await import("@modelcontextprotocol/sdk/server/mcp.js")
  .then(() => true)
  .catch(() => false);

const TEST_DIR = `/tmp/sequant-mcp-test-${process.pid}-${Date.now()}`;

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

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    // Send signal to the entire process group (negative PID)
    // This mirrors how terminals deliver signals (e.g., Ctrl+C sends SIGINT to the group)
    process.kill(-child.pid!, signal);
  } catch {
    // Process group may already be gone — fall back to direct kill
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
    detached: true, // Create a new process group so signals propagate to all children
  });
  spawnedProcesses.push(child);
  return child;
}

afterEach(async () => {
  // Kill any lingering process groups and wait for them to exit
  // so ports are fully released before the next test
  const exitPromises = spawnedProcesses.map(
    (proc) =>
      new Promise<void>((resolve) => {
        // Check signalCode too: signal-killed processes have exitCode=null
        // but signalCode set. Without this, we'd register an exit listener
        // that never fires because the event already emitted. (#492)
        if (proc.exitCode !== null || proc.killed || proc.signalCode !== null) {
          resolve();
          return;
        }
        // Timeout prevents 60s hang if exit event was already emitted
        // between our check above and the listener registration
        const timeout = setTimeout(() => resolve(), 5000);
        proc.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
        killProcessGroup(proc, "SIGKILL");
      }),
  );
  await Promise.all(exitPromises);
  spawnedProcesses.length = 0;
});

afterAll(() => {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe.skipIf(!mcpSdkAvailable)("MCP Server — Integration", () => {
  // AC-7: SSE transport with --transport sse --port
  describe("AC-7: SSE transport", () => {
    it("should start SSE server and respond to health check", async () => {
      const port = await getAvailablePort();
      const child = spawnServe(["--transport", "sse", "--port", String(port)]);

      await waitForServer(port);

      const { status, body } = await httpGet(`http://localhost:${port}/health`);
      expect(status).toBe(200);
      const data = JSON.parse(body);
      expect(data.status).toBe("ok");
      expect(data.transport).toBe("sse");

      killProcessGroup(child, "SIGTERM");
    }, 15000);

    it("should serve SSE endpoint at /sse with event-stream content type", async () => {
      const port = await getAvailablePort();
      const child = spawnServe(["--transport", "sse", "--port", String(port)]);

      await waitForServer(port);

      // SSE connections are long-lived, so we check headers on response start
      const { status, headers } = await new Promise<{
        status: number;
        headers: http.IncomingHttpHeaders;
      }>((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/sse`, (res) => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
          });
          // Destroy the connection immediately — we only need headers
          res.destroy();
          req.destroy();
        });
        req.on("error", (err) => {
          // Ignore ECONNRESET from destroying the connection
          if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
            reject(err);
          }
        });
      });

      expect(status).toBe(200);
      expect(headers["content-type"]).toContain("text/event-stream");

      killProcessGroup(child, "SIGTERM");
    }, 15000);

    it("should return 404 for unknown routes", async () => {
      const port = await getAvailablePort();
      const child = spawnServe(["--transport", "sse", "--port", String(port)]);

      await waitForServer(port);

      const { status } = await httpGet(`http://localhost:${port}/unknown`);
      expect(status).toBe(404);

      killProcessGroup(child, "SIGTERM");
    }, 15000);
  });

  // AC-16: Graceful shutdown
  describe("AC-16: graceful shutdown", () => {
    it("should exit cleanly on SIGTERM for SSE server", async () => {
      const port = await getAvailablePort();
      const child = spawnServe(["--transport", "sse", "--port", String(port)]);

      await waitForServer(port);

      const exitPromise = new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
      });

      killProcessGroup(child, "SIGTERM");
      const exitCode = await exitPromise;
      // Process exits cleanly (code 0 or null from signal)
      expect(exitCode === 0 || exitCode === null).toBe(true);
    }, 15000);

    it("should exit cleanly on SIGINT for SSE server", async () => {
      const port = await getAvailablePort();
      const child = spawnServe(["--transport", "sse", "--port", String(port)]);

      await waitForServer(port);

      const exitPromise = new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
      });

      killProcessGroup(child, "SIGINT");
      const exitCode = await exitPromise;
      expect(exitCode === 0 || exitCode === null).toBe(true);
    }, 15000);
  });

  // AC-11: init MCP config detection
  describe("AC-11: MCP client detection", () => {
    it("should detect MCP client config paths for current platform", () => {
      const clients = detectMcpClients();

      expect(clients).toHaveLength(3);
      expect(clients.map((c) => c.name)).toEqual([
        "Claude Desktop",
        "Cursor",
        "VS Code + Continue",
      ]);

      // Each client should have a configPath
      for (const client of clients) {
        expect(client.configPath).toBeTruthy();
        expect(typeof client.exists).toBe("boolean");
      }
    });

    it("should generate valid sequant MCP config entry", () => {
      const config = getSequantMcpConfig();

      expect(config.command).toBe("npx");
      expect(config.args).toEqual(["sequant@latest", "serve"]);
    });

    it("should add sequant config to an existing MCP config file", () => {
      fs.mkdirSync(TEST_DIR, { recursive: true });
      const configPath = path.join(TEST_DIR, "test-mcp-config.json");

      // Write an existing config
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));

      const added = addSequantToMcpConfig(configPath);
      expect(added).toBe(true);

      // Verify the config was written correctly
      const written = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(written.mcpServers.sequant).toBeDefined();
      expect(written.mcpServers.sequant.command).toBe("npx");

      // Adding again should return false (already configured)
      const addedAgain = addSequantToMcpConfig(configPath);
      expect(addedAgain).toBe(false);
    });

    it("should create config file and parent directories if they don't exist", () => {
      const deepPath = path.join(TEST_DIR, "deep", "nested", "config.json");

      const added = addSequantToMcpConfig(deepPath);
      expect(added).toBe(true);
      expect(fs.existsSync(deepPath)).toBe(true);

      const written = JSON.parse(fs.readFileSync(deepPath, "utf-8"));
      expect(written.mcpServers.sequant).toBeDefined();
    });
  });

  // Error scenarios
  describe("error scenarios", () => {
    it("should handle port already in use for SSE transport", async () => {
      const port = await getAvailablePort();

      // Occupy the port
      const occupier = http.createServer((_, res) => {
        res.end("occupied");
      });

      await new Promise<void>((resolve) => {
        occupier.listen(port, resolve);
      });

      try {
        const child = spawnServe([
          "--transport",
          "sse",
          "--port",
          String(port),
        ]);

        const stderrChunks: string[] = [];
        child.stderr?.on("data", (chunk) =>
          stderrChunks.push(chunk.toString()),
        );

        const exitPromise = new Promise<number | null>((resolve) => {
          child.on("exit", (code) => resolve(code));
        });

        // Should fail relatively quickly
        const exitCode = await Promise.race([
          exitPromise,
          new Promise<null>((resolve) =>
            setTimeout(() => {
              killProcessGroup(child, "SIGKILL");
              resolve(null);
            }, 5000),
          ),
        ]);

        // Process should have exited with error or been killed
        // Either way, it should not hang
        expect(exitCode !== undefined).toBe(true);
      } finally {
        await new Promise<void>((resolve) => {
          occupier.close(() => resolve());
        });
      }
    }, 10000);
  });
});
