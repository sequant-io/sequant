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
  isSequantInProjectMcpJson,
  createProjectMcpJson,
} from "./mcp-config.js";

describe("mcp-config", () => {
  describe("getSequantMcpConfig", () => {
    it("should return config with npx command", () => {
      const config = getSequantMcpConfig();
      expect(config.command).toBe("npx");
      expect(config.args).toEqual(["sequant@latest", "serve"]);
    });

    it("should include cwd for claude-desktop", () => {
      const config = getSequantMcpConfig({
        projectDir: "/my/project",
        clientType: "claude-desktop",
      });
      expect(config.cwd).toBe("/my/project");
    });

    it("should include cwd for vscode-continue", () => {
      const config = getSequantMcpConfig({
        projectDir: "/my/project",
        clientType: "vscode-continue",
      });
      expect(config.cwd).toBe("/my/project");
    });

    it("should omit cwd for cursor", () => {
      const config = getSequantMcpConfig({
        projectDir: "/my/project",
        clientType: "cursor",
      });
      expect(config.cwd).toBeUndefined();
    });

    it("should fall back to process.cwd() when projectDir is omitted for claude-desktop", () => {
      const config = getSequantMcpConfig({
        clientType: "claude-desktop",
      });
      expect(config.cwd).toBe(process.cwd());
    });

    it("should omit cwd when no clientType is given", () => {
      const config = getSequantMcpConfig({ projectDir: "/my/project" });
      expect(config.cwd).toBeUndefined();
    });

    describe("env.ANTHROPIC_API_KEY", () => {
      const originalEnv = process.env.ANTHROPIC_API_KEY;

      afterEach(() => {
        if (originalEnv !== undefined) {
          process.env.ANTHROPIC_API_KEY = originalEnv;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
      });

      it("should include env when ANTHROPIC_API_KEY is set and clientType is given", () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
        const config = getSequantMcpConfig({ clientType: "claude-desktop" });
        expect(config.env).toEqual({
          ANTHROPIC_API_KEY: "sk-ant-test-key",
        });
      });

      it("should omit env when ANTHROPIC_API_KEY is not set", () => {
        delete process.env.ANTHROPIC_API_KEY;
        const config = getSequantMcpConfig({ clientType: "claude-desktop" });
        expect(config.env).toBeUndefined();
      });

      it("should omit env when no clientType is given even if ANTHROPIC_API_KEY is set", () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
        const config = getSequantMcpConfig();
        expect(config.env).toBeUndefined();
      });
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

    it("should have configPath and clientType for each client", () => {
      const clients = detectMcpClients();
      for (const client of clients) {
        expect(client.configPath).toBeTruthy();
        expect(typeof client.exists).toBe("boolean");
        expect(client.clientType).toBeTruthy();
      }
    });

    it("should assign correct clientType to each client", () => {
      const clients = detectMcpClients();
      const byName = Object.fromEntries(clients.map((c) => [c.name, c]));

      expect(byName["Claude Desktop"].clientType).toBe("claude-desktop");
      expect(byName["Cursor"].clientType).toBe("cursor");
      expect(byName["VS Code + Continue"].clientType).toBe("vscode-continue");
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

    it("should include cwd when clientType is claude-desktop", () => {
      const result = addSequantToMcpConfig(testConfig, "claude-desktop");
      expect(result).toBe(true);

      const content = JSON.parse(fs.readFileSync(testConfig, "utf-8"));
      expect(content.mcpServers.sequant.cwd).toBe(process.cwd());
    });

    it("should omit cwd when clientType is cursor", () => {
      const result = addSequantToMcpConfig(testConfig, "cursor");
      expect(result).toBe(true);

      const content = JSON.parse(fs.readFileSync(testConfig, "utf-8"));
      expect(content.mcpServers.sequant.cwd).toBeUndefined();
    });
  });

  describe("isSequantInProjectMcpJson", () => {
    const tmpDir = path.join(
      os.tmpdir(),
      "sequant-mcp-check-test-" + Date.now(),
    );

    beforeEach(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should return false when .mcp.json does not exist", () => {
      expect(isSequantInProjectMcpJson(tmpDir)).toBe(false);
    });

    it("should return true when sequant entry exists", () => {
      fs.writeFileSync(
        path.join(tmpDir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            sequant: { command: "npx", args: ["sequant@latest", "serve"] },
          },
        }),
      );
      expect(isSequantInProjectMcpJson(tmpDir)).toBe(true);
    });

    it("should return false when .mcp.json has no sequant entry", () => {
      fs.writeFileSync(
        path.join(tmpDir, ".mcp.json"),
        JSON.stringify({ mcpServers: { other: {} } }),
      );
      expect(isSequantInProjectMcpJson(tmpDir)).toBe(false);
    });

    it("should return false for corrupt .mcp.json", () => {
      fs.writeFileSync(path.join(tmpDir, ".mcp.json"), "not json{{{");
      expect(isSequantInProjectMcpJson(tmpDir)).toBe(false);
    });
  });

  describe("createProjectMcpJson", () => {
    const tmpDir = path.join(
      os.tmpdir(),
      "sequant-mcp-project-test-" + Date.now(),
    );

    beforeEach(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("should create .mcp.json when it does not exist", () => {
      const result = createProjectMcpJson(tmpDir);

      expect(result).toEqual({ created: true, merged: false, skipped: false });

      const content = JSON.parse(
        fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
      );
      expect(content.mcpServers.sequant.command).toBe("npx");
      expect(content.mcpServers.sequant.args).toEqual([
        "sequant@latest",
        "serve",
      ]);
    });

    it("should NOT include cwd or env in .mcp.json config", () => {
      createProjectMcpJson(tmpDir);

      const content = JSON.parse(
        fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
      );
      expect(content.mcpServers.sequant.cwd).toBeUndefined();
      expect(content.mcpServers.sequant.env).toBeUndefined();
    });

    it("should skip when sequant entry already exists", () => {
      const existing = {
        mcpServers: {
          sequant: { command: "npx", args: ["sequant@latest", "serve"] },
        },
      };
      fs.writeFileSync(
        path.join(tmpDir, ".mcp.json"),
        JSON.stringify(existing),
      );

      const result = createProjectMcpJson(tmpDir);

      expect(result).toEqual({ created: false, merged: false, skipped: true });
    });

    it("should merge into existing .mcp.json without sequant entry", () => {
      const existing = {
        mcpServers: {
          "other-server": { command: "node", args: ["server.js"] },
        },
      };
      fs.writeFileSync(
        path.join(tmpDir, ".mcp.json"),
        JSON.stringify(existing),
      );

      const result = createProjectMcpJson(tmpDir);

      expect(result).toEqual({ created: false, merged: true, skipped: false });

      const content = JSON.parse(
        fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
      );
      // Existing server preserved
      expect(content.mcpServers["other-server"]).toEqual({
        command: "node",
        args: ["server.js"],
      });
      // Sequant added
      expect(content.mcpServers.sequant.command).toBe("npx");
    });

    it("should NOT leak ANTHROPIC_API_KEY into .mcp.json", () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      try {
        process.env.ANTHROPIC_API_KEY = "sk-ant-secret-key-should-not-leak";
        createProjectMcpJson(tmpDir);

        const content = JSON.parse(
          fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
        );
        expect(content.mcpServers.sequant.env).toBeUndefined();
        expect(JSON.stringify(content)).not.toContain("sk-ant-secret-key");
      } finally {
        if (originalKey !== undefined) {
          process.env.ANTHROPIC_API_KEY = originalKey;
        } else {
          delete process.env.ANTHROPIC_API_KEY;
        }
      }
    });

    it("should handle corrupt .mcp.json gracefully", () => {
      fs.writeFileSync(path.join(tmpDir, ".mcp.json"), "not valid json{{{");

      const result = createProjectMcpJson(tmpDir);

      expect(result).toEqual({ created: false, merged: true, skipped: false });

      const content = JSON.parse(
        fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
      );
      expect(content.mcpServers.sequant.command).toBe("npx");
    });

    it("should handle mcpServers being an array instead of object", () => {
      const existing = { mcpServers: ["not", "an", "object"] };
      fs.writeFileSync(
        path.join(tmpDir, ".mcp.json"),
        JSON.stringify(existing),
      );

      const result = createProjectMcpJson(tmpDir);

      expect(result).toEqual({ created: false, merged: true, skipped: false });

      const content = JSON.parse(
        fs.readFileSync(path.join(tmpDir, ".mcp.json"), "utf-8"),
      );
      // Array replaced with proper object
      expect(Array.isArray(content.mcpServers)).toBe(false);
      expect(content.mcpServers.sequant.command).toBe("npx");
    });
  });
});
