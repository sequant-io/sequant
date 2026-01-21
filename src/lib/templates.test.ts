import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import {
  mkdtemp,
  rm,
  writeFile as fsWriteFile,
  mkdir,
  readFile as fsReadFile,
} from "fs/promises";
import { tmpdir } from "os";
import { symlinkDir, processTemplate } from "./templates.js";
import { isSymlink, getSymlinkTarget, fileExists } from "./fs.js";

describe("templates", () => {
  let testDir: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "sequant-templates-test-"));
    srcDir = join(testDir, "src");
    destDir = join(testDir, "dest");
    await mkdir(srcDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("processTemplate", () => {
    it("replaces template variables", () => {
      const content = "Hello {{NAME}}, welcome to {{PROJECT}}!";
      const variables = { NAME: "User", PROJECT: "Sequant" };

      expect(processTemplate(content, variables)).toBe(
        "Hello User, welcome to Sequant!",
      );
    });

    it("replaces multiple occurrences of the same variable", () => {
      const content = "{{VAR}} and {{VAR}}";
      const variables = { VAR: "value" };

      expect(processTemplate(content, variables)).toBe("value and value");
    });

    it("leaves unknown variables unchanged", () => {
      const content = "{{KNOWN}} and {{UNKNOWN}}";
      const variables = { KNOWN: "replaced" };

      expect(processTemplate(content, variables)).toBe(
        "replaced and {{UNKNOWN}}",
      );
    });
  });

  describe("symlinkDir", () => {
    it("creates symlinks for files in source directory", async () => {
      // Create source files
      await fsWriteFile(join(srcDir, "file1.sh"), "#!/bin/bash\necho 'file1'");
      await fsWriteFile(join(srcDir, "file2.sh"), "#!/bin/bash\necho 'file2'");

      const results = await symlinkDir(srcDir, destDir);

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.created && !r.fallbackToCopy)).toBe(true);

      // Verify symlinks were created
      expect(await isSymlink(join(destDir, "file1.sh"))).toBe(true);
      expect(await isSymlink(join(destDir, "file2.sh"))).toBe(true);
    });

    it("creates relative symlinks", async () => {
      await fsWriteFile(join(srcDir, "script.sh"), "#!/bin/bash\necho 'test'");

      await symlinkDir(srcDir, destDir);

      const target = await getSymlinkTarget(join(destDir, "script.sh"));
      // Target should be relative path, not absolute
      expect(target).not.toContain(tmpdir());
      expect(target).toContain("src");
    });

    it("handles subdirectories recursively", async () => {
      const subdir = join(srcDir, "subdir");
      await mkdir(subdir, { recursive: true });
      await fsWriteFile(join(srcDir, "root.sh"), "root script");
      await fsWriteFile(join(subdir, "nested.sh"), "nested script");

      const results = await symlinkDir(srcDir, destDir);

      expect(results).toHaveLength(2);
      expect(await isSymlink(join(destDir, "root.sh"))).toBe(true);
      expect(await isSymlink(join(destDir, "subdir", "nested.sh"))).toBe(true);
    });

    it("skips existing regular files without force option", async () => {
      await fsWriteFile(join(srcDir, "script.sh"), "source content");
      await mkdir(destDir, { recursive: true });
      await fsWriteFile(join(destDir, "script.sh"), "existing content");

      const results = await symlinkDir(srcDir, destDir);

      expect(results).toHaveLength(1);
      expect(results[0].skipped).toBe(true);
      expect(results[0].reason).toContain("existing file");

      // Verify original file is preserved
      const content = await fsReadFile(join(destDir, "script.sh"), "utf-8");
      expect(content).toBe("existing content");
    });

    it("replaces existing files with force option", async () => {
      await fsWriteFile(join(srcDir, "script.sh"), "source content");
      await mkdir(destDir, { recursive: true });
      await fsWriteFile(join(destDir, "script.sh"), "existing content");

      const results = await symlinkDir(srcDir, destDir, { force: true });

      expect(results).toHaveLength(1);
      expect(results[0].created).toBe(true);
      expect(results[0].skipped).toBe(false);

      // Verify it's now a symlink
      expect(await isSymlink(join(destDir, "script.sh"))).toBe(true);
    });

    it("replaces existing symlinks without needing force", async () => {
      await fsWriteFile(join(srcDir, "script.sh"), "source content");
      await mkdir(destDir, { recursive: true });
      // Create an existing symlink pointing somewhere else
      const { symlink } = await import("fs/promises");
      await symlink("/some/old/path", join(destDir, "script.sh"));

      const results = await symlinkDir(srcDir, destDir);

      expect(results).toHaveLength(1);
      expect(results[0].created).toBe(true);

      // Verify symlink now points to correct target
      expect(await isSymlink(join(destDir, "script.sh"))).toBe(true);
      const target = await getSymlinkTarget(join(destDir, "script.sh"));
      expect(target).toContain("src");
    });

    it("returns empty array for non-existent source directory", async () => {
      const nonExistent = join(testDir, "does-not-exist");

      const results = await symlinkDir(nonExistent, destDir);

      expect(results).toHaveLength(0);
    });

    it("creates destination directory if it does not exist", async () => {
      await fsWriteFile(join(srcDir, "script.sh"), "content");
      const newDest = join(testDir, "new", "nested", "dest");

      await symlinkDir(srcDir, newDest);

      expect(await fileExists(join(newDest, "script.sh"))).toBe(true);
    });
  });
});
