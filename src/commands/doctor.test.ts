import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as childProcess from "child_process";

// Mock child_process for checkClosedIssues
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

// Mock fs functions
vi.mock("../lib/fs.js", () => ({
  fileExists: vi.fn(),
  isExecutable: vi.fn(),
}));

// Mock manifest
vi.mock("../lib/manifest.js", () => ({
  getManifest: vi.fn(),
  getPackageVersion: vi.fn(() => "1.0.0"),
}));

// Mock sync module
vi.mock("./sync.js", () => ({
  areSkillsOutdated: vi.fn(() =>
    Promise.resolve({
      outdated: false,
      currentVersion: "1.0.0",
      packageVersion: "1.0.0",
    }),
  ),
}));

// Mock system functions
vi.mock("../lib/system.js", () => ({
  commandExists: vi.fn(),
  isGhAuthenticated: vi.fn(),
  isNativeWindows: vi.fn(),
  isWSL: vi.fn(),
  checkOptionalMcpServers: vi.fn(),
  getMcpServersConfig: vi.fn(),
  OPTIONAL_MCP_SERVERS: [
    {
      name: "chrome-devtools",
      purpose: "Browser automation",
      skills: ["/test", "/testgen"],
      installUrl: "https://example.com/chrome-devtools",
    },
    {
      name: "context7",
      purpose: "Library docs",
      skills: ["/exec"],
      installUrl: "https://example.com/context7",
    },
    {
      name: "sequential-thinking",
      purpose: "Complex reasoning",
      skills: ["/fullsolve"],
      installUrl: "https://example.com/sequential-thinking",
    },
  ],
}));

import { doctorCommand, checkClosedIssues } from "./doctor.js";
import { fileExists, isExecutable } from "../lib/fs.js";
import { getManifest } from "../lib/manifest.js";
import {
  commandExists,
  isGhAuthenticated,
  isNativeWindows,
  isWSL,
  checkOptionalMcpServers,
  getMcpServersConfig,
} from "../lib/system.js";

const mockFileExists = vi.mocked(fileExists);
const mockIsExecutable = vi.mocked(isExecutable);
const mockGetManifest = vi.mocked(getManifest);
const mockCommandExists = vi.mocked(commandExists);
const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);
const mockIsNativeWindows = vi.mocked(isNativeWindows);
const mockIsWSL = vi.mocked(isWSL);
const mockCheckOptionalMcpServers = vi.mocked(checkOptionalMcpServers);
const mockGetMcpServersConfig = vi.mocked(getMcpServersConfig);
const mockExecSync = vi.mocked(childProcess.execSync);

