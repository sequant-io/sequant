/**
 * Unit tests for token-utils (AC-5, AC-6, AC-12)
 *
 * Tests the token usage parsing utilities for pipeline observability.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import {
  parseTokenJsonFile,
  readTokenUsageFiles,
  aggregateTokenUsage,
  getTokenUsageForRun,
  cleanupTokenFiles,
  isTokenUsageFile,
  extractSessionId,
  type TokenUsageData,
} from "./token-utils.js";

// Mock fs module
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const mockedFs = vi.mocked(fs);

describe("token-utils", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("isTokenUsageFile", () => {
    it("should match valid token usage filenames", () => {
      expect(isTokenUsageFile(".token-usage-abc123.json")).toBe(true);
      expect(isTokenUsageFile(".token-usage-session-1.json")).toBe(true);
      expect(isTokenUsageFile(".token-usage-1234567890.json")).toBe(true);
    });

    it("should reject invalid filenames", () => {
      expect(isTokenUsageFile("token-usage.json")).toBe(false);
      // Note: ".token-usage-.json" is technically valid (empty session ID)
      expect(isTokenUsageFile(".token-usage-abc123.txt")).toBe(false);
      expect(isTokenUsageFile("other-file.json")).toBe(false);
    });
  });

  describe("extractSessionId", () => {
    it("should extract session ID from valid filename", () => {
      expect(extractSessionId(".token-usage-abc123.json")).toBe("abc123");
      expect(extractSessionId(".token-usage-session-1.json")).toBe("session-1");
    });

    it("should return undefined for invalid filename", () => {
      expect(extractSessionId("invalid.json")).toBeUndefined();
      expect(extractSessionId(".token-usage-.json")).toBeUndefined();
    });
  });

  describe("parseTokenJsonFile (AC-5)", () => {
    it("should parse valid token usage JSON", () => {
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          input_tokens: 1000,
          output_tokens: 500,
          cache_creation_tokens: 100,
          cache_read_tokens: 50,
          timestamp: "2024-01-01T00:00:00Z",
          session_id: "abc123",
        }),
      );

      const result = parseTokenJsonFile("/path/to/file.json");

      expect(result).toEqual({
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_tokens: 100,
        cache_read_tokens: 50,
        timestamp: "2024-01-01T00:00:00Z",
        session_id: "abc123",
      });
    });

    it("should handle missing optional fields", () => {
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          input_tokens: 1000,
          output_tokens: 500,
        }),
      );

      const result = parseTokenJsonFile("/path/to/file.json");

      expect(result).toEqual({
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        timestamp: undefined,
        session_id: undefined,
      });
    });

    it("should return null for empty file", () => {
      mockedFs.readFileSync.mockReturnValue("");

      const result = parseTokenJsonFile("/path/to/file.json");

      expect(result).toBeNull();
    });

    it("should return null for invalid JSON", () => {
      mockedFs.readFileSync.mockReturnValue("not json");

      const result = parseTokenJsonFile("/path/to/file.json");

      expect(result).toBeNull();
    });

    it("should return null for non-object JSON", () => {
      mockedFs.readFileSync.mockReturnValue("[]");

      const result = parseTokenJsonFile("/path/to/file.json");

      expect(result).toBeNull();
    });

    it("should treat non-numeric values as 0", () => {
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          input_tokens: "not a number",
          output_tokens: null,
        }),
      );

      const result = parseTokenJsonFile("/path/to/file.json");

      expect(result?.input_tokens).toBe(0);
      expect(result?.output_tokens).toBe(0);
    });

    it("should treat negative values as 0", () => {
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          input_tokens: -100,
          output_tokens: -50,
        }),
      );

      const result = parseTokenJsonFile("/path/to/file.json");

      expect(result?.input_tokens).toBe(0);
      expect(result?.output_tokens).toBe(0);
    });

    it("should return null on file read error", () => {
      mockedFs.readFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file");
      });

      const result = parseTokenJsonFile("/nonexistent/file.json");

      expect(result).toBeNull();
    });
  });

  describe("readTokenUsageFiles", () => {
    it("should read all token files from directory", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        ".token-usage-session1.json",
        ".token-usage-session2.json",
        "other-file.txt",
      ] as unknown as fs.Dirent[]);
      mockedFs.readFileSync.mockImplementation((filePath) => {
        if (String(filePath).includes("session1")) {
          return JSON.stringify({ input_tokens: 100, output_tokens: 50 });
        }
        if (String(filePath).includes("session2")) {
          return JSON.stringify({ input_tokens: 200, output_tokens: 100 });
        }
        return "";
      });

      const result = readTokenUsageFiles(".sequant");

      expect(result).toHaveLength(2);
      expect(result[0].input_tokens).toBe(100);
      expect(result[1].input_tokens).toBe(200);
    });

    it("should return empty array for non-existent directory", () => {
      mockedFs.existsSync.mockReturnValue(false);

      const result = readTokenUsageFiles(".sequant");

      expect(result).toEqual([]);
    });

    it("should skip invalid token files", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        ".token-usage-good.json",
        ".token-usage-bad.json",
      ] as unknown as fs.Dirent[]);
      mockedFs.readFileSync.mockImplementation((filePath) => {
        if (String(filePath).includes("good")) {
          return JSON.stringify({ input_tokens: 100, output_tokens: 50 });
        }
        return "invalid json";
      });

      const result = readTokenUsageFiles(".sequant");

      expect(result).toHaveLength(1);
    });
  });

  describe("aggregateTokenUsage (AC-6)", () => {
    it("should sum tokens from multiple sessions", () => {
      const tokenData: TokenUsageData[] = [
        { input_tokens: 100, output_tokens: 50 },
        { input_tokens: 200, output_tokens: 100 },
        { input_tokens: 300, output_tokens: 150 },
      ];

      const result = aggregateTokenUsage(tokenData);

      expect(result.inputTokens).toBe(600);
      expect(result.outputTokens).toBe(300);
      expect(result.tokensUsed).toBe(900);
    });

    it("should sum cache tokens correctly", () => {
      const tokenData: TokenUsageData[] = [
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_tokens: 10,
          cache_read_tokens: 5,
        },
        {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_tokens: 20,
          cache_read_tokens: 15,
        },
      ];

      const result = aggregateTokenUsage(tokenData);

      expect(result.cacheTokens).toBe(50); // 10+5+20+15
    });

    it("should return zeros for empty array", () => {
      const result = aggregateTokenUsage([]);

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.cacheTokens).toBe(0);
      expect(result.tokensUsed).toBe(0);
    });
  });

  describe("cleanupTokenFiles", () => {
    it("should delete token files from directory", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        ".token-usage-session1.json",
        ".token-usage-session2.json",
        "other-file.txt",
      ] as unknown as fs.Dirent[]);

      cleanupTokenFiles(".sequant");

      // Should only delete token files
      expect(mockedFs.unlinkSync).toHaveBeenCalledTimes(2);
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining(".token-usage-session1.json"),
      );
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining(".token-usage-session2.json"),
      );
    });

    it("should handle non-existent directory", () => {
      mockedFs.existsSync.mockReturnValue(false);

      // Should not throw
      cleanupTokenFiles(".sequant");

      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
    });

    it("should ignore individual file deletion errors", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        ".token-usage-session1.json",
      ] as unknown as fs.Dirent[]);
      mockedFs.unlinkSync.mockImplementation(() => {
        throw new Error("Permission denied");
      });

      // Should not throw
      cleanupTokenFiles(".sequant");
    });
  });

  describe("getTokenUsageForRun (AC-6)", () => {
    it("should read, aggregate, and cleanup token files", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        ".token-usage-session1.json",
      ] as unknown as fs.Dirent[]);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ input_tokens: 1000, output_tokens: 500 }),
      );

      const result = getTokenUsageForRun(".sequant", true);

      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.tokensUsed).toBe(1500);
      expect(mockedFs.unlinkSync).toHaveBeenCalled();
    });

    it("should not cleanup when cleanup=false", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        ".token-usage-session1.json",
      ] as unknown as fs.Dirent[]);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ input_tokens: 1000, output_tokens: 500 }),
      );

      getTokenUsageForRun(".sequant", false);

      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();
    });

    it("should return zeros when no token files exist", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([] as unknown as fs.Dirent[]);

      const result = getTokenUsageForRun(".sequant");

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.tokensUsed).toBe(0);
    });
  });
});
