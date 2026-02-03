import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs functions
vi.mock("../lib/fs.js", () => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

// Mock manifest
vi.mock("../lib/manifest.js", () => ({
  getManifest: vi.fn(),
  updateManifest: vi.fn(),
  getPackageVersion: vi.fn(() => "1.1.0"),
}));

// Mock templates
vi.mock("../lib/templates.js", () => ({
  copyTemplates: vi.fn(),
}));

// Mock config
vi.mock("../lib/config.js", () => ({
  getConfig: vi.fn(),
}));

import { getSkillsVersion, areSkillsOutdated, syncCommand } from "./sync.js";
import { fileExists, readFile, writeFile } from "../lib/fs.js";
import { getManifest, getPackageVersion } from "../lib/manifest.js";
import { copyTemplates } from "../lib/templates.js";
import { getConfig } from "../lib/config.js";

const mockFileExists = vi.mocked(fileExists);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockGetManifest = vi.mocked(getManifest);
const mockGetPackageVersion = vi.mocked(getPackageVersion);
const mockCopyTemplates = vi.mocked(copyTemplates);
const mockGetConfig = vi.mocked(getConfig);

describe("sync command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  describe("getSkillsVersion", () => {
    it("returns null when version file does not exist", async () => {
      mockFileExists.mockResolvedValue(false);

      const version = await getSkillsVersion();

      expect(version).toBeNull();
    });

    it("returns version from file when it exists", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0\n");

      const version = await getSkillsVersion();

      expect(version).toBe("1.0.0");
    });
  });

  describe("areSkillsOutdated", () => {
    it("returns outdated true when versions differ", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(true);
      expect(result.currentVersion).toBe("1.0.0");
      expect(result.packageVersion).toBe("1.1.0");
    });

    it("returns outdated false when versions match", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(false);
    });

    it("returns outdated true when version file missing", async () => {
      mockFileExists.mockResolvedValue(false);
      mockGetPackageVersion.mockReturnValue("1.1.0");

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(true);
      expect(result.currentVersion).toBeNull();
    });
  });

  describe("syncCommand", () => {
    it("fails when manifest does not exist", async () => {
      mockGetManifest.mockResolvedValue(null);

      await syncCommand();

      expect(process.exitCode).toBe(1);
    });

    it("skips sync when versions match and force not set", async () => {
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");

      await syncCommand({ quiet: true });

      expect(mockCopyTemplates).not.toHaveBeenCalled();
    });

    it("syncs when versions differ", async () => {
      mockGetManifest.mockResolvedValue({
        version: "1.0.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockCopyTemplates.mockResolvedValue({ scriptsSymlinked: false });

      await syncCommand({ quiet: true });

      expect(mockCopyTemplates).toHaveBeenCalledWith(
        "nextjs",
        {},
        { force: true },
      );
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it("syncs when force is set even if versions match", async () => {
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockCopyTemplates.mockResolvedValue({ scriptsSymlinked: false });

      await syncCommand({ force: true, quiet: true });

      expect(mockCopyTemplates).toHaveBeenCalled();
    });
  });
});
