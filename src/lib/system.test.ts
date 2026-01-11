import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "child_process";

// Mock child_process
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { commandExists, isGhAuthenticated, getInstallHint } from "./system.js";

const mockExecSync = vi.mocked(execSync);

describe("system utilities", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("commandExists", () => {
    it("returns true when command exists", () => {
      mockExecSync.mockReturnValue(Buffer.from("/usr/local/bin/gh"));

      expect(commandExists("gh")).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith("command -v gh", {
        stdio: "ignore",
      });
    });

    it("returns false when command does not exist", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("command not found");
      });

      expect(commandExists("nonexistent")).toBe(false);
    });

    it("checks different commands correctly", () => {
      mockExecSync.mockReturnValue(Buffer.from("/usr/local/bin/jq"));

      expect(commandExists("jq")).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith("command -v jq", {
        stdio: "ignore",
      });
    });

    it("returns false for invalid command names (injection prevention)", () => {
      // Commands with shell metacharacters should be rejected
      expect(commandExists("gh; echo test")).toBe(false);
      expect(commandExists("gh && echo")).toBe(false);
      expect(commandExists("gh$(echo)")).toBe(false);
      expect(commandExists("")).toBe(false);
      expect(commandExists("gh | cat")).toBe(false);
      expect(commandExists("gh > file")).toBe(false);
      expect(commandExists("gh < file")).toBe(false);
      expect(commandExists("gh\necho")).toBe(false);

      // execSync should NOT be called for invalid inputs
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("allows valid command names with hyphens and underscores", () => {
      mockExecSync.mockReturnValue(Buffer.from("/usr/bin/my-command"));

      expect(commandExists("my-command")).toBe(true);
      expect(commandExists("my_command")).toBe(true);
      expect(commandExists("command123")).toBe(true);
    });
  });

  describe("isGhAuthenticated", () => {
    it("returns true when gh is authenticated", () => {
      mockExecSync.mockReturnValue(Buffer.from(""));

      expect(isGhAuthenticated()).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith("gh auth status", {
        stdio: "ignore",
      });
    });

    it("returns false when gh is not authenticated", () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("not authenticated");
      });

      expect(isGhAuthenticated()).toBe(false);
    });
  });

  describe("getInstallHint", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      // Reset platform after each test
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        writable: true,
      });
    });

    it("returns macOS hint for gh on darwin", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      expect(getInstallHint("gh")).toBe("brew install gh");
    });

    it("returns macOS hint for jq on darwin", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      expect(getInstallHint("jq")).toBe("brew install jq");
    });

    it("returns Linux hint for gh on linux", () => {
      Object.defineProperty(process, "platform", { value: "linux" });

      expect(getInstallHint("gh")).toContain("apt install gh");
    });

    it("returns Windows hint for gh on win32", () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      expect(getInstallHint("gh")).toContain("choco install gh");
    });

    it("returns generic hint for unknown package", () => {
      expect(getInstallHint("unknown-package")).toBe("Install unknown-package");
    });

    it("returns npm hint for claude on any platform", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      expect(getInstallHint("claude")).toContain(
        "npm install -g @anthropic-ai/claude-code",
      );

      Object.defineProperty(process, "platform", { value: "linux" });
      expect(getInstallHint("claude")).toContain(
        "npm install -g @anthropic-ai/claude-code",
      );

      Object.defineProperty(process, "platform", { value: "win32" });
      expect(getInstallHint("claude")).toContain(
        "npm install -g @anthropic-ai/claude-code",
      );
    });
  });
});
