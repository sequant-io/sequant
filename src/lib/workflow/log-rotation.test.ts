/**
 * Unit tests for log rotation
 *
 * Tests the log rotation system that manages disk space usage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import {
  getLogFiles,
  getLogStats,
  getFilesToDelete,
  rotateIfNeeded,
  manualRotate,
  formatBytes,
  DEFAULT_ROTATION_SETTINGS,
} from "./log-rotation.js";

// Mock fs module
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

describe("log-rotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getLogFiles", () => {
    it("should return empty array if directory does not exist", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const result = getLogFiles("/test/logs");

      expect(result).toEqual([]);
    });

    it("should filter for run-*.json files only", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-2024-01-15-abc.json",
        "run-2024-01-16-def.json",
        "other-file.json",
        "run-incomplete",
        "settings.json",
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(
        (path: string) => ({
          mtime: new Date(path.includes("15") ? "2024-01-15" : "2024-01-16"),
          size: 1024,
        }),
      );

      const result = getLogFiles("/test/logs");

      expect(result).toHaveLength(2);
      expect(result[0].filename).toBe("run-2024-01-15-abc.json");
      expect(result[1].filename).toBe("run-2024-01-16-def.json");
    });

    it("should sort files by modification time (oldest first)", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-new.json",
        "run-old.json",
        "run-mid.json",
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(
        (path: string) => {
          if (path.includes("old"))
            return { mtime: new Date("2024-01-01"), size: 1024 };
          if (path.includes("mid"))
            return { mtime: new Date("2024-01-15"), size: 1024 };
          return { mtime: new Date("2024-01-30"), size: 1024 };
        },
      );

      const result = getLogFiles("/test/logs");

      expect(result[0].filename).toBe("run-old.json");
      expect(result[1].filename).toBe("run-mid.json");
      expect(result[2].filename).toBe("run-new.json");
    });
  });

  describe("getLogStats", () => {
    it("should return zero stats for empty directory", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const stats = getLogStats("/test/logs");

      expect(stats).toEqual({
        totalSizeBytes: 0,
        totalSizeMB: 0,
        fileCount: 0,
        oldestFile: null,
        newestFile: null,
        exceedsSizeThreshold: false,
        exceedsCountThreshold: false,
      });
    });

    it("should calculate total size correctly", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-1.json",
        "run-2.json",
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(
        (path: string) => ({
          mtime: new Date(),
          size: path.includes("1") ? 1024 * 1024 : 2 * 1024 * 1024, // 1MB and 2MB
        }),
      );

      const stats = getLogStats("/test/logs");

      expect(stats.totalSizeBytes).toBe(3 * 1024 * 1024);
      expect(stats.totalSizeMB).toBe(3);
      expect(stats.fileCount).toBe(2);
    });

    it("should detect size threshold exceeded", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-1.json",
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        mtime: new Date(),
        size: 15 * 1024 * 1024, // 15MB > 10MB threshold
      });

      const stats = getLogStats("/test/logs");

      expect(stats.exceedsSizeThreshold).toBe(true);
      expect(stats.exceedsCountThreshold).toBe(false);
    });

    it("should detect count threshold exceeded", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(
        Array.from({ length: 105 }, (_, i) => `run-${i}.json`),
      );
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        mtime: new Date(),
        size: 1024, // 1KB each = 105KB total (under size limit)
      });

      const stats = getLogStats("/test/logs");

      expect(stats.exceedsSizeThreshold).toBe(false);
      expect(stats.exceedsCountThreshold).toBe(true);
    });
  });

  describe("getFilesToDelete", () => {
    it("should return empty array when under thresholds", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-1.json",
        "run-2.json",
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        mtime: new Date(),
        size: 1024,
      });

      const result = getFilesToDelete("/test/logs", DEFAULT_ROTATION_SETTINGS);

      expect(result).toEqual([]);
    });

    it("should select oldest files for deletion when count exceeded", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const files = Array.from({ length: 105 }, (_, i) => `run-${i}.json`);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue(files);
      (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(
        (path: string) => {
          const match = path.match(/run-(\d+)\.json/);
          const idx = match ? parseInt(match[1]) : 0;
          return {
            mtime: new Date(Date.now() + idx * 1000), // Older files have lower index
            size: 1024,
          };
        },
      );

      const result = getFilesToDelete("/test/logs", DEFAULT_ROTATION_SETTINGS);

      // Should delete enough to get to 90 files (10% buffer = 90)
      // 105 - 90 = 15 files to delete
      expect(result.length).toBe(15);
      // Oldest files should be first
      expect(result[0].filename).toBe("run-0.json");
    });

    it("should delete files when size threshold exceeded", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-old.json",
        "run-new.json",
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(
        (path: string) => ({
          mtime: new Date(path.includes("old") ? "2024-01-01" : "2024-01-30"),
          size: 6 * 1024 * 1024, // 6MB each = 12MB total > 10MB
        }),
      );

      const result = getFilesToDelete("/test/logs", DEFAULT_ROTATION_SETTINGS);

      // Should delete 1 file to get under 9MB threshold
      expect(result.length).toBe(1);
      expect(result[0].filename).toBe("run-old.json");
    });
  });

  describe("rotateIfNeeded", () => {
    it("should not delete when disabled", () => {
      const result = rotateIfNeeded("/test/logs", {
        ...DEFAULT_ROTATION_SETTINGS,
        enabled: false,
      });

      expect(result.rotated).toBe(false);
      expect(result.deletedCount).toBe(0);
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it("should not delete when under thresholds", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-1.json",
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({
        mtime: new Date(),
        size: 1024,
      });

      const result = rotateIfNeeded("/test/logs");

      expect(result.rotated).toBe(false);
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it("should delete oldest files when threshold exceeded", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-old.json",
        "run-new.json",
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(
        (path: string) => ({
          mtime: new Date(path.includes("old") ? "2024-01-01" : "2024-01-30"),
          size: 6 * 1024 * 1024,
        }),
      );

      const result = rotateIfNeeded("/test/logs");

      expect(result.rotated).toBe(true);
      expect(result.deletedCount).toBe(1);
      expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
    });
  });

  describe("manualRotate", () => {
    it("should support dry-run mode", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-old.json",
        "run-new.json",
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(
        (path: string) => ({
          mtime: new Date(path.includes("old") ? "2024-01-01" : "2024-01-30"),
          size: 6 * 1024 * 1024,
        }),
      );

      const result = manualRotate("/test/logs", { dryRun: true });

      expect(result.deletedCount).toBe(1);
      expect(result.rotated).toBe(false); // dry-run = not actually rotated
      expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    it("should actually delete in non-dry-run mode", () => {
      (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (fs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
        "run-old.json",
        "run-new.json",
      ]);
      (fs.statSync as ReturnType<typeof vi.fn>).mockImplementation(
        (path: string) => ({
          mtime: new Date(path.includes("old") ? "2024-01-01" : "2024-01-30"),
          size: 6 * 1024 * 1024,
        }),
      );

      const result = manualRotate("/test/logs", { dryRun: false });

      expect(result.rotated).toBe(true);
      expect(fs.unlinkSync).toHaveBeenCalled();
    });
  });

  describe("formatBytes", () => {
    it("should format bytes correctly", () => {
      expect(formatBytes(500)).toBe("500 B");
      expect(formatBytes(1024)).toBe("1.0 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1024 * 1024)).toBe("1.00 MB");
      expect(formatBytes(5.5 * 1024 * 1024)).toBe("5.50 MB");
    });
  });
});
