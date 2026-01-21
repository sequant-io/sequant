import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { mkdtemp, rm, writeFile as fsWriteFile, symlink } from "fs/promises";
import { tmpdir } from "os";
import {
  isSymlink,
  getSymlinkTarget,
  removeFileOrSymlink,
  createSymlink,
  fileExists,
} from "./fs.js";

describe("symlink utilities", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "sequant-test-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("isSymlink", () => {
    it("returns true for symbolic links", async () => {
      const targetPath = join(testDir, "target.txt");
      const linkPath = join(testDir, "link.txt");

      await fsWriteFile(targetPath, "content");
      await symlink(targetPath, linkPath);

      expect(await isSymlink(linkPath)).toBe(true);
    });

    it("returns false for regular files", async () => {
      const filePath = join(testDir, "regular.txt");
      await fsWriteFile(filePath, "content");

      expect(await isSymlink(filePath)).toBe(false);
    });

    it("returns false for non-existent paths", async () => {
      const nonExistent = join(testDir, "does-not-exist.txt");

      expect(await isSymlink(nonExistent)).toBe(false);
    });
  });

  describe("getSymlinkTarget", () => {
    it("returns the target path for a symlink", async () => {
      const targetPath = join(testDir, "target.txt");
      const linkPath = join(testDir, "link.txt");

      await fsWriteFile(targetPath, "content");
      await symlink(targetPath, linkPath);

      expect(await getSymlinkTarget(linkPath)).toBe(targetPath);
    });

    it("returns null for regular files", async () => {
      const filePath = join(testDir, "regular.txt");
      await fsWriteFile(filePath, "content");

      expect(await getSymlinkTarget(filePath)).toBe(null);
    });

    it("returns null for non-existent paths", async () => {
      const nonExistent = join(testDir, "does-not-exist.txt");

      expect(await getSymlinkTarget(nonExistent)).toBe(null);
    });
  });

  describe("removeFileOrSymlink", () => {
    it("removes regular files", async () => {
      const filePath = join(testDir, "regular.txt");
      await fsWriteFile(filePath, "content");

      expect(await fileExists(filePath)).toBe(true);
      expect(await removeFileOrSymlink(filePath)).toBe(true);
      expect(await fileExists(filePath)).toBe(false);
    });

    it("removes symbolic links", async () => {
      const targetPath = join(testDir, "target.txt");
      const linkPath = join(testDir, "link.txt");

      await fsWriteFile(targetPath, "content");
      await symlink(targetPath, linkPath);

      expect(await fileExists(linkPath)).toBe(true);
      expect(await removeFileOrSymlink(linkPath)).toBe(true);
      expect(await fileExists(linkPath)).toBe(false);
      // Target should still exist
      expect(await fileExists(targetPath)).toBe(true);
    });

    it("returns false for non-existent paths", async () => {
      const nonExistent = join(testDir, "does-not-exist.txt");

      expect(await removeFileOrSymlink(nonExistent)).toBe(false);
    });
  });

  describe("createSymlink", () => {
    it("creates symbolic links successfully", async () => {
      const targetPath = join(testDir, "target.txt");
      const linkPath = join(testDir, "link.txt");

      await fsWriteFile(targetPath, "content");
      const result = await createSymlink(targetPath, linkPath);

      expect(result).toBe(true);
      expect(await isSymlink(linkPath)).toBe(true);
      expect(await getSymlinkTarget(linkPath)).toBe(targetPath);
    });

    it("works with relative paths", async () => {
      const targetPath = join(testDir, "target.txt");
      const linkPath = join(testDir, "link.txt");

      await fsWriteFile(targetPath, "content");
      // Create a symlink using relative target
      const result = await createSymlink("target.txt", linkPath);

      expect(result).toBe(true);
      expect(await isSymlink(linkPath)).toBe(true);
      expect(await getSymlinkTarget(linkPath)).toBe("target.txt");
    });

    it("throws for other errors (not EPERM/EACCES)", async () => {
      // Try to create a symlink in a non-existent directory
      const nonExistentDir = join(testDir, "nonexistent", "link.txt");

      await expect(createSymlink("target", nonExistentDir)).rejects.toThrow();
    });
  });
});
