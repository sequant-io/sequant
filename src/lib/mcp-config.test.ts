/**
 * Tests for MCP client detection and configuration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  detectMcpClients,
  addSequantToMcpConfig,
  getSequantMcpConfig,
} from "./mcp-config.js";

describe("mcp-config", () => {
  describe("getSequantMcpConfig", () => {
    it("should return config with npx command", () => {
      const config = getSequantMcpConfig();
      expect(config.command).toBe("npx");
      expect(config.args).toEqual(["sequant@latest", "serve"]);
    });
  });

  describe("detectMcpClients", () => {
    it("should detect Claude Desktop, Cursor, and VS Code clients", () => {
      const clients = detectMcpClients();
      const names = clients.map((c) => c.name);

      expect(names).toContain("Claude Desktop");
      expect(names).toContain("Cursor");
      expect(names).toContain("VS Code + Continue");
    });

    it("should have configPath for each client", () => {
      const clients = detectMcpClients();
      for (const client of clients) {
        expect(client.configPath).toBeTruthy();
        expect(typeof client.exists).toBe("boolean");
      }
    });
  });

  describe("addSequantToMcpConfig", () => {
    const tmpDir = path.join(os.tmpdir(), "sequant-mcp-test-" + Date.now());
    const testConfig = path.join(tmpDir, "mcp.json");

    beforeEach(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should create config file if it does not exist", () => {
      const result = addSequantToMcpConfig(testConfig);
      expect(result).toBe(true);

      const content = JSON.parse(fs.readFileSync(testConfig, "utf-8"));
      expect(content.mcpServers.sequant).toBeDefined();
      expect(content.mcpServers.sequant.command).toBe("npx");
    });

    it("should add to existing config without overwriting", () => {
      // Create existing config with another server
      fs.writeFileSync(
        testConfig,
        JSON.stringify({
          mcpServers: {
            other: { command: "node", args: ["other.js"] },
          },
        }),
      );

      const result = addSequantToMcpConfig(testConfig);
      expect(result).toBe(true);

      const content = JSON.parse(fs.readFileSync(testConfig, "utf-8"));
      expect(content.mcpServers.other).toBeDefined();
      expect(content.mcpServers.sequant).toBeDefined();
    });

    it("should return false if already configured", () => {
      addSequantToMcpConfig(testConfig);
      const result = addSequantToMcpConfig(testConfig);
      expect(result).toBe(false);
    });

    it("should handle corrupt config file", () => {
      fs.writeFileSync(testConfig, "not json");
      const result = addSequantToMcpConfig(testConfig);
      expect(result).toBe(true);

      const content = JSON.parse(fs.readFileSync(testConfig, "utf-8"));
      expect(content.mcpServers.sequant).toBeDefined();
    });
  });
});
