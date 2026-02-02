/**
 * Tests for QA Cache Module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import {
  QACache,
  resetQACache,
  CHECK_TYPES,
  type CheckType,
  type QACacheState,
} from "./qa-cache.js";

// Mock execSync for git commands
vi.mock("child_process", async () => {
  const actual = await vi.importActual("child_process");
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

const mockedExecSync = vi.mocked(execSync);

describe("QACache", () => {
  let tempDir: string;
  let cacheDir: string;
  let cache: QACache;

  beforeEach(() => {
    // Create temp directory for test cache files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-cache-test-"));
    cacheDir = path.join(tempDir, ".sequant", ".cache", "qa");
    cache = new QACache({ cacheDir });
    resetQACache();

    // Default mock for git diff
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd === "git diff main...HEAD") {
        return "mock diff content for testing";
      }
      if (cmd === "git diff main...HEAD --name-only") {
        return "src/test.ts\nlib/utils.ts";
      }
      return "";
    });
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe("getCachePath", () => {
    it("should return the correct cache path", () => {
      const cachePath = cache.getCachePath();
      expect(cachePath).toBe(path.join(cacheDir, "cache.json"));
    });
  });

  describe("computeDiffHash", () => {
    it("should compute consistent hash for same diff", () => {
      const hash1 = cache.computeDiffHash();
      const hash2 = cache.computeDiffHash();
      expect(hash1).toBe(hash2);
    });

    it("should return 16 character hex string", () => {
      const hash = cache.computeDiffHash();
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it("should return different hash for different diff content", () => {
      const hash1 = cache.computeDiffHash();

      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === "git diff main...HEAD") {
          return "different diff content";
        }
        return "";
      });

      cache.clearMemoryCache();
      const hash2 = cache.computeDiffHash();
      expect(hash1).not.toBe(hash2);
    });

    it("should return fallback hash when git fails", () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("git command failed");
      });

      const hash = cache.computeDiffHash();
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  describe("computeConfigHash", () => {
    beforeEach(() => {
      // Create some config files
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, "tsconfig.json"),
        '{"compilerOptions":{}}',
      );
      fs.writeFileSync(path.join(tempDir, "package.json"), '{"name":"test"}');
    });

    it("should return 16 character hex string", () => {
      const originalCwd = process.cwd();
      process.chdir(tempDir);
      try {
        const hash = cache.computeConfigHash("type-safety");
        expect(hash).toMatch(/^[a-f0-9]{16}$/);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe("getState", () => {
    it("should return empty state when cache does not exist", async () => {
      const state = await cache.getState();

      expect(state.version).toBe(1);
      expect(state.checks).toEqual({});
    });

    it("should read and parse existing cache file", async () => {
      // Create cache file
      const existingState: QACacheState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        checks: {
          "type-safety": {
            checkType: "type-safety",
            diffHash: "abc123",
            configHash: "def456",
            cachedAt: new Date().toISOString(),
            ttl: 3600000,
            result: {
              passed: true,
              message: "No type issues",
            },
          },
        },
      };

      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, "cache.json"),
        JSON.stringify(existingState),
      );

      const state = await cache.getState();

      expect(state.checks["type-safety"]).toBeDefined();
      expect(state.checks["type-safety"]?.result.passed).toBe(true);
    });

    it("should handle corrupted cache gracefully (AC-6)", async () => {
      // Create corrupted cache file
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, "cache.json"), "not valid json {");

      // Should not throw, should return empty state
      const state = await cache.getState();
      expect(state.version).toBe(1);
      expect(state.checks).toEqual({});
    });

    it("should handle invalid schema gracefully (AC-6)", async () => {
      // Create cache file with invalid schema
      const invalidState = {
        version: 999, // Invalid version
        checks: {},
      };

      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, "cache.json"),
        JSON.stringify(invalidState),
      );

      // Should not throw, should return empty state
      const state = await cache.getState();
      expect(state.version).toBe(1);
    });

    it("should cache state after first read", async () => {
      const state1 = await cache.getState();
      const state2 = await cache.getState();

      expect(state1).toBe(state2); // Same object reference
    });
  });

  describe("saveState", () => {
    it("should create directory and write cache file", async () => {
      const state: QACacheState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        checks: {},
      };

      await cache.saveState(state);

      const cachePath = cache.getCachePath();
      expect(fs.existsSync(cachePath)).toBe(true);
    });

    it("should update lastUpdated timestamp", async () => {
      const state: QACacheState = {
        version: 1,
        lastUpdated: "2024-01-01T00:00:00.000Z",
        checks: {},
      };

      await cache.saveState(state);

      const cachePath = cache.getCachePath();
      const savedContent = fs.readFileSync(cachePath, "utf-8");
      const savedState = JSON.parse(savedContent);
      expect(savedState.lastUpdated).not.toBe("2024-01-01T00:00:00.000Z");
    });
  });

  describe("get", () => {
    it("should return miss when check not in cache", async () => {
      const result = await cache.get("type-safety");

      expect(result.hit).toBe(false);
      expect(result.missReason).toBe("not-found");
    });

    it("should return hit when check is cached and valid", async () => {
      const diffHash = cache.computeDiffHash();
      const configHash = cache.computeConfigHash("type-safety");

      // Pre-populate cache
      const state: QACacheState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        checks: {
          "type-safety": {
            checkType: "type-safety",
            diffHash,
            configHash,
            cachedAt: new Date().toISOString(),
            ttl: 3600000, // 1 hour
            result: {
              passed: true,
              message: "No type issues",
            },
          },
        },
      };

      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, "cache.json"),
        JSON.stringify(state),
      );
      cache.clearMemoryCache();

      const result = await cache.get("type-safety");

      expect(result.hit).toBe(true);
      expect(result.isStale).toBe(false);
      expect(result.result?.passed).toBe(true);
    });

    it("should return expired when TTL exceeded", async () => {
      const diffHash = cache.computeDiffHash();
      const configHash = cache.computeConfigHash("type-safety");

      // Pre-populate cache with expired entry
      const expiredTime = new Date(Date.now() - 2 * 3600000); // 2 hours ago
      const state: QACacheState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        checks: {
          "type-safety": {
            checkType: "type-safety",
            diffHash,
            configHash,
            cachedAt: expiredTime.toISOString(),
            ttl: 3600000, // 1 hour TTL
            result: {
              passed: true,
              message: "No type issues",
            },
          },
        },
      };

      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, "cache.json"),
        JSON.stringify(state),
      );
      cache.clearMemoryCache();

      const result = await cache.get("type-safety");

      expect(result.hit).toBe(false);
      expect(result.isStale).toBe(true);
      expect(result.missReason).toBe("expired");
    });

    it("should return hash-mismatch when diff changed (AC-2)", async () => {
      // Pre-populate cache with different diff hash
      const state: QACacheState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        checks: {
          "type-safety": {
            checkType: "type-safety",
            diffHash: "old_hash_12345678",
            configHash: cache.computeConfigHash("type-safety"),
            cachedAt: new Date().toISOString(),
            ttl: 3600000,
            result: {
              passed: true,
              message: "No type issues",
            },
          },
        },
      };

      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, "cache.json"),
        JSON.stringify(state),
      );
      cache.clearMemoryCache();

      const result = await cache.get("type-safety");

      expect(result.hit).toBe(false);
      expect(result.missReason).toBe("hash-mismatch");
    });
  });

  describe("set", () => {
    it("should cache check result (AC-1)", async () => {
      await cache.set("type-safety", {
        passed: true,
        message: "No type issues found",
        details: { count: 0 },
      });

      const result = await cache.get("type-safety");

      expect(result.hit).toBe(true);
      expect(result.result?.passed).toBe(true);
      expect(result.result?.message).toBe("No type issues found");
    });

    it("should use custom TTL when provided", async () => {
      const shortTtl = 1000; // 1 second

      await cache.set(
        "security",
        { passed: true, message: "No issues" },
        shortTtl,
      );

      const state = await cache.getState();
      expect(state.checks["security"]?.ttl).toBe(shortTtl);
    });

    it("should store diff hash and config hash", async () => {
      await cache.set("build", { passed: true, message: "Build succeeded" });

      const state = await cache.getState();
      expect(state.checks["build"]?.diffHash).toMatch(/^[a-f0-9]{16}$/);
      expect(state.checks["build"]?.configHash).toMatch(/^[a-f0-9]{16}$/);
    });
  });

  describe("clear", () => {
    it("should remove specific check from cache", async () => {
      await cache.set("type-safety", { passed: true, message: "OK" });
      await cache.set("security", { passed: true, message: "OK" });

      await cache.clear("type-safety");

      const state = await cache.getState();
      expect(state.checks["type-safety"]).toBeUndefined();
      expect(state.checks["security"]).toBeDefined();
    });
  });

  describe("clearAll (AC-3 --no-cache support)", () => {
    it("should remove all cached results", async () => {
      await cache.set("type-safety", { passed: true, message: "OK" });
      await cache.set("security", { passed: true, message: "OK" });
      await cache.set("build", { passed: true, message: "OK" });

      await cache.clearAll();

      const state = await cache.getState();
      expect(Object.keys(state.checks).length).toBe(0);
    });
  });

  describe("getStatus (AC-4 cache hit/miss reporting)", () => {
    it("should return status for all check types", async () => {
      await cache.set("type-safety", { passed: true, message: "OK" });

      const status = await cache.getStatus();

      expect(status["type-safety"].hit).toBe(true);
      expect(status["security"].hit).toBe(false);
      expect(status["security"].missReason).toBe("not-found");
    });

    it("should include all check types", async () => {
      const status = await cache.getStatus();

      for (const checkType of CHECK_TYPES) {
        expect(status[checkType]).toBeDefined();
      }
    });
  });

  describe("checkGlobalInvalidation", () => {
    it("should return true when package-lock.json changed", async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === "git diff main...HEAD --name-only") {
          return "package-lock.json\nsrc/test.ts";
        }
        return "";
      });

      const invalidated = await cache.checkGlobalInvalidation();
      expect(invalidated).toBe(true);
    });

    it("should return true when tsconfig.json changed", async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === "git diff main...HEAD --name-only") {
          return "tsconfig.json";
        }
        return "";
      });

      const invalidated = await cache.checkGlobalInvalidation();
      expect(invalidated).toBe(true);
    });

    it("should return false when only source files changed", async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === "git diff main...HEAD --name-only") {
          return "src/components/Button.tsx\nlib/utils.ts";
        }
        return "";
      });

      const invalidated = await cache.checkGlobalInvalidation();
      expect(invalidated).toBe(false);
    });
  });

  describe("checkTypeSpecificInvalidation", () => {
    it("should detect test file changes for deleted-tests check", async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === "git diff main...HEAD --name-only") {
          return "src/lib/utils.test.ts";
        }
        return "";
      });

      const invalidated =
        await cache.checkTypeSpecificInvalidation("deleted-tests");
      expect(invalidated).toBe(true);
    });

    it("should detect TypeScript changes for type-safety check", async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === "git diff main...HEAD --name-only") {
          return "src/components/Button.tsx";
        }
        return "";
      });

      const invalidated =
        await cache.checkTypeSpecificInvalidation("type-safety");
      expect(invalidated).toBe(true);
    });

    it("should not invalidate scope check for file type changes", async () => {
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === "git diff main...HEAD --name-only") {
          return "src/components/Button.tsx";
        }
        return "";
      });

      // scope check uses diff hash, not file patterns
      const invalidated = await cache.checkTypeSpecificInvalidation("scope");
      expect(invalidated).toBe(false);
    });
  });

  describe("clearMemoryCache", () => {
    it("should force re-read on next access", async () => {
      await cache.set("type-safety", { passed: true, message: "OK" });

      // Modify file directly
      const state: QACacheState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        checks: {
          "type-safety": {
            checkType: "type-safety",
            diffHash: cache.computeDiffHash(),
            configHash: cache.computeConfigHash("type-safety"),
            cachedAt: new Date().toISOString(),
            ttl: 3600000,
            result: {
              passed: false,
              message: "MODIFIED",
            },
          },
        },
      };
      fs.writeFileSync(
        path.join(cacheDir, "cache.json"),
        JSON.stringify(state),
      );

      // Without clear, should return cached (passed: true)
      const cached = await cache.get("type-safety");
      expect(cached.result?.passed).toBe(true);

      // After clear, should read from file (passed: false)
      cache.clearMemoryCache();
      const fresh = await cache.get("type-safety");
      expect(fresh.result?.passed).toBe(false);
    });
  });

  describe("verbose logging (AC-7)", () => {
    it("should log when verbose mode enabled", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const verboseCache = new QACache({ cacheDir, verbose: true });

      await verboseCache.set("type-safety", { passed: true, message: "OK" });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[qa-cache]"),
      );
      consoleSpy.mockRestore();
    });

    it("should not log when verbose mode disabled", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const quietCache = new QACache({ cacheDir, verbose: false });

      await quietCache.set("type-safety", { passed: true, message: "OK" });

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("AC-5: No false positives (stale cache causing missed issues)", () => {
    it("should invalidate cache when code changes", async () => {
      // Initial cache with passing result
      await cache.set("security", {
        passed: true,
        message: "No security issues",
      });

      // Simulate code change
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === "git diff main...HEAD") {
          return "new different diff content with security issue";
        }
        return "";
      });
      cache.clearMemoryCache();

      // Should miss cache due to different diff hash
      const result = await cache.get("security");
      expect(result.hit).toBe(false);
      expect(result.missReason).toBe("hash-mismatch");
    });

    it("should not return stale results after TTL expiry", async () => {
      // Create cache with very short TTL that's already expired
      const expiredTime = new Date(Date.now() - 10000); // 10 seconds ago

      const state: QACacheState = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        checks: {
          tests: {
            checkType: "tests",
            diffHash: cache.computeDiffHash(),
            configHash: cache.computeConfigHash("tests"),
            cachedAt: expiredTime.toISOString(),
            ttl: 1000, // 1 second TTL (already expired)
            result: {
              passed: true,
              message: "All tests pass",
            },
          },
        },
      };

      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, "cache.json"),
        JSON.stringify(state),
      );
      cache.clearMemoryCache();

      const result = await cache.get("tests");
      expect(result.hit).toBe(false);
      expect(result.isStale).toBe(true);
    });
  });

  describe("integration: full cache workflow", () => {
    it("should support complete cache -> check -> invalidate cycle", async () => {
      // 1. Initially empty cache
      let result = await cache.get("build");
      expect(result.hit).toBe(false);

      // 2. Cache a result
      await cache.set("build", {
        passed: true,
        message: "Build succeeded",
        details: { duration: 5000 },
      });

      // 3. Cache hit on same diff
      result = await cache.get("build");
      expect(result.hit).toBe(true);
      expect(result.result?.passed).toBe(true);

      // 4. Code changes -> cache miss
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd === "git diff main...HEAD") {
          return "completely new diff after changes";
        }
        return "";
      });
      cache.clearMemoryCache();

      result = await cache.get("build");
      expect(result.hit).toBe(false);

      // 5. Re-cache with new hash
      await cache.set("build", {
        passed: false,
        message: "Build failed",
        details: { error: "Type error" },
      });

      // 6. New cache hit
      result = await cache.get("build");
      expect(result.hit).toBe(true);
      expect(result.result?.passed).toBe(false);
    });
  });
});
