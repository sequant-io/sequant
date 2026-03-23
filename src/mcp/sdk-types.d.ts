/**
 * Ambient type declarations for @modelcontextprotocol/sdk
 *
 * These declarations act as a fallback when the SDK is not installed,
 * allowing tsc to resolve type-only imports without the actual package.
 * When the SDK IS installed, TypeScript uses the real types from node_modules.
 *
 * Issue #396: Make MCP SDK a truly optional dependency.
 */

declare module "@modelcontextprotocol/sdk/server/mcp.js" {
  export class McpServer {
    constructor(
      serverInfo: { name: string; version: string },
      options?: {
        capabilities?: {
          tools?: Record<string, unknown>;
          resources?: Record<string, unknown>;
        };
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTool(
      name: string,
      config: any,
      handler: (params: any) => any,
    ): void;
    registerResource(
      name: string,
      uri: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (...args: any[]) => any,
    ): void;
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/server/stdio.js" {
  export class StdioServerTransport {
    constructor();
  }
}

declare module "@modelcontextprotocol/sdk/server/sse.js" {
  export class SSEServerTransport {
    constructor(path: string, res: unknown);
    handlePostMessage(req: unknown, res: unknown): Promise<void>;
  }
}

declare module "@modelcontextprotocol/sdk/client/index.js" {
  export class Client {
    constructor(clientInfo: { name: string; version: string });
    connect(transport: unknown): Promise<void>;
    close(): Promise<void>;
    listTools(): Promise<{
      tools: Array<{
        name: string;
        description?: string;
        inputSchema: Record<string, unknown>;
      }>;
    }>;
    listResources(): Promise<{
      resources: Array<{
        uri: string;
        name?: string;
        mimeType?: string;
      }>;
    }>;
    readResource(params: { uri: string }): Promise<{
      contents: Array<{
        uri: string;
        text?: string;
        mimeType?: string;
      }>;
    }>;
    callTool(params: {
      name: string;
      arguments: Record<string, unknown>;
    }): Promise<{
      content: unknown;
      isError?: boolean;
    }>;
  }
}

declare module "@modelcontextprotocol/sdk/inMemory.js" {
  export class InMemoryTransport {
    static createLinkedPair(): [InMemoryTransport, InMemoryTransport];
  }
}
