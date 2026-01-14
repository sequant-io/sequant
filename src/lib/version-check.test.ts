import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

// Mock fs module
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  compareVersions,
  isOutdated,
  getVersionWarning,
  getCacheDir,
  getCachePath,
  readCache,
  writeCache,
  isCacheFresh,
  getCurrentVersion,
  fetchLatestVersion,
  checkVersionThorough,
  checkVersionCached,
} from "./version-check.js";

const mockFs = vi.mocked(fs);

describe("version-check utilities", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv, HOME: "/home/user" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("compareVersions", () => {
    it("returns 0 for equal versions", () => {
      expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
      expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    });

    it("returns -1 when first version is less than second", () => {
      expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
      expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
      expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
      expect(compareVersions("1.5.2", "1.5.3")).toBe(-1);
    });

    it("returns 1 when first version is greater than second", () => {
      expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
      expect(compareVersions("1.1.0", "1.0.0")).toBe(1);
      expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
      expect(compareVersions("1.5.3", "1.5.2")).toBe(1);
    });

    it("handles versions with different segment counts", () => {
      expect(compareVersions("1.0", "1.0.0")).toBe(0);
      expect(compareVersions("1.0.0", "1.0")).toBe(0);
      expect(compareVersions("1.0", "1.0.1")).toBe(-1);
    });

    it("handles v prefix", () => {
      expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
      expect(compareVersions("1.0.0", "v1.0.0")).toBe(0);
      expect(compareVersions("v1.0.0", "v1.0.1")).toBe(-1);
    });
  });

  describe("isOutdated", () => {
    it("returns true when current version is less than latest", () => {
      expect(isOutdated("1.0.0", "1.0.1")).toBe(true);
      expect(isOutdated("1.5.2", "1.5.3")).toBe(true);
    });

    it("returns false when current version is equal to latest", () => {
      expect(isOutdated("1.0.0", "1.0.0")).toBe(false);
    });

    it("returns false when current version is greater than latest", () => {
      expect(isOutdated("1.0.1", "1.0.0")).toBe(false);
    });
  });

  describe("getVersionWarning", () => {
    it("returns a formatted warning message", () => {
      const warning = getVersionWarning("1.0.0", "1.5.3");
      expect(warning).toContain("1.5.3 is available");
      expect(warning).toContain("you have 1.0.0");
      expect(warning).toContain("npx sequant@latest");
    });
  });

  describe("getCacheDir", () => {
    it("returns ~/.cache/sequant path", () => {
      const cacheDir = getCacheDir();
      expect(cacheDir).toBe("/home/user/.cache/sequant");
    });
  });

  describe("getCachePath", () => {
    it("returns the version-check.json path in cache dir", () => {
      const cachePath = getCachePath();
      expect(cachePath).toBe("/home/user/.cache/sequant/version-check.json");
    });
  });

  describe("readCache", () => {
    it("returns null when cache file does not exist", () => {
      mockFs.existsSync.mockReturnValue(false);
      expect(readCache()).toBeNull();
    });

    it("returns cache data when file exists and is valid", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          latestVersion: "1.5.3",
          checkedAt: "2024-01-15T10:30:00Z",
        }),
      );

      const cache = readCache();
      expect(cache).toEqual({
        latestVersion: "1.5.3",
        checkedAt: "2024-01-15T10:30:00Z",
      });
    });

    it("returns null when cache file is invalid JSON", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue("invalid json");

      expect(readCache()).toBeNull();
    });
  });

  describe("writeCache", () => {
    it("creates cache directory if it does not exist", () => {
      mockFs.existsSync.mockReturnValue(false);

      writeCache("1.5.3");

      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        "/home/user/.cache/sequant",
        { recursive: true },
      );
    });

    it("writes cache data to file", () => {
      mockFs.existsSync.mockReturnValue(true);

      writeCache("1.5.3");

      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const [filePath, content] = mockFs.writeFileSync.mock.calls[0];
      expect(filePath).toBe("/home/user/.cache/sequant/version-check.json");

      const parsed = JSON.parse(content as string);
      expect(parsed.latestVersion).toBe("1.5.3");
      expect(parsed.checkedAt).toBeDefined();
    });

    it("silently fails on write errors", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.writeFileSync.mockImplementation(() => {
        throw new Error("Permission denied");
      });

      // Should not throw
      expect(() => writeCache("1.5.3")).not.toThrow();
    });
  });

  describe("isCacheFresh", () => {
    it("returns true for cache checked less than 24 hours ago", () => {
      const cache = {
        latestVersion: "1.5.3",
        checkedAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(), // 1 hour ago
      };
      expect(isCacheFresh(cache)).toBe(true);
    });

    it("returns false for cache checked more than 24 hours ago", () => {
      const cache = {
        latestVersion: "1.5.3",
        checkedAt: new Date(Date.now() - 1000 * 60 * 60 * 25).toISOString(), // 25 hours ago
      };
      expect(isCacheFresh(cache)).toBe(false);
    });

    it("returns false for invalid date", () => {
      const cache = {
        latestVersion: "1.5.3",
        checkedAt: "invalid-date",
      };
      expect(isCacheFresh(cache)).toBe(false);
    });
  });

  describe("fetchLatestVersion", () => {
    it("returns version from npm registry on success", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: "1.5.3" }),
      });

      const version = await fetchLatestVersion();
      expect(version).toBe("1.5.3");
    });

    it("returns null on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
      });

      const version = await fetchLatestVersion();
      expect(version).toBeNull();
    });

    it("returns null on network error", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const version = await fetchLatestVersion();
      expect(version).toBeNull();
    });

    it("returns null on timeout", async () => {
      mockFetch.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Aborted")), 100);
          }),
      );

      const version = await fetchLatestVersion();
      expect(version).toBeNull();
    });
  });

  describe("checkVersionThorough", () => {
    beforeEach(() => {
      // Mock getCurrentVersion to return a known version
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) => {
          if (String(filePath).includes("package.json")) {
            return JSON.stringify({ version: "1.0.0" });
          }
          return "";
        },
      );
    });

    it("returns outdated result when current < latest", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: "1.5.3" }),
      });
      mockFs.existsSync.mockReturnValue(true);

      const result = await checkVersionThorough();

      expect(result.currentVersion).toBe("1.0.0");
      expect(result.latestVersion).toBe("1.5.3");
      expect(result.isOutdated).toBe(true);
    });

    it("returns up-to-date result when current >= latest", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: "1.0.0" }),
      });
      mockFs.existsSync.mockReturnValue(true);

      const result = await checkVersionThorough();

      expect(result.isOutdated).toBe(false);
    });

    it("returns error when fetch fails", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await checkVersionThorough();

      expect(result.latestVersion).toBeNull();
      expect(result.isOutdated).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("checkVersionCached", () => {
    beforeEach(() => {
      // Mock getCurrentVersion
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) => {
          if (String(filePath).includes("package.json")) {
            return JSON.stringify({ version: "1.0.0" });
          }
          return "";
        },
      );
    });

    it("uses fresh cache without fetching", async () => {
      const freshCache = {
        latestVersion: "1.5.3",
        checkedAt: new Date(Date.now() - 1000 * 60).toISOString(), // 1 minute ago
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) => {
          if (String(filePath).includes("version-check.json")) {
            return JSON.stringify(freshCache);
          }
          if (String(filePath).includes("package.json")) {
            return JSON.stringify({ version: "1.0.0" });
          }
          return "";
        },
      );

      const result = await checkVersionCached();

      expect(result.latestVersion).toBe("1.5.3");
      expect(result.isOutdated).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fetches when cache is stale", async () => {
      const staleCache = {
        latestVersion: "1.5.0",
        checkedAt: new Date(Date.now() - 1000 * 60 * 60 * 25).toISOString(), // 25 hours ago
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) => {
          if (String(filePath).includes("version-check.json")) {
            return JSON.stringify(staleCache);
          }
          if (String(filePath).includes("package.json")) {
            return JSON.stringify({ version: "1.0.0" });
          }
          return "";
        },
      );

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ version: "1.5.3" }),
      });

      const result = await checkVersionCached();

      expect(result.latestVersion).toBe("1.5.3");
      expect(mockFetch).toHaveBeenCalled();
    });

    it("uses stale cache on fetch failure", async () => {
      const staleCache = {
        latestVersion: "1.5.0",
        checkedAt: new Date(Date.now() - 1000 * 60 * 60 * 25).toISOString(), // 25 hours ago
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockImplementation(
        (filePath: fs.PathOrFileDescriptor) => {
          if (String(filePath).includes("version-check.json")) {
            return JSON.stringify(staleCache);
          }
          if (String(filePath).includes("package.json")) {
            return JSON.stringify({ version: "1.0.0" });
          }
          return "";
        },
      );

      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await checkVersionCached();

      // Falls back to stale cache
      expect(result.latestVersion).toBe("1.5.0");
      expect(result.isOutdated).toBe(true);
    });

    it("returns gracefully when no cache and fetch fails", async () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFetch.mockRejectedValue(new Error("Network error"));

      const result = await checkVersionCached();

      expect(result.latestVersion).toBeNull();
      expect(result.isOutdated).toBe(false);
    });
  });
});
