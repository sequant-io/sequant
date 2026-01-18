/**
 * Tests for status command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { statusCommand } from "./status.js";

// Mock console.log to capture output
const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

describe("status command", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    mockConsoleLog.mockClear();
    // Create temp directory for test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-test-"));
    // Create .sequant directory structure
    fs.mkdirSync(path.join(tempDir, ".sequant", "logs"), { recursive: true });
    // Save original cwd and change to temp dir
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    // Restore original cwd
    process.chdir(originalCwd);
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("--rebuild flag", () => {
    it("should rebuild state from logs", async () => {
      await statusCommand({ rebuild: true });

      // Check that rebuild message was shown
      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Rebuilding state from logs");
      expect(output).toContain("State rebuilt successfully");
    });

    it("should return JSON when --json is used with --rebuild", async () => {
      await statusCommand({ rebuild: true, json: true });

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      const result = JSON.parse(output);
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("logsProcessed");
      expect(result).toHaveProperty("issuesFound");
    });
  });

  describe("--cleanup flag", () => {
    it("should run cleanup", async () => {
      await statusCommand({ cleanup: true });

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Cleaning up stale entries");
    });

    it("should show dry run message when --dry-run is used", async () => {
      await statusCommand({ cleanup: true, dryRun: true });

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("dry run");
    });

    it("should return JSON when --json is used with --cleanup", async () => {
      await statusCommand({ cleanup: true, json: true });

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      const result = JSON.parse(output);
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("removed");
      expect(result).toHaveProperty("orphaned");
    });

    it("should accept --max-age option", async () => {
      await statusCommand({ cleanup: true, maxAge: 30 });

      const output = mockConsoleLog.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Cleaning up stale entries");
    });
  });
});
