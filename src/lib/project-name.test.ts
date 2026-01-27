import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join, basename } from "path";
import { mkdtemp, rm, writeFile as fsWriteFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { detectProjectName, getProjectName } from "./project-name.js";
import { processTemplate } from "./templates.js";

describe("project-name detection", () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "sequant-project-name-test-"));
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("detectProjectName", () => {
    describe("package.json detection", () => {
      it("detects project name from package.json", async () => {
        await fsWriteFile(
          join(testDir, "package.json"),
          JSON.stringify({ name: "my-node-project" }),
        );

        const result = await detectProjectName();

        expect(result.name).toBe("my-node-project");
        expect(result.source).toBe("package.json");
      });

      it("handles scoped npm packages", async () => {
        await fsWriteFile(
          join(testDir, "package.json"),
          JSON.stringify({ name: "@myorg/my-package" }),
        );

        const result = await detectProjectName();

        expect(result.name).toBe("@myorg/my-package");
        expect(result.source).toBe("package.json");
      });

      it("ignores package.json without name field", async () => {
        await fsWriteFile(
          join(testDir, "package.json"),
          JSON.stringify({ version: "1.0.0" }),
        );

        const result = await detectProjectName();

        // Should fall back to directory name
        expect(result.source).toBe("directory");
      });

      it("ignores malformed package.json", async () => {
        await fsWriteFile(join(testDir, "package.json"), "{ invalid json }");

        const result = await detectProjectName();

        // Should fall back to directory name
        expect(result.source).toBe("directory");
      });

      it("trims whitespace from name", async () => {
        await fsWriteFile(
          join(testDir, "package.json"),
          JSON.stringify({ name: "  my-project  " }),
        );

        const result = await detectProjectName();

        expect(result.name).toBe("my-project");
      });
    });

    describe("Cargo.toml detection", () => {
      it("detects project name from Cargo.toml", async () => {
        await fsWriteFile(
          join(testDir, "Cargo.toml"),
          `[package]
name = "my-rust-project"
version = "0.1.0"
`,
        );

        const result = await detectProjectName();

        expect(result.name).toBe("my-rust-project");
        expect(result.source).toBe("Cargo.toml");
      });

      it("handles single quotes in Cargo.toml", async () => {
        await fsWriteFile(
          join(testDir, "Cargo.toml"),
          `[package]
name = 'rust-single-quotes'
version = "0.1.0"
`,
        );

        const result = await detectProjectName();

        expect(result.name).toBe("rust-single-quotes");
        expect(result.source).toBe("Cargo.toml");
      });

      it("prioritizes package.json over Cargo.toml", async () => {
        await fsWriteFile(
          join(testDir, "package.json"),
          JSON.stringify({ name: "node-project" }),
        );
        await fsWriteFile(
          join(testDir, "Cargo.toml"),
          `[package]
name = "rust-project"
`,
        );

        const result = await detectProjectName();

        expect(result.name).toBe("node-project");
        expect(result.source).toBe("package.json");
      });
    });

    describe("pyproject.toml detection", () => {
      it("detects project name from pyproject.toml [project] section", async () => {
        await fsWriteFile(
          join(testDir, "pyproject.toml"),
          `[project]
name = "my-python-project"
version = "0.1.0"
`,
        );

        const result = await detectProjectName();

        expect(result.name).toBe("my-python-project");
        expect(result.source).toBe("pyproject.toml");
      });

      it("detects project name from pyproject.toml [tool.poetry] section", async () => {
        await fsWriteFile(
          join(testDir, "pyproject.toml"),
          `[tool.poetry]
name = "poetry-project"
version = "0.1.0"
`,
        );

        const result = await detectProjectName();

        expect(result.name).toBe("poetry-project");
        expect(result.source).toBe("pyproject.toml");
      });

      it("prioritizes [project] over [tool.poetry]", async () => {
        await fsWriteFile(
          join(testDir, "pyproject.toml"),
          `[project]
name = "pep621-project"
version = "0.1.0"

[tool.poetry]
name = "poetry-project"
`,
        );

        const result = await detectProjectName();

        expect(result.name).toBe("pep621-project");
      });
    });

    describe("go.mod detection", () => {
      it("detects project name from go.mod", async () => {
        await fsWriteFile(
          join(testDir, "go.mod"),
          `module github.com/myorg/my-go-project

go 1.21
`,
        );

        const result = await detectProjectName();

        expect(result.name).toBe("my-go-project");
        expect(result.source).toBe("go.mod");
      });

      it("handles simple module names", async () => {
        await fsWriteFile(
          join(testDir, "go.mod"),
          `module simple-module

go 1.21
`,
        );

        const result = await detectProjectName();

        expect(result.name).toBe("simple-module");
        expect(result.source).toBe("go.mod");
      });

      it("extracts last segment from deep module paths", async () => {
        await fsWriteFile(
          join(testDir, "go.mod"),
          `module github.com/org/suborg/deep/project-name

go 1.21
`,
        );

        const result = await detectProjectName();

        expect(result.name).toBe("project-name");
      });
    });

    describe("git remote detection", () => {
      it("falls back to git remote when no config files exist", async () => {
        // Initialize a git repo with a remote
        const { spawnSync } = await import("child_process");
        spawnSync("git", ["init"], { cwd: testDir });
        spawnSync(
          "git",
          [
            "remote",
            "add",
            "origin",
            "https://github.com/testorg/test-repo.git",
          ],
          { cwd: testDir },
        );

        const result = await detectProjectName();

        expect(result.name).toBe("test-repo");
        expect(result.source).toBe("git-remote");
      });

      it("handles SSH remote URLs", async () => {
        const { spawnSync } = await import("child_process");
        spawnSync("git", ["init"], { cwd: testDir });
        spawnSync(
          "git",
          ["remote", "add", "origin", "git@github.com:testorg/ssh-repo.git"],
          { cwd: testDir },
        );

        const result = await detectProjectName();

        expect(result.name).toBe("ssh-repo");
        expect(result.source).toBe("git-remote");
      });

      it("handles HTTPS URLs without .git suffix", async () => {
        const { spawnSync } = await import("child_process");
        spawnSync("git", ["init"], { cwd: testDir });
        spawnSync(
          "git",
          [
            "remote",
            "add",
            "origin",
            "https://github.com/testorg/no-git-suffix",
          ],
          { cwd: testDir },
        );

        const result = await detectProjectName();

        expect(result.name).toBe("no-git-suffix");
        expect(result.source).toBe("git-remote");
      });
    });

    describe("directory fallback", () => {
      it("falls back to directory name when no other source available", async () => {
        // No package.json, Cargo.toml, pyproject.toml, go.mod, or git remote
        const result = await detectProjectName();

        // The temp directory name starts with "sequant-project-name-test-"
        expect(result.source).toBe("directory");
        expect(result.name).toMatch(/^sequant-project-name-test-/);
      });
    });

    describe("priority order", () => {
      it("prefers package.json over all others", async () => {
        await fsWriteFile(
          join(testDir, "package.json"),
          JSON.stringify({ name: "node-wins" }),
        );
        await fsWriteFile(
          join(testDir, "Cargo.toml"),
          `[package]\nname = "rust-loses"`,
        );
        await fsWriteFile(
          join(testDir, "pyproject.toml"),
          `[project]\nname = "python-loses"`,
        );
        await fsWriteFile(
          join(testDir, "go.mod"),
          `module github.com/org/go-loses`,
        );

        const result = await detectProjectName();

        expect(result.name).toBe("node-wins");
        expect(result.source).toBe("package.json");
      });

      it("prefers Cargo.toml when no package.json", async () => {
        await fsWriteFile(
          join(testDir, "Cargo.toml"),
          `[package]\nname = "rust-wins"`,
        );
        await fsWriteFile(
          join(testDir, "pyproject.toml"),
          `[project]\nname = "python-loses"`,
        );

        const result = await detectProjectName();

        expect(result.name).toBe("rust-wins");
        expect(result.source).toBe("Cargo.toml");
      });

      it("prefers pyproject.toml when no package.json or Cargo.toml", async () => {
        await fsWriteFile(
          join(testDir, "pyproject.toml"),
          `[project]\nname = "python-wins"`,
        );
        await fsWriteFile(
          join(testDir, "go.mod"),
          `module github.com/org/go-loses`,
        );

        const result = await detectProjectName();

        expect(result.name).toBe("python-wins");
        expect(result.source).toBe("pyproject.toml");
      });
    });
  });

  describe("getProjectName", () => {
    it("returns just the name string", async () => {
      await fsWriteFile(
        join(testDir, "package.json"),
        JSON.stringify({ name: "simple-name" }),
      );

      const name = await getProjectName();

      expect(name).toBe("simple-name");
      expect(typeof name).toBe("string");
    });
  });

  describe("graceful fallback (AC-3)", () => {
    it("always returns a usable name, never keeps literal placeholder", async () => {
      // Empty directory with no config files, no git
      // This tests AC-3: "Falls back gracefully if no name detected"
      const result = await detectProjectName();

      // Should always get a name (directory fallback)
      expect(result.name).toBeTruthy();
      expect(result.name).not.toBe("{{PROJECT_NAME}}");
      expect(result.name).not.toContain("{{");
      expect(result.source).toBe("directory");
    });

    it("uses directory name as final fallback", async () => {
      const result = await detectProjectName();

      // Directory name should be the temp dir name
      const expectedDirName = basename(testDir);
      expect(result.name).toBe(expectedDirName);
    });

    it("never returns empty string", async () => {
      const result = await detectProjectName();

      expect(result.name.length).toBeGreaterThan(0);
    });
  });

  describe("integration with processTemplate", () => {
    it("detected project name replaces {{PROJECT_NAME}} in templates", async () => {
      await fsWriteFile(
        join(testDir, "package.json"),
        JSON.stringify({ name: "my-awesome-project" }),
      );

      const projectName = await getProjectName();
      const template =
        "# {{PROJECT_NAME}} Constitution\n\nWelcome to {{PROJECT_NAME}}!";
      const result = processTemplate(template, { PROJECT_NAME: projectName });

      expect(result).toBe(
        "# my-awesome-project Constitution\n\nWelcome to my-awesome-project!",
      );
      expect(result).not.toContain("{{PROJECT_NAME}}");
    });

    it("directory fallback name also replaces placeholder correctly", async () => {
      // No config files - will use directory name
      const projectName = await getProjectName();
      const template = "# {{PROJECT_NAME}} Constitution";
      const result = processTemplate(template, { PROJECT_NAME: projectName });

      // Should have the temp directory name, not the placeholder
      expect(result).not.toContain("{{PROJECT_NAME}}");
      expect(result).toMatch(/^# sequant-project-name-test-.+ Constitution$/);
    });

    it("scoped package names work in templates", async () => {
      await fsWriteFile(
        join(testDir, "package.json"),
        JSON.stringify({ name: "@myorg/my-package" }),
      );

      const projectName = await getProjectName();
      const template = "# {{PROJECT_NAME}} Constitution";
      const result = processTemplate(template, { PROJECT_NAME: projectName });

      expect(result).toBe("# @myorg/my-package Constitution");
    });
  });
});
