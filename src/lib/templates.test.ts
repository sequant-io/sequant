import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import {
  mkdtemp,
  rm,
  writeFile as fsWriteFile,
  mkdir,
  readFile as fsReadFile,
  symlink,
} from "fs/promises";
import { tmpdir } from "os";
import {
  symlinkDir,
  processTemplate,
  isCustomizableFile,
  buildTemplateVariables,
  computeTemplateChanges,
  templateDestination,
  copyTemplates,
  resolveTemplatesDirFrom,
  resolveScriptsSymlinkTarget,
  getTemplatesDir,
  assertTemplatesDirExists,
  CUSTOMIZABLE_FILES,
  type TemplatesCandidateRank,
  previewScriptsSymlinkTargets,
} from "./templates.js";
import { isSymlink, getSymlinkTarget, fileExists } from "./fs.js";
import { writeOpencodeCommands } from "../commands/init.js";

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

  // #822: the resolver was calibrated for the compiled layout only, so running
  // from source under tsx landed one level above the repo root and every copy
  // silently no-opped. `resolveTemplatesDirFrom` takes the module dir and a
  // ranking function precisely so both layouts can be pinned here —
  // `import.meta.url` cannot be relocated from inside a test.
  describe("resolveTemplatesDirFrom (#822)", () => {
    const COMPILED_BASE = "/pkg/dist/src/lib";
    const SOURCE_BASE = "/repo/src/lib";

    // Rank helper: `packageRoot` paths rank as the sequant package root,
    // `present` paths merely exist, everything else is missing.
    const ranker =
      (opts: { packageRoot?: string[]; present?: string[] }) =>
      (candidate: string): TemplatesCandidateRank => {
        if (opts.packageRoot?.includes(candidate)) return "package-root";
        if (opts.present?.includes(candidate)) return "exists";
        return "missing";
      };

    it("resolves the package root from the compiled layout (dist/src/lib)", () => {
      expect(
        resolveTemplatesDirFrom(
          COMPILED_BASE,
          ranker({ packageRoot: [join("/pkg", "templates")] }),
        ),
      ).toBe(join("/pkg", "templates"));
    });

    it("resolves the repo root from a source-tree tsx invocation (src/lib)", () => {
      // The regression itself: before #822 this returned `/templates` (three up
      // from `/repo/src/lib`), one level ABOVE the repo, and every copy no-opped.
      expect(
        resolveTemplatesDirFrom(
          SOURCE_BASE,
          ranker({ packageRoot: [join("/repo", "templates")] }),
        ),
      ).toBe(join("/repo", "templates"));
    });

    it("ignores a stray templates/ beside the repo in favor of the package root", () => {
      // From `/repo/src/lib` the compiled offset lands on `/templates` — an
      // unrelated directory that happens to sit next to the checkout. It exists,
      // but it is not the sequant package root, so it must lose.
      expect(
        resolveTemplatesDirFrom(
          SOURCE_BASE,
          ranker({
            present: [join("/", "templates")],
            packageRoot: [join("/repo", "templates")],
          }),
        ),
      ).toBe(join("/repo", "templates"));
    });

    it("prefers the compiled offset when both candidates are package roots", () => {
      // Guards the probe order: consumers always run the compiled binary, so an
      // ambiguous tree must keep resolving exactly as it did before #822.
      expect(
        resolveTemplatesDirFrom(
          COMPILED_BASE,
          ranker({
            packageRoot: [
              join("/pkg", "templates"),
              join("/pkg/dist", "templates"),
            ],
          }),
        ),
      ).toBe(join("/pkg", "templates"));
    });

    it("accepts a merely-existing candidate when no package root is identified", () => {
      // Back-compat: a layout whose package.json is not where we expect still
      // resolves rather than hard-failing.
      expect(
        resolveTemplatesDirFrom(
          COMPILED_BASE,
          ranker({ present: [join("/pkg", "templates")] }),
        ),
      ).toBe(join("/pkg", "templates"));
    });

    it("falls back to the compiled offset when neither candidate exists", () => {
      // The fallback is what `assertTemplatesDirExists` names in its error, so
      // it must be the canonical expected location, not a source-tree guess.
      expect(resolveTemplatesDirFrom(COMPILED_BASE, () => "missing")).toBe(
        join("/pkg", "templates"),
      );
    });
  });

  describe("getTemplatesDir (#822)", () => {
    const originalOverride = process.env.SEQUANT_TEMPLATES_DIR;

    afterEach(() => {
      if (originalOverride === undefined) {
        delete process.env.SEQUANT_TEMPLATES_DIR;
      } else {
        process.env.SEQUANT_TEMPLATES_DIR = originalOverride;
      }
    });

    it("returns SEQUANT_TEMPLATES_DIR verbatim when set", () => {
      process.env.SEQUANT_TEMPLATES_DIR = "/custom/templates";
      expect(getTemplatesDir()).toBe("/custom/templates");
    });

    it("resolves a real templates tree when run from source under vitest", async () => {
      // This suite executes the TypeScript source (src/lib), i.e. exactly the
      // layout that was broken. Before the fix this pointed one level above the
      // repo and `skills/` did not exist.
      delete process.env.SEQUANT_TEMPLATES_DIR;
      const dir = getTemplatesDir();
      expect(await fileExists(join(dir, "skills"))).toBe(true);
    });
  });

  describe("assertTemplatesDirExists (#822)", () => {
    const originalOverride = process.env.SEQUANT_TEMPLATES_DIR;

    afterEach(() => {
      if (originalOverride === undefined) {
        delete process.env.SEQUANT_TEMPLATES_DIR;
      } else {
        process.env.SEQUANT_TEMPLATES_DIR = originalOverride;
      }
    });

    it("returns the resolved directory when it exists", async () => {
      const templatesDir = join(testDir, "templates");
      await mkdir(templatesDir, { recursive: true });
      process.env.SEQUANT_TEMPLATES_DIR = templatesDir;

      await expect(assertTemplatesDirExists()).resolves.toBe(templatesDir);
    });

    it("throws naming the missing path", async () => {
      const missing = join(testDir, "does-not-exist", "templates");
      process.env.SEQUANT_TEMPLATES_DIR = missing;

      await expect(assertTemplatesDirExists()).rejects.toThrow(missing);
    });

    it("throws when the path exists but is a file, not a directory", async () => {
      const notADir = join(testDir, "templates-file");
      await fsWriteFile(notADir, "not a directory");
      process.env.SEQUANT_TEMPLATES_DIR = notADir;

      await expect(assertTemplatesDirExists()).rejects.toThrow(notADir);
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

    // #722 regression: a SKILL.md installed before the `<!-- sequant:local-override
    // -->` overlay header shipped (#711 / 2.6.2) must surface as `modified` in the
    // preview — never silently `unchanged` — so `update --dry-run` / `sync --dry-run`
    // can't report "0 modified" while the apply rewrites it.
    it("classifies a header-missing SKILL.md vs a header-bearing template as modified (AC-3)", async () => {
      const OVERRIDE_HEADER =
        "<!-- sequant:local-override -->\n" +
        "> **Local overrides (read this first).** See `.claude/.local/skills/exec/overrides.md`.\n\n";
      // Template ships the overlay header; installed copy predates it.
      await fsWriteFile(
        join(templatesDir, "skills", "exec", "SKILL.md"),
        OVERRIDE_HEADER + "exec skill v{{PROJECT_NAME}}\n",
      );
      await seedLocal(SKILL_LOCAL, "exec skill vmy-project\n");

      const changes = await computeTemplateChanges("generic");
      const skill = changes.find((c) => c.path === SKILL_LOCAL);

      expect(skill?.status).toBe("modified");
      expect(skill?.diff).toBeDefined();
    });

    // #722 AC-2: the override classifier must key on a real `.claude/.local/`
    // twin (the supported customization mechanism), NOT on the in-band marker
    // embedded in the managed SKILL.md template. Locks the invariant so a future
    // change can't re-introduce the marker coupling the issue warns against.
    it("classifies a drifted SKILL.md as modified with no .local twin, local-override with one (AC-2)", async () => {
      await seedLocal(SKILL_LOCAL, "locally edited skill\n");

      // No `.claude/.local/skills/exec/SKILL.md` twin → modified.
      const before = await computeTemplateChanges("generic");
      expect(before.find((c) => c.path === SKILL_LOCAL)?.status).toBe(
        "modified",
      );

      // Add the real `.local` twin → now protected as a local-override.
      await seedLocal(
        ".claude/.local/skills/exec/SKILL.md",
        "my local override\n",
      );
      const after = await computeTemplateChanges("generic");
      expect(after.find((c) => c.path === SKILL_LOCAL)?.status).toBe(
        "local-override",
      );
    });

    // Phantom-drift regression: templates that copyTemplates routes elsewhere
    // (scripts → scripts/dev) or never installs (mcp.json, relay/) must not be
    // diffed against `.claude/<relpath>` — that made every fresh init report
    // 5 permanent "new" files that `sync --force` could never clear.
    it("diffs scripts against scripts/dev and skips mcp.json and relay entirely", async () => {
      await fsWriteFile(
        join(templatesDir, "mcp.json"),
        '{"sequant":{"command":"npx"}}\n',
      );
      await mkdir(join(templatesDir, "relay"), { recursive: true });
      await fsWriteFile(join(templatesDir, "relay", "frame.txt"), "frame\n");
      await mkdir(join(templatesDir, "scripts"), { recursive: true });
      await fsWriteFile(
        join(templatesDir, "scripts", "cleanup-worktree.sh"),
        "#!/bin/bash\necho cleanup\n",
      );
      // Installed where copyTemplates actually puts it
      await seedLocal(
        "scripts/dev/cleanup-worktree.sh",
        "#!/bin/bash\necho cleanup\n",
      );

      const changes = await computeTemplateChanges("generic");

      expect(changes.some((c) => c.path.startsWith(".claude/scripts/"))).toBe(
        false,
      );
      expect(changes.some((c) => c.path === ".claude/mcp.json")).toBe(false);
      expect(changes.some((c) => c.path.includes("relay"))).toBe(false);
      expect(
        changes.find((c) => c.path === "scripts/dev/cleanup-worktree.sh")
          ?.status,
      ).toBe("unchanged");
    });

    // #1030 AC-2: the motivating bug — templates/opencode/command.md has
    // {{PHASE}} substituted per-phase by init.ts's writeOpencodeCommands, so
    // the generic single-pass diff must never see it (it would report a
    // permanent "new" .claude/opencode/command.md with {{PHASE}} unrendered).
    it("excludes templates/opencode/** from the opencode-shim diff entirely (#1030)", async () => {
      await mkdir(join(templatesDir, "opencode", "plugins", "lib"), {
        recursive: true,
      });
      await fsWriteFile(
        join(templatesDir, "opencode", "command.md"),
        "Run the {{PHASE}} skill.\n",
      );
      await fsWriteFile(
        join(templatesDir, "opencode", "plugins", "sequant-hooks.ts"),
        "export default {};\n",
      );

      const changes = await computeTemplateChanges("generic");

      expect(changes.some((c) => c.path.includes(".claude/opencode"))).toBe(
        false,
      );
    });

    // #1030 AC-5: writeOpencodeCommands is the one renderer for
    // templates/opencode/command.md — it must fully substitute {{PHASE}} per
    // phase, since the generic engine that renders every other template now
    // skips this file entirely (it would otherwise reach disk untouched).
    it("writeOpencodeCommands leaves no unrendered placeholders (#1030)", async () => {
      await mkdir(join(templatesDir, "opencode"), { recursive: true });
      await fsWriteFile(
        join(templatesDir, "opencode", "command.md"),
        "Load and run the {{PHASE}} skill against $ARGUMENTS.\n",
      );

      const phases = await writeOpencodeCommands(cwdDir);
      expect(phases.length).toBeGreaterThan(0);

      for (const phase of phases) {
        const written = await fsReadFile(
          join(cwdDir, ".opencode", "commands", `${phase}.md`),
          "utf-8",
        );
        expect(written).not.toMatch(/\{\{[A-Z_]+\}\}/);
        expect(written).toContain(phase);
      }
    });

    it("classifies a diverged scripts/dev copy as modified, not its own local-override", async () => {
      await mkdir(join(templatesDir, "scripts"), { recursive: true });
      await fsWriteFile(
        join(templatesDir, "scripts", "new-feature.sh"),
        "#!/bin/bash\necho v2\n",
      );
      await seedLocal("scripts/dev/new-feature.sh", "#!/bin/bash\necho v1\n");

      const changes = await computeTemplateChanges("generic");

      expect(
        changes.find((c) => c.path === "scripts/dev/new-feature.sh")?.status,
      ).toBe("modified");
    });
  });

  describe("templateDestination", () => {
    it("maps scripts to scripts/dev and everything else under .claude/", () => {
      expect(templateDestination("templates/scripts/new-feature.sh")).toBe(
        "scripts/dev/new-feature.sh",
      );
      expect(templateDestination("templates/skills/exec/SKILL.md")).toBe(
        ".claude/skills/exec/SKILL.md",
      );
      expect(templateDestination("templates/settings.json")).toBe(
        ".claude/settings.json",
      );
    });

    it("returns null for templates copyTemplates never installs", () => {
      expect(templateDestination("templates/mcp.json")).toBeNull();
      expect(templateDestination("templates/relay/frame.txt")).toBeNull();
    });

    // #1030 AC-2: templates/opencode/** is a second renderer's input
    // (init.ts's writeOpencode* functions), not a flat-copy target — the
    // generic engine must never route it to .claude/opencode/.
    it("returns null for templates/opencode/** (#1030)", () => {
      expect(templateDestination("templates/opencode/command.md")).toBeNull();
      expect(
        templateDestination("templates/opencode/plugins/sequant-hooks.ts"),
      ).toBeNull();
    });

    it("normalizes Windows separators before routing (#708)", () => {
      expect(templateDestination("templates\\scripts\\new-feature.sh")).toBe(
        "scripts/dev/new-feature.sh",
      );
      expect(templateDestination("templates\\mcp.json")).toBeNull();
    });
  });

  // Write-path protection for CUSTOMIZABLE_FILES (#814). Hermetic: a temp
  // templates tree + temp cwd, so copyTemplates writes into a throwaway
  // `.claude/`. The one CUSTOMIZABLE_FILES entry (constitution) is exercised
  // through the real copy — not the diff path.
  describe("copyTemplates customizable-file preservation (#814)", () => {
    const CONSTITUTION_LOCAL = ".claude/memory/constitution.md";
    // constitution template rendered with PROJECT_NAME=my-project
    const RENDERED = "# my-project Constitution\n";
    let prevCwd: string;
    let cwdDir: string;
    let templatesDir: string;

    beforeEach(async () => {
      prevCwd = process.cwd();
      cwdDir = await mkdtemp(join(tmpdir(), "sequant-copy-cwd-"));
      templatesDir = await mkdtemp(join(tmpdir(), "sequant-copy-tpl-"));
      process.chdir(cwdDir);
      process.env.SEQUANT_TEMPLATES_DIR = templatesDir;

      // Deterministic PROJECT_NAME via package.json
      await fsWriteFile(
        join(cwdDir, "package.json"),
        JSON.stringify({ name: "my-project" }),
      );

      // Seed the temp templates tree with just the constitution
      await mkdir(join(templatesDir, "memory"), { recursive: true });
      await fsWriteFile(
        join(templatesDir, "memory", "constitution.md"),
        "# {{PROJECT_NAME}} Constitution\n",
      );
    });

    afterEach(async () => {
      process.chdir(prevCwd);
      delete process.env.SEQUANT_TEMPLATES_DIR;
      await rm(cwdDir, { recursive: true, force: true });
      await rm(templatesDir, { recursive: true, force: true });
    });

    async function seedConstitution(content: string): Promise<void> {
      await mkdir(join(cwdDir, ".claude", "memory"), { recursive: true });
      await fsWriteFile(join(cwdDir, CONSTITUTION_LOCAL), content);
    }

    it("preserves an in-place customized constitution under a plain copy (AC-1, AC-2)", async () => {
      const custom =
        "# my-project Constitution\n\n## Custom Principle\nKeep it.\n";
      await seedConstitution(custom);

      // A stale non-customizable tree file must still be refreshed by the
      // same call that preserves the constitution (AC-1's "trees still
      // refresh" clause).
      const SKILL_TREE_LOCAL = ".claude/skills/exec/SKILL.md";
      await mkdir(join(templatesDir, "skills", "exec"), { recursive: true });
      await fsWriteFile(
        join(templatesDir, "skills", "exec", "SKILL.md"),
        "exec skill v{{PROJECT_NAME}}\n",
      );
      await mkdir(join(cwdDir, ".claude", "skills", "exec"), {
        recursive: true,
      });
      await fsWriteFile(join(cwdDir, SKILL_TREE_LOCAL), "stale skill\n");

      const result = await copyTemplates("generic");

      const content = await fsReadFile(
        join(cwdDir, CONSTITUTION_LOCAL),
        "utf-8",
      );
      expect(content).toBe(custom); // untouched
      expect(result.preservedCustomizable).toContain(CONSTITUTION_LOCAL);

      // Tree file overwritten with the rendered template, not preserved.
      expect(await fsReadFile(join(cwdDir, SKILL_TREE_LOCAL), "utf-8")).toBe(
        "exec skill vmy-project\n",
      );
      expect(result.preservedCustomizable).not.toContain(SKILL_TREE_LOCAL);
    });

    it("overwrites the customization only when overwriteCustomizable is set — not force (AC-2)", async () => {
      const custom = "# my-project Constitution\n\n## Custom\nKeep it.\n";
      await seedConstitution(custom);

      // `force` refreshes trees but must NOT clobber the customizable file.
      const forced = await copyTemplates("generic", undefined, {
        force: true,
      });
      expect(await fsReadFile(join(cwdDir, CONSTITUTION_LOCAL), "utf-8")).toBe(
        custom,
      );
      expect(forced.preservedCustomizable).toContain(CONSTITUTION_LOCAL);

      // The dedicated opt-in overwrites it.
      const opted = await copyTemplates("generic", undefined, {
        overwriteCustomizable: true,
      });
      expect(await fsReadFile(join(cwdDir, CONSTITUTION_LOCAL), "utf-8")).toBe(
        RENDERED,
      );
      expect(opted.preservedCustomizable).toHaveLength(0);
    });

    // #822 AC-2, second clause: hardening the *root* must not tighten the
    // per-subdirectory ENOENT skip. A stack that ships without `agents/`,
    // `hooks/` or `scripts/` — as this temp tree does — still copies cleanly.
    it("skips absent template subdirectories without failing (#822 AC-2)", async () => {
      await mkdir(join(templatesDir, "skills", "exec"), { recursive: true });
      await fsWriteFile(
        join(templatesDir, "skills", "exec", "SKILL.md"),
        "exec skill\n",
      );

      // Only `memory/` and `skills/` exist in the templates tree.
      await expect(copyTemplates("generic")).resolves.toBeDefined();

      expect(
        await fileExists(join(cwdDir, ".claude", "skills", "exec", "SKILL.md")),
      ).toBe(true);
      // The absent subdirs simply produced nothing — no throw, no partial state.
      expect(await fileExists(join(cwdDir, ".claude", "agents"))).toBe(false);
    });

    it("creates a missing constitution on a fresh install (AC-5)", async () => {
      // Nothing seeded under .claude → the file is written, not preserved.
      const result = await copyTemplates("generic");

      const content = await fsReadFile(
        join(cwdDir, CONSTITUTION_LOCAL),
        "utf-8",
      );
      expect(content).toBe(RENDERED);
      expect(result.preservedCustomizable).toHaveLength(0);
    });

    it("rewrites an identical constitution without flagging it preserved", async () => {
      // Installed == rendered → harmless rewrite, not a preserved skip.
      await seedConstitution(RENDERED);

      const result = await copyTemplates("generic");

      expect(await fsReadFile(join(cwdDir, CONSTITUTION_LOCAL), "utf-8")).toBe(
        RENDERED,
      );
      expect(result.preservedCustomizable).toHaveLength(0);
    });

    // #943 AC-4: the rewritten multi-section constitution (DoD + boundaries +
    // budgets) is preserved unchanged when a project has customized it — the
    // CUSTOMIZABLE_FILES guard must work regardless of template content shape.
    it("preserves a multi-section constitution customized for the project (#943 AC-4)", async () => {
      const custom =
        "# my-project Agent Contract\n\n" +
        "## 1. Definition of Done\n\n<!-- BEGIN:DOD-GATES -->\n| Gate | Trigger | Verdict impact |\n|------|---------|----------------|\n<!-- END:DOD-GATES -->\n\n" +
        "## Project-Specific Notes\n\nOur team rule: always pair-review auth changes.\n";
      await seedConstitution(custom);

      const result = await copyTemplates("generic");

      expect(await fsReadFile(join(cwdDir, CONSTITUTION_LOCAL), "utf-8")).toBe(
        custom,
      ); // untouched despite new template shape
      expect(result.preservedCustomizable).toContain(CONSTITUTION_LOCAL);
    });

    it("pins the round trip: plain copy preserves, opt-in replaces (AC-6)", async () => {
      const custom =
        "# my-project Constitution\n\n## Team Rule\nAlways review.\n";
      await seedConstitution(custom);

      // Plain copy (what a plain `sync` runs) → customization survives.
      await copyTemplates("generic");
      expect(await fsReadFile(join(cwdDir, CONSTITUTION_LOCAL), "utf-8")).toBe(
        custom,
      );

      // Opt-in copy (what `sync --force` runs) → replaced with the template.
      await copyTemplates("generic", undefined, {
        overwriteCustomizable: true,
      });
      expect(await fsReadFile(join(cwdDir, CONSTITUTION_LOCAL), "utf-8")).toBe(
        RENDERED,
      );
    });
  });

  describe("scripts/dev symlink target routing (#990)", () => {
    let prevCwd: string;
    let cwdDir: string;
    let templatesDir: string;

    beforeEach(async () => {
      prevCwd = process.cwd();
      cwdDir = await mkdtemp(join(tmpdir(), "sequant-scripts-cwd-"));
      templatesDir = await mkdtemp(join(tmpdir(), "sequant-scripts-tpl-"));
      process.chdir(cwdDir);
      process.env.SEQUANT_TEMPLATES_DIR = templatesDir;

      await fsWriteFile(
        join(cwdDir, "package.json"),
        JSON.stringify({ name: "my-project" }),
      );
      await mkdir(join(templatesDir, "scripts"), { recursive: true });
      await fsWriteFile(
        join(templatesDir, "scripts", "new-feature.sh"),
        "#!/bin/bash\necho tpl\n",
      );
    });

    afterEach(async () => {
      process.chdir(prevCwd);
      delete process.env.SEQUANT_TEMPLATES_DIR;
      await rm(cwdDir, { recursive: true, force: true });
      await rm(templatesDir, { recursive: true, force: true });
    });

    it("prefers a local node_modules/sequant/templates/scripts target regardless of which templates dir produced the copy (AC-4)", async () => {
      const localScripts = join(
        cwdDir,
        "node_modules",
        "sequant",
        "templates",
        "scripts",
      );
      await mkdir(localScripts, { recursive: true });
      await fsWriteFile(
        join(localScripts, "new-feature.sh"),
        "#!/bin/bash\necho local\n",
      );

      await copyTemplates("generic");

      const linkPath = join(cwdDir, "scripts", "dev", "new-feature.sh");
      expect(await isSymlink(linkPath)).toBe(true);
      const target = await getSymlinkTarget(linkPath);
      const resolved = join(join(cwdDir, "scripts", "dev"), target!);
      expect(resolved.startsWith(join(cwdDir, "node_modules", "sequant"))).toBe(
        true,
      );
    });

    it("previewScriptsSymlinkTargets reports old → new for each link, against the real filesystem (AC-6)", async () => {
      // QA F2 on #990: the function backing the dry-run preview had only
      // mocked references. Same fixture as AC-4: a local node_modules/sequant
      // scripts dir is the target, so the resolver is in symlink mode.
      const localScripts = join(
        cwdDir,
        "node_modules",
        "sequant",
        "templates",
        "scripts",
      );
      await mkdir(localScripts, { recursive: true });
      await fsWriteFile(
        join(localScripts, "new-feature.sh"),
        "#!/bin/bash\necho local\n",
      );

      // (1) No link yet: one entry, no old target, flagged as a change.
      const before = await previewScriptsSymlinkTargets();
      expect(before).toHaveLength(1);
      expect(before[0].path).toBe(join("scripts", "dev", "new-feature.sh"));
      expect(before[0].oldTarget).toBeNull();
      expect(before[0].changed).toBe(true);
      expect(
        join(join(cwdDir, "scripts", "dev"), before[0].newTarget).replace(
          /^\/private/,
          "",
        ),
      ).toBe(join(localScripts, "new-feature.sh").replace(/^\/private/, ""));

      // (2) A stale link (the npx-cache / sibling-dir shape) → old → new.
      await mkdir(join(cwdDir, "scripts", "dev"), { recursive: true });
      await symlink(
        "../../../../.npm/_npx/deadbeef/node_modules/sequant/templates/scripts/new-feature.sh",
        join(cwdDir, "scripts", "dev", "new-feature.sh"),
      );
      const stale = await previewScriptsSymlinkTargets();
      expect(stale).toHaveLength(1);
      expect(stale[0].oldTarget).toContain("_npx/deadbeef");
      expect(stale[0].changed).toBe(true);
      expect(stale[0].newTarget).toBe(before[0].newTarget);

      // (3) After the real copy the link matches → nothing to report.
      await copyTemplates("generic");
      const after = await previewScriptsSymlinkTargets();
      expect(after).toHaveLength(1);
      expect(after[0].oldTarget).toBe(after[0].newTarget);
      expect(after[0].changed).toBe(false);
    });

    it("resolveScriptsSymlinkTarget prefers node_modules/sequant over the bundled dir", async () => {
      const localScripts = join(
        cwdDir,
        "node_modules",
        "sequant",
        "templates",
        "scripts",
      );
      await mkdir(localScripts, { recursive: true });

      const result = resolveScriptsSymlinkTarget(join(templatesDir));
      expect(result.mode).toBe("symlink");
      expect(result.scriptsDir.replace(/^\/private/, "")).toBe(
        localScripts.replace(/^\/private/, ""),
      );
    });

    it("falls back to copies (not links) for a templates dir under an npx cache path, and prints exactly one --no-symlinks line (AC-5)", async () => {
      // Verbatim shape observed in the wild (PLAN D13).
      const npxTemplatesDir = join(
        tmpdir(),
        ".npm",
        "_npx",
        "38ae72183b73fa32",
        "node_modules",
        "sequant",
        "templates",
      );
      await mkdir(join(npxTemplatesDir, "scripts"), { recursive: true });
      await fsWriteFile(
        join(npxTemplatesDir, "scripts", "new-feature.sh"),
        "#!/bin/bash\necho npx\n",
      );
      process.env.SEQUANT_TEMPLATES_DIR = npxTemplatesDir;

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg?: unknown) => {
        logs.push(String(msg));
      };
      try {
        await copyTemplates("generic");
      } finally {
        console.log = originalLog;
        await rm(npxTemplatesDir, { recursive: true, force: true });
      }

      const linkPath = join(cwdDir, "scripts", "dev", "new-feature.sh");
      expect(await isSymlink(linkPath)).toBe(false);
      expect(await fileExists(linkPath)).toBe(true);
      const warnLines = logs.filter((l) => l.includes("--no-symlinks"));
      expect(warnLines).toHaveLength(1);
    });

    it("falls back to copies (not links) for a templates dir outside the project tree, and prints exactly one --no-symlinks line (AC-5)", async () => {
      // templatesDir is a sibling temp dir — outside cwdDir by construction.
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (msg?: unknown) => {
        logs.push(String(msg));
      };
      try {
        await copyTemplates("generic");
      } finally {
        console.log = originalLog;
      }

      const linkPath = join(cwdDir, "scripts", "dev", "new-feature.sh");
      expect(await isSymlink(linkPath)).toBe(false);
      expect(await fileExists(linkPath)).toBe(true);
      const warnLines = logs.filter((l) => l.includes("--no-symlinks"));
      expect(warnLines).toHaveLength(1);
    });
  });
});
