import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import {
  mkdtemp,
  mkdir,
  readFile as fsReadFile,
  rm,
  writeFile as fsWriteFile,
  symlink,
} from "fs/promises";
import { tmpdir } from "os";
import {
  isSymlink,
  isDirectory,
  directoryCollisionMessage,
  getSymlinkTarget,
  removeFileOrSymlink,
  createSymlink,
  fileExists,
  writeFile,
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

describe("writeFile (#1122)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "sequant-write-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("replaces an existing symlink instead of writing through it", async () => {
    const targetPath = join(testDir, "target.txt");
    const linkPath = join(testDir, "link.txt");
    await fsWriteFile(targetPath, "the target's own bytes");
    await symlink(targetPath, linkPath);

    await writeFile(linkPath, "new content");

    expect(await isSymlink(linkPath)).toBe(false);
    expect(await fsReadFile(linkPath, "utf-8")).toBe("new content");
    // The whole point: what the link pointed at is untouched.
    expect(await fsReadFile(targetPath, "utf-8")).toBe(
      "the target's own bytes",
    );
  });

  it("replaces a broken symlink rather than creating the file it pointed at", async () => {
    const linkPath = join(testDir, "broken.txt");
    const missing = join(testDir, "gone.txt");
    await symlink(missing, linkPath);

    await writeFile(linkPath, "new content");

    expect(await isSymlink(linkPath)).toBe(false);
    expect(await fsReadFile(linkPath, "utf-8")).toBe("new content");
    expect(await fileExists(missing)).toBe(false);
  });

  it("still overwrites a regular file in place", async () => {
    const filePath = join(testDir, "regular.txt");
    await fsWriteFile(filePath, "old");

    await writeFile(filePath, "new");

    expect(await isSymlink(filePath)).toBe(false);
    expect(await fsReadFile(filePath, "utf-8")).toBe("new");
  });

  it("creates missing parent directories", async () => {
    const filePath = join(testDir, "a", "b", "c.txt");

    await writeFile(filePath, "nested");

    expect(await fsReadFile(filePath, "utf-8")).toBe("nested");
  });
});

describe("isDirectory (#1122)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "sequant-isdir-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("returns true for a directory", async () => {
    const dirPath = join(testDir, "a-dir");
    await mkdir(dirPath);

    expect(await isDirectory(dirPath)).toBe(true);
  });

  it("returns false for a regular file, where fileExists returns true", async () => {
    const filePath = join(testDir, "file.txt");
    await fsWriteFile(filePath, "content");

    expect(await fileExists(filePath)).toBe(true);
    expect(await isDirectory(filePath)).toBe(false);
  });

  it("does not follow a symlink to a directory", async () => {
    const dirPath = join(testDir, "a-dir");
    const linkPath = join(testDir, "link-to-dir");
    await mkdir(dirPath);
    await symlink(dirPath, linkPath);

    expect(await isDirectory(linkPath)).toBe(false);
  });

  it("returns false for a non-existent path", async () => {
    expect(await isDirectory(join(testDir, "nope"))).toBe(false);
  });
});

describe("directoryCollisionMessage (#1122)", () => {
  it("names the path and the action that resolves it", () => {
    expect(directoryCollisionMessage(".claude/settings.json")).toBe(
      ".claude/settings.json is a directory; move it aside",
    );
  });

  it("normalises Windows separators so the message reads the same everywhere", () => {
    expect(directoryCollisionMessage(".claude\\skills\\spec\\SKILL.md")).toBe(
      ".claude/skills/spec/SKILL.md is a directory; move it aside",
    );
  });
});