describe("doctor command", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let processExitSpy: any;

  beforeEach(() => {
    vi.resetAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    processExitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    // Default: all files exist, all commands work
    mockFileExists.mockResolvedValue(true);
    mockIsExecutable.mockResolvedValue(true);
    mockGetManifest.mockResolvedValue({
      version: "0.1.0",
      stack: "nextjs",
      installedAt: "2024-01-01T00:00:00.000Z",
      files: {},
    });
    mockCommandExists.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
    // Default: not on Windows
    mockIsNativeWindows.mockReturnValue(false);
    mockIsWSL.mockReturnValue(false);
    // Default: all MCPs configured
    mockCheckOptionalMcpServers.mockReturnValue({
      "chrome-devtools": true,
      context7: true,
      "sequential-thinking": true,
    });
    // Default: MCP servers config available for headless mode
    mockGetMcpServersConfig.mockReturnValue({
      "chrome-devtools": { command: "npx", args: ["mcp-chrome-devtools"] },
      context7: { command: "npx", args: ["@context7/mcp"] },
    });
    // Default: no closed issues (empty array from gh issue list)
    mockExecSync.mockReturnValue("[]");
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe("GitHub CLI checks", () => {
    it("passes when gh CLI is installed", async () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(true);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("GitHub CLI");
      expect(output).toContain("gh CLI is installed");
    });

    it("fails when gh CLI is not installed", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "gh");
      mockIsGhAuthenticated.mockReturnValue(false);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("GitHub CLI");
      expect(output).toContain("gh CLI not installed");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("passes when gh CLI is authenticated", async () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(true);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("GitHub Auth");
      expect(output).toContain("gh CLI is authenticated");
    });

    it("fails when gh CLI is not authenticated", async () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(false);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("GitHub Auth");
      expect(output).toContain("gh CLI not authenticated");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("skips auth check when gh CLI is not installed", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "gh");

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // Should not contain auth check result since gh is not installed
      expect(output).not.toContain("GitHub Auth");
    });
  });

  describe("Claude Code CLI checks", () => {
    it("passes when claude CLI is installed", async () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(true);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Claude Code CLI");
      expect(output).toContain("claude CLI is installed");
    });

    it("fails when claude CLI is not installed", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "claude");
      mockIsGhAuthenticated.mockReturnValue(true);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Claude Code CLI");
      expect(output).toContain("claude CLI not installed");
      expect(output).toContain(
        "https://docs.anthropic.com/en/docs/claude-code",
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("shows install link when claude CLI is missing", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "claude");
      mockIsGhAuthenticated.mockReturnValue(true);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain(
        "https://docs.anthropic.com/en/docs/claude-code",
      );
    });
  });

  describe("jq checks", () => {
    it("passes when jq is installed", async () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(true);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("jq");
      expect(output).toContain("jq is installed");
    });

    it("warns when jq is not installed", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "jq");
      mockIsGhAuthenticated.mockReturnValue(true);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("jq");
      expect(output).toContain("jq not installed");
      expect(output).toContain("Warnings: 1");
      // Should not exit with failure since jq is optional
      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });

  describe("Windows platform checks", () => {
    it("warns when running on native Windows", async () => {
      mockIsNativeWindows.mockReturnValue(true);
      mockIsWSL.mockReturnValue(false);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Platform");
      expect(output).toContain("native Windows");
      expect(output).toContain("WSL recommended");
    });

    it("passes when running in WSL", async () => {
      mockIsNativeWindows.mockReturnValue(false);
      mockIsWSL.mockReturnValue(true);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Platform");
      expect(output).toContain("Running in WSL");
      expect(output).toContain("full functionality");
    });

    it("does not show platform check on macOS/Linux", async () => {
      mockIsNativeWindows.mockReturnValue(false);
      mockIsWSL.mockReturnValue(false);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // Should not contain Platform check on non-Windows systems
      expect(output).not.toContain("Platform");
    });
  });

  describe("combined scenarios", () => {
    it("all checks pass when everything is installed and configured", async () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(true);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // New boxed format includes the count: "All X checks passed!"
      expect(output).toMatch(/All \d+ checks passed/);
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("exits with failure when gh is missing even if jq is present", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "gh");

      await doctorCommand();

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("shows only warnings (no failure) when only jq is missing", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "jq");
      mockIsGhAuthenticated.mockReturnValue(true);

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Warnings:");
      expect(output).toContain("should work");
      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });

  describe("MCP server checks", () => {
    it("passes when all optional MCPs are configured", async () => {
      mockCheckOptionalMcpServers.mockReturnValue({
        "chrome-devtools": true,
        context7: true,
        "sequential-thinking": true,
      });

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("MCP Servers");
      expect(output).toContain("All optional MCPs configured");
    });

    it("shows pass with configured MCPs and warns for missing ones", async () => {
      mockCheckOptionalMcpServers.mockReturnValue({
        "chrome-devtools": true,
        context7: false,
        "sequential-thinking": true,
      });

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("MCP Servers");
      expect(output).toContain("Some MCPs configured");
      expect(output).toContain("MCP: context7");
      expect(output).toContain("Not configured");
      expect(output).toContain("/exec");
      // Should not fail since MCPs are optional
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("warns when no optional MCPs are configured", async () => {
      mockCheckOptionalMcpServers.mockReturnValue({
        "chrome-devtools": false,
        context7: false,
        "sequential-thinking": false,
      });

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("MCP Servers");
      expect(output).toContain("No optional MCPs configured");
      expect(output).toContain("works without them");
      // Should not fail since MCPs are optional
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("does not fail when MCPs are missing (they are optional)", async () => {
      mockCheckOptionalMcpServers.mockReturnValue({
        "chrome-devtools": false,
        context7: false,
        "sequential-thinking": false,
      });

      await doctorCommand();

      // Should complete without failure
      expect(processExitSpy).not.toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("should work");
    });
  });

  describe("closed issue verification", () => {
    it("passes when no recently closed issues exist", async () => {
      mockExecSync.mockReturnValue("[]");

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Closed Issues");
      expect(output).toContain(
        "All recently closed issues have commits in main",
      );
    });

    it("passes when closed issues have commits in main", async () => {
      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("gh issue list")) {
          return JSON.stringify([
            {
              number: 42,
              title: "Test issue",
              closedAt: twoDaysAgo.toISOString(),
              labels: [],
            },
          ]);
        }
        // git log returns a commit for issue #42
        if (cmd.includes("git log") && cmd.includes("#42")) {
          return "abc123 feat(#42): implement test feature";
        }
        return "";
      });

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Closed Issues");
      expect(output).toContain(
        "All recently closed issues have commits in main",
      );
    });

    it("warns when closed issue has no commit in main", async () => {
      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("gh issue list")) {
          return JSON.stringify([
            {
              number: 78,
              title: "Lost work issue",
              closedAt: twoDaysAgo.toISOString(),
              labels: [],
            },
          ]);
        }
        // git log returns empty (no commit found)
        if (cmd.includes("git log")) {
          return "";
        }
        return "";
      });

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Issue #78");
      expect(output).toContain("Closed but no commit found in main");
      expect(output).toContain("Lost work issue");
    });

    it("skips issues with wontfix label", async () => {
      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("gh issue list")) {
          return JSON.stringify([
            {
              number: 99,
              title: "Wontfix issue",
              closedAt: twoDaysAgo.toISOString(),
              labels: [{ name: "wontfix" }],
            },
          ]);
        }
        return "";
      });

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // Should not warn about issue #99 since it has wontfix label
      expect(output).not.toContain("Issue #99");
      expect(output).toContain("Closed Issues");
      expect(output).toContain(
        "All recently closed issues have commits in main",
      );
    });

    it("skips issues with duplicate label", async () => {
      const now = new Date();
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("gh issue list")) {
          return JSON.stringify([
            {
              number: 100,
              title: "Duplicate issue",
              closedAt: twoDaysAgo.toISOString(),
              labels: [{ name: "duplicate" }],
            },
          ]);
        }
        return "";
      });

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).not.toContain("Issue #100");
    });

    it("skips issues older than 7 days", async () => {
      const now = new Date();
      const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("gh issue list")) {
          return JSON.stringify([
            {
              number: 50,
              title: "Old issue",
              closedAt: tenDaysAgo.toISOString(),
              labels: [],
            },
          ]);
        }
        return "";
      });

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // Should not warn about issue #50 since it's older than 7 days
      expect(output).not.toContain("Issue #50");
    });

    it("skips check when gh is not available", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "gh");
      mockExecSync.mockReturnValue("[]");

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // Should not contain closed issues check
      expect(output).not.toContain("Closed Issues");
    });

    it("skips check when gh is not authenticated", async () => {
      mockIsGhAuthenticated.mockReturnValue(false);
      mockExecSync.mockReturnValue("[]");

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // Should not contain closed issues check
      expect(output).not.toContain("Closed Issues");
    });

    it("skips check when --skip-issue-check flag is used", async () => {
      mockExecSync.mockReturnValue("[]");

      await doctorCommand({ skipIssueCheck: true });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // Should not contain closed issues check
      expect(output).not.toContain("Closed Issues");
    });

    it("handles gh command failure gracefully", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes("gh issue list")) {
          throw new Error("gh command failed");
        }
        return "";
      });

      await doctorCommand();

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // Should still show closed issues check (pass because no issues found)
      expect(output).toContain("Closed Issues");
      expect(output).toContain(
        "All recently closed issues have commits in main",
      );
    });
  });
});
