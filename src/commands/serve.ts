/**
 * sequant serve - Start MCP server
 *
 * Exposes Sequant workflow orchestration as tools and resources
 * over the Model Context Protocol (MCP).
 *
 * Supports stdio (default) and SSE transports.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "http";
import { createServer } from "../mcp/server.js";
import { getVersion } from "../lib/version.js";

export interface ServeOptions {
  transport?: "stdio" | "sse";
  port?: number;
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  const version = getVersion();
  const server = createServer(version);
  const transportType = options.transport || "stdio";

  if (transportType === "sse") {
    await startSSE(server, options.port || 3100);
  } else {
    await startStdio(server);
  }
}

async function startStdio(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  const transport = new StdioServerTransport();

  // Handle graceful shutdown
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(transport);

  // Write startup info to stderr (stdout is for MCP protocol)
  process.stderr.write(`Sequant MCP server started (stdio)\n`);
}

async function startSSE(
  server: ReturnType<typeof createServer>,
  port: number,
): Promise<void> {
  let sseTransport: SSEServerTransport | null = null;
  let clientConnected = false;

  const httpServer = createHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname === "/sse" && req.method === "GET") {
        // Reject if a client is already connected
        if (clientConnected) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "conflict",
              message: "Another SSE client is already connected",
            }),
          );
          return;
        }

        // SSE endpoint - create transport and connect
        sseTransport = new SSEServerTransport("/messages", res);
        clientConnected = true;

        // Clean up on client disconnect
        res.on("close", () => {
          clientConnected = false;
          sseTransport = null;
        });

        try {
          await server.connect(sseTransport);
        } catch {
          clientConnected = false;
          sseTransport = null;
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "connection_failed",
                message: "Failed to establish MCP transport connection",
              }),
            );
          }
        }
      } else if (
        url.pathname === "/messages" &&
        req.method === "POST" &&
        sseTransport
      ) {
        // Message endpoint for client-to-server communication
        await sseTransport.handlePostMessage(req, res);
      } else if (url.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            transport: "sse",
            connected: clientConnected,
          }),
        );
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    },
  );

  // Handle graceful shutdown
  const shutdown = async () => {
    await server.close();
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  httpServer.listen(port, "127.0.0.1", () => {
    console.log(`Sequant MCP server started (SSE) on 127.0.0.1:${port}`);
    console.log(`  SSE endpoint: http://127.0.0.1:${port}/sse`);
    console.log(`  Health check: http://127.0.0.1:${port}/health`);
  });
}
