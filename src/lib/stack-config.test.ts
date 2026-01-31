import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  loadStackConfig,
  saveStackConfig,
  hasStackConfig,
  getPrimaryStack,
  getAllConfiguredStacks,
  type StackConfigFile,
} from "./stack-config.js";

// Mock the fs module
vi.mock("./fs.js", () => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  ensureDir: vi.fn(),
}));

import { fileExists, readFile, writeFile, ensureDir } from "./fs.js";

const mockFileExists = vi.mocked(fileExists);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockEnsureDir = vi.mocked(ensureDir);

describe("stack-config", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFileExists.mockResolvedValue(false);
    mockWriteFile.mockResolvedValue(undefined);
    mockEnsureDir.mockResolvedValue(undefined);
  });

  describe("loadStackConfig", () => {
    it("returns null when config file does not exist", async () => {
      mockFileExists.mockResolvedValue(false);

      const result = await loadStackConfig();
      expect(result).toBeNull();
    });

    it("returns config when file exists and is valid", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          primary: { name: "nextjs" },
          additional: [{ name: "python", path: "backend" }],
        }),
      );

      const result = await loadStackConfig();
      expect(result).toEqual({
        primary: { name: "nextjs" },
        additional: [{ name: "python", path: "backend" }],
      });
    });

    it("returns null when config is invalid JSON", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("invalid json");

      const result = await loadStackConfig();
      expect(result).toBeNull();
    });

    it("returns null when primary stack is missing", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          additional: [{ name: "python" }],
        }),
      );

      const result = await loadStackConfig();
      expect(result).toBeNull();
    });

    it("returns null when primary.name is missing", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          primary: { path: "frontend" },
        }),
      );

      const result = await loadStackConfig();
      expect(result).toBeNull();
    });
  });

  describe("saveStackConfig", () => {
    it("saves config to .sequant/stack.json", async () => {
      const config: StackConfigFile = {
        primary: { name: "nextjs" },
        additional: [{ name: "python" }],
      };

      await saveStackConfig(config);

      expect(mockEnsureDir).toHaveBeenCalledWith(".sequant");
      expect(mockWriteFile).toHaveBeenCalled();

      const savedContent = mockWriteFile.mock.calls[0][1] as string;
      const savedConfig = JSON.parse(savedContent);
      expect(savedConfig.primary).toEqual({ name: "nextjs" });
      expect(savedConfig.additional).toEqual([{ name: "python" }]);
      expect(savedConfig.lastUpdated).toBeDefined();
    });

    it("adds lastUpdated timestamp", async () => {
      const config: StackConfigFile = {
        primary: { name: "rust" },
      };

      await saveStackConfig(config);

      const savedContent = mockWriteFile.mock.calls[0][1] as string;
      const savedConfig = JSON.parse(savedContent);
      expect(savedConfig.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("hasStackConfig", () => {
    it("returns true when config file exists", async () => {
      mockFileExists.mockResolvedValue(true);

      const result = await hasStackConfig();
      expect(result).toBe(true);
    });

    it("returns false when config file does not exist", async () => {
      mockFileExists.mockResolvedValue(false);

      const result = await hasStackConfig();
      expect(result).toBe(false);
    });
  });

  describe("getPrimaryStack", () => {
    it("returns primary stack name when configured", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          primary: { name: "nextjs" },
        }),
      );

      const result = await getPrimaryStack();
      expect(result).toBe("nextjs");
    });

    it("returns null when not configured", async () => {
      mockFileExists.mockResolvedValue(false);

      const result = await getPrimaryStack();
      expect(result).toBeNull();
    });
  });

  describe("getAllConfiguredStacks", () => {
    it("returns all stacks when configured", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          primary: { name: "nextjs" },
          additional: [{ name: "python" }, { name: "go" }],
        }),
      );

      const result = await getAllConfiguredStacks();
      expect(result).toEqual(["nextjs", "python", "go"]);
    });

    it("returns only primary when no additional stacks", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          primary: { name: "rust" },
        }),
      );

      const result = await getAllConfiguredStacks();
      expect(result).toEqual(["rust"]);
    });

    it("returns empty array when not configured", async () => {
      mockFileExists.mockResolvedValue(false);

      const result = await getAllConfiguredStacks();
      expect(result).toEqual([]);
    });

    it("deduplicates stacks if primary is also in additional", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          primary: { name: "nextjs" },
          additional: [{ name: "nextjs" }, { name: "python" }],
        }),
      );

      const result = await getAllConfiguredStacks();
      expect(result).toEqual(["nextjs", "python"]);
    });
  });
});
