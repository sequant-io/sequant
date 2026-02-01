/**
 * Tests for scripts/state/update.ts CLI commands
 *
 * These tests run the actual CLI script to verify command-line behavior,
 * argument parsing, and error handling.
 */

import { spawnSync } from "child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../..");
const scriptPath = path.resolve(projectRoot, "scripts/state/update.ts");

/**
 * Run the state update CLI script with given arguments
 */
function runCli(
  args: string[],
  options?: { env?: Record<string, string>; cwd?: string },
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("npx", ["tsx", scriptPath, ...args], {
    cwd: options?.cwd ?? projectRoot,
    encoding: "utf-8",
    env: { ...process.env, ...options?.env },
    timeout: 30000,
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

describe("state update CLI", { timeout: 60000 }, () => {
  let tempDir: string;
  let statePath: string;

  beforeEach(() => {
    // Create temp directory for test state files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "state-cli-test-"));
    statePath = path.join(tempDir, ".sequant", "state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Helper to run CLI in temp directory
  // Clear SEQUANT_ORCHESTRATOR by default so tests run the actual CLI logic
  const runInTemp = (
    args: string[],
    env?: Record<string, string>,
  ): ReturnType<typeof runCli> =>
    runCli(args, { cwd: tempDir, env: { SEQUANT_ORCHESTRATOR: "", ...env } });

  describe("pr command", () => {
    beforeEach(() => {
      // Initialize an issue first
      const result = runInTemp(["init", "42", "Test Issue"]);
      expect(result.status).toBe(0);
    });

    it("should record PR info for an issue", () => {
      const result = runInTemp([
        "pr",
        "42",
        "123",
        "https://github.com/owner/repo/pull/123",
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PR #123 linked to issue #42");

      // Verify state was updated
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.issues["42"].pr).toEqual({
        number: 123,
        url: "https://github.com/owner/repo/pull/123",
      });
    });

    it("should reject missing arguments", () => {
      const result = runInTemp(["pr", "42", "123"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: pr <issue> <pr-number> <pr-url>");
    });

    it("should reject invalid issue number", () => {
      const result = runInTemp([
        "pr",
        "not-a-number",
        "123",
        "https://github.com/owner/repo/pull/123",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: pr <issue> <pr-number> <pr-url>");
    });

    it("should reject invalid PR number", () => {
      const result = runInTemp([
        "pr",
        "42",
        "not-a-number",
        "https://github.com/owner/repo/pull/123",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Usage: pr <issue> <pr-number> <pr-url>");
    });

    it("should reject invalid URL", () => {
      const result = runInTemp(["pr", "42", "123", "not-a-valid-url"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid URL: not-a-valid-url");
    });

    it("should auto-initialize issue if not exists", () => {
      const result = runInTemp([
        "pr",
        "999",
        "456",
        "https://github.com/owner/repo/pull/456",
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PR #456 linked to issue #999");

      // Verify issue was initialized and PR recorded
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.issues["999"]).toBeDefined();
      expect(state.issues["999"].pr).toEqual({
        number: 456,
        url: "https://github.com/owner/repo/pull/456",
      });
    });

    it("should update existing PR info", () => {
      // First PR
      runInTemp(["pr", "42", "100", "https://github.com/owner/repo/pull/100"]);

      // Update to new PR
      const result = runInTemp([
        "pr",
        "42",
        "200",
        "https://github.com/owner/repo/pull/200",
      ]);

      expect(result.status).toBe(0);

      // Verify PR was updated
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.issues["42"].pr).toEqual({
        number: 200,
        url: "https://github.com/owner/repo/pull/200",
      });
    });

    it("should skip when SEQUANT_ORCHESTRATOR is set", () => {
      const result = runInTemp(
        ["pr", "42", "123", "https://github.com/owner/repo/pull/123"],
        { SEQUANT_ORCHESTRATOR: "fullsolve" },
      );

      // Script should exit early with success (orchestrator handles state)
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");

      // State should still have issue from beforeEach, but no PR info
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.issues["42"].pr).toBeUndefined();
    });
  });

  describe("help output", () => {
    it("should include pr command in usage", () => {
      // Clear SEQUANT_ORCHESTRATOR to ensure help is shown (not early exit)
      const result = runCli([], { env: { SEQUANT_ORCHESTRATOR: "" } });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "pr <issue> <pr-number> <url>  - Record PR info for issue",
      );
    });

    it("should include pr in valid commands list", () => {
      // Clear SEQUANT_ORCHESTRATOR to ensure error handling is triggered
      const result = runCli(["invalid-command"], {
        env: { SEQUANT_ORCHESTRATOR: "" },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("merged, pr");
    });
  });
});
