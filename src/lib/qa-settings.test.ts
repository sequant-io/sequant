/**
 * Tests for QA settings in getSettings(): `smallDiffThreshold`,
 * `markdownOnlyCiRelaxed`, and `markdownOnlySafeCiPatterns`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_QA_SETTINGS, DEFAULT_SETTINGS } from "./settings.js";

// Mock fs module before imports
vi.mock("./fs.js", () => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  ensureDir: vi.fn(),
}));

import { fileExists, readFile } from "./fs.js";
import { getSettings } from "./settings.js";

const mockFileExists = vi.mocked(fileExists);
const mockReadFile = vi.mocked(readFile);

describe("QA settings", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should have default smallDiffThreshold of 100", () => {
    expect(DEFAULT_QA_SETTINGS.smallDiffThreshold).toBe(100);
    expect(DEFAULT_SETTINGS.qa.smallDiffThreshold).toBe(100);
  });

  it("should return default QA settings when no settings file exists", async () => {
    mockFileExists.mockResolvedValue(false);

    const settings = await getSettings();

    expect(settings.qa).toEqual(DEFAULT_QA_SETTINGS);
  });

  it("should return default QA settings when settings file has no qa section", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(JSON.stringify({ version: "1.0", run: {} }));

    const settings = await getSettings();

    expect(settings.qa).toEqual(DEFAULT_QA_SETTINGS);
  });

  it("should use custom smallDiffThreshold from settings file", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: "1.0",
        qa: { smallDiffThreshold: 50 },
      }),
    );

    const settings = await getSettings();

    expect(settings.qa.smallDiffThreshold).toBe(50);
  });

  it("should treat a 75-line diff as not small when threshold is 50", async () => {
    mockFileExists.mockResolvedValue(true);
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        version: "1.0",
        qa: { smallDiffThreshold: 50 },
      }),
    );

    const settings = await getSettings();
    const diffSize = 75;

    expect(diffSize < settings.qa.smallDiffThreshold).toBe(false);
  });

  it("should treat a 75-line diff as small with default threshold of 100", async () => {
    mockFileExists.mockResolvedValue(false);

    const settings = await getSettings();
    const diffSize = 75;

    expect(diffSize < settings.qa.smallDiffThreshold).toBe(true);
  });

  describe("markdownOnlyCiRelaxed", () => {
    it("defaults to true with the documented safe-pattern allowlist", () => {
      expect(DEFAULT_QA_SETTINGS.markdownOnlyCiRelaxed).toBe(true);
      expect(DEFAULT_QA_SETTINGS.markdownOnlySafeCiPatterns).toEqual([
        "build (*)",
        "Plugin Structure Validation",
      ]);
      expect(DEFAULT_SETTINGS.qa.markdownOnlyCiRelaxed).toBe(true);
    });

    it("returns defaults when the qa section is absent", async () => {
      mockFileExists.mockResolvedValue(false);

      const settings = await getSettings();

      expect(settings.qa.markdownOnlyCiRelaxed).toBe(true);
      expect(settings.qa.markdownOnlySafeCiPatterns).toEqual([
        "build (*)",
        "Plugin Structure Validation",
      ]);
    });

    it("honours an explicit false override", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: "1.0",
          qa: { markdownOnlyCiRelaxed: false },
        }),
      );

      const settings = await getSettings();

      expect(settings.qa.markdownOnlyCiRelaxed).toBe(false);
    });

    it("honours a custom safe-pattern allowlist", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: "1.0",
          qa: {
            markdownOnlySafeCiPatterns: ["test (*)", "Lint"],
          },
        }),
      );

      const settings = await getSettings();

      expect(settings.qa.markdownOnlySafeCiPatterns).toEqual([
        "test (*)",
        "Lint",
      ]);
    });
  });
});
