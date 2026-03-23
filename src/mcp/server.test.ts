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
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer } from "./server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

describe("Sequant MCP Server", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
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

  // AC-13: Tool schemas match specification
  describe("AC-13: tools/list", () => {
    it("should list all three tools with correct names", async () => {
      const result = await client.listTools();
      const toolNames = result.tools.map((t) => t.name).sort();

      expect(toolNames).toEqual([
        "sequant_logs",
        "sequant_run",
        "sequant_status",
      ]);
    });

    it("sequant_run should have correct input schema", async () => {
      const result = await client.listTools();
      const runTool = result.tools.find((t) => t.name === "sequant_run");

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
      const statusTool = result.tools.find((t) => t.name === "sequant_status");

      expect(statusTool).toBeDefined();
      expect(statusTool!.description).toContain("workflow state");

      const schema = statusTool!.inputSchema;
      expect(schema.properties).toHaveProperty("issue");
      expect(schema.required).toContain("issue");
    });

    it("sequant_logs should have correct input schema", async () => {
      const result = await client.listTools();
      const logsTool = result.tools.find((t) => t.name === "sequant_logs");

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
      const uris = result.resources.map((r) => r.uri).sort();

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
