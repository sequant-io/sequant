import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";

// Mock child_process
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
}));

import { doctorCommand } from "./doctor.js";
import { fileExists, isExecutable } from "../lib/fs.js";
import { getManifest } from "../lib/manifest.js";

const mockExecSync = vi.mocked(execSync);
const mockFileExists = vi.mocked(fileExists);
const mockIsExecutable = vi.mocked(isExecutable);
const mockGetManifest = vi.mocked(getManifest);

describe("doctor command", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    processExitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    // Default: all files exist, all commands work
    mockFileExists.mockResolvedValue(true);
    mockIsExecutable.mockResolvedValue(true);
    mockGetManifest.mockResolvedValue({ version: "0.1.0", stack: "nextjs" });
    mockExecSync.mockImplementation(() => Buffer.from(""));
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    processExitSpy.mockRestore();
  });

  describe("GitHub CLI checks", () => {
    it("passes when gh CLI is installed", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") return Buffer.from("/usr/local/bin/gh");
        if (cmd === "gh auth status") return Buffer.from("");
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await doctorCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("GitHub CLI");
      expect(output).toContain("gh CLI is installed");
    });

    it("fails when gh CLI is not installed", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") {
          throw new Error("command not found");
        }
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await doctorCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("GitHub CLI");
      expect(output).toContain("gh CLI not installed");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("passes when gh CLI is authenticated", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") return Buffer.from("/usr/local/bin/gh");
        if (cmd === "gh auth status") return Buffer.from("");
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await doctorCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("GitHub Auth");
      expect(output).toContain("gh CLI is authenticated");
    });

    it("fails when gh CLI is not authenticated", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") return Buffer.from("/usr/local/bin/gh");
        if (cmd === "gh auth status") {
          throw new Error("not authenticated");
        }
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await doctorCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("GitHub Auth");
      expect(output).toContain("gh CLI not authenticated");
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("skips auth check when gh CLI is not installed", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") {
          throw new Error("command not found");
        }
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await doctorCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // Should not contain auth check result since gh is not installed
      expect(output).not.toContain("GitHub Auth");
    });
  });

  describe("jq checks", () => {
    it("passes when jq is installed", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") return Buffer.from("/usr/local/bin/gh");
        if (cmd === "gh auth status") return Buffer.from("");
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await doctorCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("jq");
      expect(output).toContain("jq is installed");
    });

    it("warns when jq is not installed", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") return Buffer.from("/usr/local/bin/gh");
        if (cmd === "gh auth status") return Buffer.from("");
        if (cmd === "command -v jq") {
          throw new Error("command not found");
        }
        return Buffer.from("");
      });

      await doctorCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("jq");
      expect(output).toContain("jq not installed");
      expect(output).toContain("Warnings: 1");
      // Should not exit with failure since jq is optional
      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });

  describe("combined scenarios", () => {
    it("all checks pass when everything is installed and configured", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") return Buffer.from("/usr/local/bin/gh");
        if (cmd === "gh auth status") return Buffer.from("");
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await doctorCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("All checks passed");
      expect(processExitSpy).not.toHaveBeenCalled();
    });

    it("exits with failure when gh is missing even if jq is present", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") {
          throw new Error("command not found");
        }
        if (cmd === "command -v jq") return Buffer.from("/usr/local/bin/jq");
        return Buffer.from("");
      });

      await doctorCommand({});

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it("shows only warnings (no failure) when only jq is missing", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (cmd === "command -v gh") return Buffer.from("/usr/local/bin/gh");
        if (cmd === "gh auth status") return Buffer.from("");
        if (cmd === "command -v jq") {
          throw new Error("command not found");
        }
        return Buffer.from("");
      });

      await doctorCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Warnings:");
      expect(output).toContain("should work");
      expect(processExitSpy).not.toHaveBeenCalled();
    });
  });
});
