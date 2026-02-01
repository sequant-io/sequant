/**
 * Tests for the main assessment module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  validateVersion,
  checkGhCliAvailable,
  loadBaseline,
  isAlreadyAssessed,
} from "../assessment.js";
import { readFile, access } from "node:fs/promises";

// Mock node:child_process
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  access: vi.fn(),
  mkdir: vi.fn(),
}));

/**
 * Helper to create a mock spawn process
 */
function createMockProcess(
  stdout: string,
  stderr: string,
  exitCode: number,
): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  // Simulate async process completion
  setTimeout(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  }, 0);

  return proc;
}

describe("validateVersion", () => {
  it("accepts valid semver versions", () => {
    expect(() => validateVersion("v1.0.0")).not.toThrow();
    expect(() => validateVersion("v2.1.29")).not.toThrow();
    expect(() => validateVersion("1.0.0")).not.toThrow();
    expect(() => validateVersion("0.0.1")).not.toThrow();
    expect(() => validateVersion("10.20.30")).not.toThrow();
  });

  it("accepts versions with prerelease tags", () => {
    expect(() => validateVersion("v1.0.0-beta")).not.toThrow();
    expect(() => validateVersion("v1.0.0-beta.1")).not.toThrow();
    expect(() => validateVersion("v1.0.0-rc1")).not.toThrow();
    expect(() => validateVersion("1.0.0-alpha.2")).not.toThrow();
    expect(() => validateVersion("v1.0.0-canary.123")).not.toThrow();
  });

  it("rejects invalid version formats", () => {
    expect(() => validateVersion("invalid")).toThrow(/Invalid version format/);
    expect(() => validateVersion("1.0")).toThrow(/Invalid version format/);
    expect(() => validateVersion("v1")).toThrow(/Invalid version format/);
    expect(() => validateVersion("")).toThrow(/Invalid version format/);
    expect(() => validateVersion("latest")).toThrow(/Invalid version format/);
  });

  it("rejects versions with shell metacharacters", () => {
    expect(() => validateVersion("v1.0.0; echo test")).toThrow();
    expect(() => validateVersion("v1.0.0 && echo pwned")).toThrow();
    expect(() => validateVersion("v1.0.0 | cat")).toThrow();
    expect(() => validateVersion("$(whoami)")).toThrow();
    expect(() => validateVersion("v1.0.0\necho")).toThrow();
  });
});

describe("checkGhCliAvailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns available and authenticated when gh works", async () => {
    const mockSpawn = vi.mocked(spawn);

    // First call: gh --version (success)
    // Second call: gh auth status (success)
    mockSpawn
      .mockReturnValueOnce(createMockProcess("gh version 2.40.0", "", 0) as ReturnType<typeof spawn>)
      .mockReturnValueOnce(createMockProcess("Logged in to github.com", "", 0) as ReturnType<typeof spawn>);

    const result = await checkGhCliAvailable();

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("returns not available when gh is not installed", async () => {
    const mockSpawn = vi.mocked(spawn);

    // gh --version fails (not installed)
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setTimeout(() => proc.emit("error", new Error("ENOENT")), 0);

    mockSpawn.mockReturnValueOnce(proc as ReturnType<typeof spawn>);

    const result = await checkGhCliAvailable();

    expect(result.available).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("not installed");
  });

  it("returns not authenticated when gh auth fails", async () => {
    const mockSpawn = vi.mocked(spawn);

    // gh --version succeeds
    mockSpawn.mockReturnValueOnce(
      createMockProcess("gh version 2.40.0", "", 0) as ReturnType<typeof spawn>,
    );

    // gh auth status fails
    mockSpawn.mockReturnValueOnce(
      createMockProcess("", "You are not logged in", 1) as ReturnType<typeof spawn>,
    );

    const result = await checkGhCliAvailable();

    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(false);
    expect(result.error).toContain("not authenticated");
  });
});

describe("loadBaseline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads baseline from file when it exists", async () => {
    const mockBaseline = {
      lastAssessedVersion: "v2.1.25",
      schemaVersion: "1.0.0",
      tools: { core: ["Task"], optional: [] },
      hooks: { used: [], files: [] },
      mcpServers: { required: [], optional: [] },
      permissions: { patterns: [], files: [] },
      keywords: ["Task"],
      dependencyMap: {},
    };

    vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(mockBaseline));

    const result = await loadBaseline("/test/path/baseline.json");

    expect(result.lastAssessedVersion).toBe("v2.1.25");
    expect(result.schemaVersion).toBe("1.0.0");
    expect(result.tools.core).toContain("Task");
  });

  it("returns default baseline when file does not exist", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error("ENOENT"));

    const result = await loadBaseline("/nonexistent/baseline.json");

    // Should return default baseline
    expect(result.lastAssessedVersion).toBeNull();
    expect(result.schemaVersion).toBe("1.0.0");
    expect(result.tools.core).toContain("Task");
    expect(result.tools.core).toContain("Bash");
  });

  it("returns default baseline when file contains invalid JSON", async () => {
    vi.mocked(readFile).mockResolvedValueOnce("not valid json {{{");

    const result = await loadBaseline("/test/path/baseline.json");

    // Should return default baseline on parse error
    expect(result.lastAssessedVersion).toBeNull();
  });
});

describe("isAlreadyAssessed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns true when report file exists", async () => {
    vi.mocked(access).mockResolvedValueOnce(undefined);

    const result = await isAlreadyAssessed("v2.1.29");

    expect(result).toBe(true);
  });

  it("returns false when report file does not exist", async () => {
    vi.mocked(access).mockRejectedValueOnce(new Error("ENOENT"));

    const result = await isAlreadyAssessed("v2.1.29");

    expect(result).toBe(false);
  });
});
