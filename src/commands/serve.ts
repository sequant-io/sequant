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

  const httpServer = createHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname === "/sse" && req.method === "GET") {
        // SSE endpoint - create transport and connect
        sseTransport = new SSEServerTransport("/messages", res);
        await server.connect(sseTransport);
      } else if (
        url.pathname === "/messages" &&
        req.method === "POST" &&
        sseTransport
      ) {
        // Message endpoint for client-to-server communication
        await sseTransport.handlePostMessage(req, res);
      } else if (url.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", transport: "sse" }));
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

  httpServer.listen(port, () => {
    console.log(`Sequant MCP server started (SSE) on port ${port}`);
    console.log(`  SSE endpoint: http://localhost:${port}/sse`);
    console.log(`  Health check: http://localhost:${port}/health`);
  });
}
