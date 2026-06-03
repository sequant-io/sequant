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
import {
  symlinkDir,
  processTemplate,
  isCustomizableFile,
  buildTemplateVariables,
  computeTemplateChanges,
  CUSTOMIZABLE_FILES,
} from "./templates.js";
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

  describe("isCustomizableFile", () => {
    it("treats the constitution as customizable", () => {
      expect(isCustomizableFile(".claude/memory/constitution.md")).toBe(true);
    });

    it("does not treat ordinary skill files as customizable", () => {
      expect(isCustomizableFile(".claude/skills/exec/SKILL.md")).toBe(false);
    });

    it("matches the exported allow-list", () => {
      for (const file of CUSTOMIZABLE_FILES) {
        expect(isCustomizableFile(file)).toBe(true);
      }
    });

    it("normalizes Windows-style separators before matching (#708)", () => {
      // On Windows template paths are assembled with backslashes; the
      // protection must still recognize the constitution.
      expect(isCustomizableFile(".claude\\memory\\constitution.md")).toBe(true);
    });
  });

  describe("buildTemplateVariables", () => {
    it("includes PROJECT_NAME, STACK and STACK_NOTES", async () => {
      const vars = await buildTemplateVariables("generic", { DEV_URL: "x" });
      expect(vars.STACK).toBe("generic");
      expect(vars.DEV_URL).toBe("x");
      expect(typeof vars.PROJECT_NAME).toBe("string");
      expect(vars.PROJECT_NAME.length).toBeGreaterThan(0);
      expect(typeof vars.STACK_NOTES).toBe("string");
    });
  });

  // Hermetic: point SEQUANT_TEMPLATES_DIR at a temp templates tree and run in
  // a temp cwd so computeTemplateChanges is fully controlled.
  describe("computeTemplateChanges", () => {
    const CONSTITUTION_LOCAL = ".claude/memory/constitution.md";
    const SKILL_LOCAL = ".claude/skills/exec/SKILL.md";
    let prevCwd: string;
    let cwdDir: string;
    let templatesDir: string;

    beforeEach(async () => {
      prevCwd = process.cwd();
      cwdDir = await mkdtemp(join(tmpdir(), "sequant-changes-cwd-"));
      templatesDir = await mkdtemp(join(tmpdir(), "sequant-changes-tpl-"));
      process.chdir(cwdDir);
      process.env.SEQUANT_TEMPLATES_DIR = templatesDir;

      // Deterministic PROJECT_NAME via package.json
      await fsWriteFile(
        join(cwdDir, "package.json"),
        JSON.stringify({ name: "my-project" }),
      );

      // Seed the temp templates tree
      await mkdir(join(templatesDir, "memory"), { recursive: true });
      await fsWriteFile(
        join(templatesDir, "memory", "constitution.md"),
        "# {{PROJECT_NAME}} Constitution\n",
      );
      await mkdir(join(templatesDir, "skills", "exec"), { recursive: true });
      await fsWriteFile(
        join(templatesDir, "skills", "exec", "SKILL.md"),
        "exec skill v{{PROJECT_NAME}}\n",
      );
    });

    afterEach(async () => {
      process.chdir(prevCwd);
      delete process.env.SEQUANT_TEMPLATES_DIR;
      await rm(cwdDir, { recursive: true, force: true });
      await rm(templatesDir, { recursive: true, force: true });
    });

    async function seedLocal(
      localPath: string,
      content: string,
    ): Promise<void> {
      await mkdir(join(cwdDir, localPath, ".."), { recursive: true });
      await fsWriteFile(join(cwdDir, localPath), content);
    }

    it("classifies a token-rendered constitution as unchanged, not modified (AC-3)", async () => {
      // Installed content == rendered template (token already substituted)
      await seedLocal(CONSTITUTION_LOCAL, "# my-project Constitution\n");

      const changes = await computeTemplateChanges("generic");
      const constitution = changes.find((c) => c.path === CONSTITUTION_LOCAL);

      expect(constitution?.status).toBe("unchanged");
    });

    it("classifies an in-place customized constitution as local-override (AC-4)", async () => {
      // Diverges after rendering, no parallel .claude/.local/ file
      await seedLocal(
        CONSTITUTION_LOCAL,
        "# my-project Constitution\n\n## Custom Principle\nKeep it simple.\n",
      );

      const changes = await computeTemplateChanges("generic");
      const constitution = changes.find((c) => c.path === CONSTITUTION_LOCAL);

      expect(constitution?.status).toBe("local-override");
      // And never reported as modified
      expect(
        changes.some(
          (c) => c.path === CONSTITUTION_LOCAL && c.status === "modified",
        ),
      ).toBe(false);
    });

    it("classifies a diverged non-customizable file as modified", async () => {
      await seedLocal(SKILL_LOCAL, "locally edited skill\n");

      const changes = await computeTemplateChanges("generic");
      const skill = changes.find((c) => c.path === SKILL_LOCAL);

      expect(skill?.status).toBe("modified");
      expect(skill?.diff).toBeDefined();
    });

    it("classifies a missing installed file as new", async () => {
      // Nothing seeded under .claude → everything is new
      const changes = await computeTemplateChanges("generic");
      const skill = changes.find((c) => c.path === SKILL_LOCAL);

      expect(skill?.status).toBe("new");
    });
  });
});
