import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "child_process";

// Mock child_process
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

import { commandExists } from "./system.js";

const mockExecSync = vi.mocked(execSync);

describe("system utilities", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("commandExists", () => {
    it("returns true when command exists", () => {
      mockExecSync.mockReturnValue(Buffer.from("/usr/bin/git"));

      expect(commandExists("git")).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith("command -v git", {
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
});
