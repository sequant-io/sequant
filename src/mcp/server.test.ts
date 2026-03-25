/**
 * Tests for Sequant MCP Server
 * Issue #372: Expose Sequant Workflow as MCP Server
 *
 * Covers:
 * - AC-1: Server creation and initialization
 * - AC-2: sequant_run tool schema and validation
 * - AC-3: sequant_status tool schema and validation
 * - AC-4: sequant_logs tool schema and validation
 * - AC-5: sequant://state resource
 * - AC-6: sequant://config resource
 * - AC-13: Tool schemas match specification
 * - AC-14: Structured MCP errors for invalid inputs
 *
 * Guarded: Skips if @modelcontextprotocol/sdk is not installed (#396)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Check if MCP SDK is available (dynamic import to avoid hard failure)
const mcpSdkAvailable = await import("@modelcontextprotocol/sdk/server/mcp.js")
  .then(() => true)
  .catch(() => false);

describe.skipIf(!mcpSdkAvailable)("Sequant MCP Server", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const { createServer } = await import("./server.js");
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

  // #420 AC-1: Server instructions
  describe("#420 AC-1: server instructions", () => {
    it("should include instructions in server capabilities", async () => {
      const instructions = client.getInstructions();
      expect(instructions).toBeDefined();
      expect(instructions).toContain("Sequant orchestrates");
      expect(instructions).toContain("sequant_status");
      expect(instructions).toContain("sequant_run");
      expect(instructions).toContain("sequant_logs");
      expect(instructions).toContain("sequant://state");
      expect(instructions).toContain("sequant://config");
    });
  });

  // #420 AC-2, AC-3, AC-4: Tool annotations
  describe("#420: tool annotations", () => {
    it("sequant_status should have readOnly and idempotent annotations", async () => {
      const result = await client.listTools();
      const tool = result.tools.find(
        (t: { name: string }) => t.name === "sequant_status",
      );
      expect(tool!.annotations).toEqual(
        expect.objectContaining({
          readOnlyHint: true,
          idempotentHint: true,
        }),
      );
    });

    it("sequant_logs should have readOnly and idempotent annotations", async () => {
      const result = await client.listTools();
      const tool = result.tools.find(
        (t: { name: string }) => t.name === "sequant_logs",
      );
      expect(tool!.annotations).toEqual(
        expect.objectContaining({
          readOnlyHint: true,
          idempotentHint: true,
        }),
      );
    });

    it("sequant_run should have correct annotations for a write tool", async () => {
      const result = await client.listTools();
      const tool = result.tools.find(
        (t: { name: string }) => t.name === "sequant_run",
      );
      expect(tool!.annotations).toEqual(
        expect.objectContaining({
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        }),
      );
    });
  });

  // #420 AC-8: phases parameter enumerates valid values
  describe("#420 AC-8: phases parameter description", () => {
    it("should enumerate spec, exec, qa in phases parameter description", async () => {
      const result = await client.listTools();
      const runTool = result.tools.find(
        (t: { name: string }) => t.name === "sequant_run",
      );
      const phasesDesc =
        runTool!.inputSchema.properties.phases.description || "";
      expect(phasesDesc).toContain("spec");
      expect(phasesDesc).toContain("exec");
      expect(phasesDesc).toContain("qa");
    });
  });

  // #420 AC-9: Resource descriptions
  describe("#420 AC-9: resource descriptions", () => {
    it("sequant://state description should explain purpose, not just file path", async () => {
      const result = await client.listResources();
      const stateResource = result.resources.find(
        (r: { uri: string }) => r.uri === "sequant://state",
      );
      expect(stateResource!.description).toContain("tracked");
      expect(stateResource!.description).not.toContain(".sequant/state.json");
    });

    it("sequant://config description should explain purpose, not just file path", async () => {
      const result = await client.listResources();
      const configResource = result.resources.find(
        (r: { uri: string }) => r.uri === "sequant://config",
      );
      expect(configResource!.description).toContain("settings");
      expect(configResource!.description).not.toContain(
        ".sequant/settings.json",
      );
    });
  });

  // #420 AC-5: sequant_run description content
  describe("#420 AC-5: sequant_run description content", () => {
    it("should describe phases, example input, and usage guidance", async () => {
      const result = await client.listTools();
      const tool = result.tools.find(
        (t: { name: string }) => t.name === "sequant_run",
      );
      const desc = tool!.description!;

      // Phase explanations
      expect(desc).toContain("spec");
      expect(desc).toContain("exec");
      expect(desc).toContain("qa");

      // Example input
      expect(desc).toContain("Example");
      expect(desc).toContain("issues");

      // Cross-tool guidance (when to use)
      expect(desc).toContain("sequant_status");
    });
  });

  // #420 AC-6: sequant_status description content
  describe("#420 AC-6: sequant_status description content", () => {
    it("should explain relationship to sequant_run and polling guidance", async () => {
      const result = await client.listTools();
      const tool = result.tools.find(
        (t: { name: string }) => t.name === "sequant_status",
      );
      const desc = tool!.description!;

      // Cross-tool relationship
      expect(desc).toContain("sequant_run");

      // Polling guidance
      expect(desc).toContain("poll");
    });
  });

  // #420 AC-7: sequant_logs description content
  describe("#420 AC-7: sequant_logs description content", () => {
    it("should describe log insights, when to check, and runId format", async () => {
      const result = await client.listTools();
      const tool = result.tools.find(
        (t: { name: string }) => t.name === "sequant_logs",
      );
      const desc = tool!.description!;

      // What insights logs provide
      expect(desc).toContain("phase results");
      expect(desc).toContain("QA verdicts");

      // When to check
      expect(desc).toContain("sequant_run");

      // runId format info
      expect(desc).toContain("run-");
      expect(desc).toContain(".json");
    });
  });

  // AC-13: Tool schemas match specification
  describe("AC-13: tools/list", () => {
    it("should list all three tools with correct names", async () => {
      const result = await client.listTools();
      const toolNames = result.tools
        .map((t: { name: string }) => t.name)
        .sort();

      expect(toolNames).toEqual([
        "sequant_logs",
        "sequant_run",
        "sequant_status",
      ]);
    });

    it("sequant_run should have correct input schema", async () => {
      const result = await client.listTools();
      const runTool = result.tools.find(
        (t: { name: string }) => t.name === "sequant_run",
      );

      expect(runTool).toBeDefined();
      expect(runTool!.description).toContain("workflow phases");

      const schema = runTool!.inputSchema;
      expect(schema.properties).toHaveProperty("issues");
      expect(schema.properties).toHaveProperty("phases");
      expect(schema.properties).toHaveProperty("qualityLoop");
      expect(schema.required).toContain("issues");
    });

    it("sequant_status should have correct input schema", async () => {
      const result = await client.listTools();
      const statusTool = result.tools.find(
        (t: { name: string }) => t.name === "sequant_status",
      );

      expect(statusTool).toBeDefined();
      expect(statusTool!.description).toContain("workflow state");

      const schema = statusTool!.inputSchema;
      expect(schema.properties).toHaveProperty("issue");
      expect(schema.required).toContain("issue");
    });

    it("sequant_logs should have correct input schema", async () => {
      const result = await client.listTools();
      const logsTool = result.tools.find(
        (t: { name: string }) => t.name === "sequant_logs",
      );

      expect(logsTool).toBeDefined();
      expect(logsTool!.description).toContain("run logs");

      const schema = logsTool!.inputSchema;
      expect(schema.properties).toHaveProperty("runId");
      expect(schema.properties).toHaveProperty("limit");
    });
  });

  // AC-5, AC-6: Resources
  describe("AC-5, AC-6: resources/list", () => {
    it("should list state and config resources", async () => {
      const result = await client.listResources();
      const uris = result.resources.map((r: { uri: string }) => r.uri).sort();

      expect(uris).toEqual(["sequant://config", "sequant://state"]);
    });

    it("sequant://state resource should return JSON", async () => {
      const result = await client.readResource({
        uri: "sequant://state",
      });

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe("application/json");

      // Should be valid JSON
      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toBeDefined();
    });

    it("sequant://config resource should return JSON", async () => {
      const result = await client.readResource({
        uri: "sequant://config",
      });

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe("application/json");

      const parsed = JSON.parse(result.contents[0].text as string);
      expect(parsed).toBeDefined();
    });
  });

  // AC-3: sequant_status tool
  describe("AC-3: sequant_status", () => {
    it("should return not_tracked for unknown issues", async () => {
      const result = await client.callTool({
        name: "sequant_status",
        arguments: { issue: 99999 },
      });

      expect(result.content).toHaveLength(1);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.status).toBe("not_tracked");
      expect(data.issue).toBe(99999);
    });
  });

  // AC-4: sequant_logs tool
  describe("AC-4: sequant_logs", () => {
    it("should return empty logs when no log directory exists", async () => {
      const result = await client.callTool({
        name: "sequant_logs",
        arguments: { limit: 5 },
      });

      expect(result.content).toHaveLength(1);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      // Should either have empty logs array or a message
      expect(data).toBeDefined();
      if (data.logs) {
        expect(Array.isArray(data.logs)).toBe(true);
      }
    });
  });

  // AC-14: Structured MCP errors
  describe("AC-14: structured errors", () => {
    it("sequant_run should return structured error for empty issues array", async () => {
      const result = await client.callTool({
        name: "sequant_run",
        arguments: { issues: [] },
      });

      expect(result.isError).toBe(true);
      const data = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0].text,
      );
      expect(data.error).toBe("INVALID_INPUT");
    });
  });
});
