import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";

// Mock child_process
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

// Mock fs functions
vi.mock("../lib/fs.js", () => ({
  fileExists: vi.fn(),
  ensureDir: vi.fn(),
}));

// Mock stacks
vi.mock("../lib/stacks.js", () => ({
  detectStack: vi.fn(),
}));

// Mock templates
vi.mock("../lib/templates.js", () => ({
  copyTemplates: vi.fn(),
}));

// Mock manifest
vi.mock("../lib/manifest.js", () => ({
  createManifest: vi.fn(),
}));

// Mock inquirer
vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn(),
  },
}));

import { initCommand } from "./init.js";
import { fileExists, ensureDir } from "../lib/fs.js";
import { detectStack } from "../lib/stacks.js";
import { copyTemplates } from "../lib/templates.js";
import { createManifest } from "../lib/manifest.js";

const mockExecSync = vi.mocked(execSync);
const mockFileExists = vi.mocked(fileExists);
const mockEnsureDir = vi.mocked(ensureDir);
const mockDetectStack = vi.mocked(detectStack);
const mockCopyTemplates = vi.mocked(copyTemplates);
const mockCreateManifest = vi.mocked(createManifest);

describe("init command", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Default: not initialized, all commands work
    mockFileExists.mockResolvedValue(false);
    mockEnsureDir.mockResolvedValue(undefined);
    mockDetectStack.mockResolvedValue(null);
    mockCopyTemplates.mockResolvedValue(undefined);
    mockCreateManifest.mockResolvedValue(undefined);
    mockExecSync.mockImplementation(() => Buffer.from(""));
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe("prerequisite checks", () => {
    it("shows no warnings when all prerequisites are met", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") return Buffer.from("/usr/local/bin/gh");
        if (cmd === "gh auth status") return Buffer.from("");
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).not.toContain("Prerequisites:");
      expect(output).not.toContain("GitHub CLI (gh) is not installed");
      expect(output).not.toContain("GitHub CLI is not authenticated");
      expect(output).toContain("Sequant initialized successfully");
    });

    it("warns when gh CLI is not installed", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") {
          throw new Error("command not found");
        }
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Prerequisites:");
      expect(output).toContain("GitHub CLI (gh) is not installed");
      expect(output).toContain("https://cli.github.com");
      expect(output).toContain("Remember to address prerequisites");
    });

    it("warns when gh CLI is not authenticated", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") return Buffer.from("/usr/local/bin/gh");
        if (cmd === "gh auth status") {
          throw new Error("not authenticated");
        }
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Prerequisites:");
      expect(output).toContain("GitHub CLI is not authenticated");
      expect(output).toContain("gh auth login");
      expect(output).toContain("Remember to address prerequisites");
    });

    it("shows optional jq suggestion when jq is not installed", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") return Buffer.from("/usr/local/bin/gh");
        if (cmd === "gh auth status") return Buffer.from("");
        if (cmd === "command -v jq") {
          throw new Error("command not found");
        }
        return Buffer.from("");
      });

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Optional improvements:");
      expect(output).toContain("Install jq for faster JSON parsing");
      // Should NOT show prerequisites warning since jq is optional
      expect(output).not.toContain("Prerequisites:");
    });

    it("shows both gh warning and jq suggestion when both are missing", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") {
          throw new Error("command not found");
        }
        if (cmd === "command -v jq") {
          throw new Error("command not found");
        }
        return Buffer.from("");
      });

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Prerequisites:");
      expect(output).toContain("GitHub CLI (gh) is not installed");
      expect(output).toContain("Optional improvements:");
      expect(output).toContain("Install jq for faster JSON parsing");
    });

    it("skips auth check when gh is not installed", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") {
          throw new Error("command not found");
        }
        if (cmd === "gh auth status") {
          throw new Error("should not be called");
        }
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // Should only show "not installed", not "not authenticated"
      expect(output).toContain("GitHub CLI (gh) is not installed");
      expect(output).not.toContain("GitHub CLI is not authenticated");
    });
  });

  describe("initialization flow", () => {
    it("completes successfully with --yes and --stack flags", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") return Buffer.from("/usr/local/bin/gh");
        if (cmd === "gh auth status") return Buffer.from("");
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await initCommand({ yes: true, stack: "nextjs" });

      expect(mockEnsureDir).toHaveBeenCalledWith(".claude/skills");
      expect(mockEnsureDir).toHaveBeenCalledWith(".claude/hooks");
      expect(mockEnsureDir).toHaveBeenCalledWith(".claude/memory");
      expect(mockEnsureDir).toHaveBeenCalledWith("scripts/dev");
      expect(mockCopyTemplates).toHaveBeenCalledWith("nextjs");
      expect(mockCreateManifest).toHaveBeenCalledWith("nextjs");

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Sequant initialized successfully");
    });

    it("warns but continues when already initialized without --force", async () => {
      mockFileExists.mockImplementation(async (path: string) => {
        return path === ".claude/settings.json";
      });
      mockExecSync.mockImplementation(() => Buffer.from(""));

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("already initialized");
    });
  });
});
