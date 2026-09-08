/**
 * Unit tests for token-utils (AC-5, AC-6, AC-12)
 *
 * Tests the token usage parsing utilities for pipeline observability.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  parseTokenJsonFile,
  readTokenUsageFiles,
  aggregateTokenUsage,
  getTokenUsageForRun,
  cleanupTokenFiles,
  isTokenUsageFile,
  extractSessionId,
  readWorktreeTokenUsage,
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

  describe("readWorktreeTokenUsage (#986 AC-4)", () => {
    it("986 anchors the read at <worktreePath>/.sequant, not the process cwd", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        ".token-usage-session1.json",
      ] as unknown as fs.Dirent[]);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ input_tokens: 1000, output_tokens: 500 }),
      );

      const result = readWorktreeTokenUsage("/wt/feature-986", {
        cleanup: false,
      });

      expect(result.tokensUsed).toBe(1500);
      expect(mockedFs.readdirSync).toHaveBeenCalledWith(
        path.join("/wt/feature-986", ".sequant"),
      );
      // The pre-#986 defect: a bare-relative ".sequant" resolving to whatever
      // process.cwd() happened to be (the main checkout).
      expect(mockedFs.readdirSync).not.toHaveBeenCalledWith(".sequant");
    });

    it("986 deletes the files only when cleanup is requested", () => {
      mockedFs.existsSync.mockReturnValue(true);
      mockedFs.readdirSync.mockReturnValue([
        ".token-usage-session1.json",
      ] as unknown as fs.Dirent[]);
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ input_tokens: 10, output_tokens: 5 }),
      );

      readWorktreeTokenUsage("/wt/feature-986", { cleanup: false });
      expect(mockedFs.unlinkSync).not.toHaveBeenCalled();

      readWorktreeTokenUsage("/wt/feature-986", { cleanup: true });
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        path.join("/wt/feature-986", ".sequant", ".token-usage-session1.json"),
      );
    });
  });

  /**
   * #986 AC-3 — the SessionEnd hook itself.
   *
   * `capture-tokens.sh` extracted `.usage`, but Claude Code transcripts carry
   * usage at `.message.usage`: the old jq matched 0 lines on every real
   * transcript, so every token file the hook ever wrote was all zeros. The
   * fixture is a real transcript excerpt and deliberately contains a
   * DUPLICATED `message.id` (streaming/compaction re-emits the same assistant
   * message) plus one legacy top-level `.usage` line — so this test fails both
   * if the jq path regresses and if the dedupe is dropped.
   */
  describe("capture-tokens.sh (#986 AC-3)", () => {
    const FIXTURE = "src/lib/workflow/__fixtures__/transcript-usage-986.jsonl";
    const HOOK = "templates/hooks/capture-tokens.sh";

    // Deduped by message.id (66/1160/59212/217576 from the 3 unique assistant
    // messages) plus the id-less legacy line (7/11/13/17). Summing every line
    // instead would give input_tokens 75, not 73.
    const EXPECTED = {
      input_tokens: 73,
      output_tokens: 1171,
      cache_creation_tokens: 59225,
      cache_read_tokens: 217593,
    };

    it("986 hook sums .message.usage from a real transcript, deduped by message.id", async () => {
      const realFs = await vi.importActual<typeof import("fs")>("fs");
      const os = await vi.importActual<typeof import("os")>("os");
      const cp =
        await vi.importActual<typeof import("child_process")>("child_process");

      const hookPath = path.resolve(HOOK);
      const transcriptPath = path.resolve(FIXTURE);
      expect(realFs.existsSync(hookPath)).toBe(true);
      expect(realFs.existsSync(transcriptPath)).toBe(true);

      const tmp = realFs.mkdtempSync(path.join(os.tmpdir(), "sequant-986-"));
      try {
        cp.execFileSync("bash", [hookPath], {
          cwd: tmp,
          input: JSON.stringify({
            transcript_path: transcriptPath,
            session_id: "fx",
          }),
        });

        const written = path.join(tmp, ".sequant", ".token-usage-fx.json");
        expect(realFs.existsSync(written)).toBe(true);
        const parsed = JSON.parse(realFs.readFileSync(written, "utf-8"));

        expect(parsed.input_tokens).toBe(EXPECTED.input_tokens);
        expect(parsed.output_tokens).toBe(EXPECTED.output_tokens);
        expect(parsed.cache_creation_tokens).toBe(
          EXPECTED.cache_creation_tokens,
        );
        expect(parsed.cache_read_tokens).toBe(EXPECTED.cache_read_tokens);
        expect(parsed.session_id).toBe("fx");
      } finally {
        realFs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 20_000);

    it("986 hook is byte-identical across templates/, .claude/ and the plugin hooks/ dir", async () => {
      const realFs = await vi.importActual<typeof import("fs")>("fs");
      const copies = [
        "templates/hooks/capture-tokens.sh",
        ".claude/hooks/capture-tokens.sh",
        "hooks/capture-tokens.sh",
      ].map((rel) => {
        const abs = path.resolve(rel);
        expect(realFs.existsSync(abs)).toBe(true);
        return realFs.readFileSync(abs);
      });

      expect(copies[1].equals(copies[0])).toBe(true);
      expect(copies[2].equals(copies[0])).toBe(true);
    });

    it("986 hook registers SessionEnd on both the plugin and project surfaces", async () => {
      const realFs = await vi.importActual<typeof import("fs")>("fs");
      for (const rel of ["hooks/hooks.json", "templates/settings.json"]) {
        const cfg = JSON.parse(
          realFs.readFileSync(path.resolve(rel), "utf-8"),
        ) as {
          hooks: Record<
            string,
            Array<{ hooks: Array<{ command: string }> }> | undefined
          >;
        };
        const sessionEnd = cfg.hooks.SessionEnd ?? [];
        const commands = sessionEnd.flatMap((e) =>
          e.hooks.map((h) => h.command),
        );
        expect(
          commands.some((c) => c.includes("capture-tokens.sh")),
          `${rel} must register capture-tokens.sh on SessionEnd`,
        ).toBe(true);
      }
    });
  });
});
