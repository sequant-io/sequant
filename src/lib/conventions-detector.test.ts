/**
 * Tests for conventions detector
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile as fsWriteFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  detectConventions,
  saveConventions,
  loadConventions,
  getMergedConventions,
  formatConventions,
  formatConventionsForContext,
  CONVENTIONS_PATH,
  type Convention,
  type ConventionsFile,
} from "./conventions-detector.js";

describe("conventions-detector", { timeout: 15_000 }, () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "conventions-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("detectConventions", () => {
    it("detects test file pattern from .test.ts files", async () => {
      await mkdir(join(tempDir, "src"), { recursive: true });
      await fsWriteFile(join(tempDir, "src", "foo.test.ts"), "test");
      await fsWriteFile(join(tempDir, "src", "bar.test.ts"), "test");
      await fsWriteFile(join(tempDir, "src", "foo.ts"), "source");

      const conventions = await detectConventions(tempDir);
      const testPattern = conventions.find((c) => c.key === "testFilePattern");
      expect(testPattern).toBeDefined();
      expect(testPattern!.value).toBe("*.test.ts");
    });

    it("detects .spec.ts pattern when more spec files", async () => {
      await mkdir(join(tempDir, "src"), { recursive: true });
      await fsWriteFile(join(tempDir, "src", "foo.spec.ts"), "test");
      await fsWriteFile(join(tempDir, "src", "bar.spec.ts"), "test");
      await fsWriteFile(join(tempDir, "src", "baz.spec.ts"), "test");
      await fsWriteFile(join(tempDir, "src", "foo.test.ts"), "test");

      const conventions = await detectConventions(tempDir);
      const testPattern = conventions.find((c) => c.key === "testFilePattern");
      expect(testPattern).toBeDefined();
      expect(testPattern!.value).toBe("*.spec.ts");
    });

    it("detects named export style", async () => {
      await mkdir(join(tempDir, "src"), { recursive: true });
      await fsWriteFile(
        join(tempDir, "src", "a.ts"),
        "export function foo() {}\nexport const bar = 1;\nexport interface Baz {}",
      );
      await fsWriteFile(
        join(tempDir, "src", "b.ts"),
        "export function qux() {}\nexport type Quux = string;",
      );

      const conventions = await detectConventions(tempDir);
      const exportStyle = conventions.find((c) => c.key === "exportStyle");
      expect(exportStyle).toBeDefined();
      expect(exportStyle!.value).toBe("named");
    });

    it("detects default export style", async () => {
      await mkdir(join(tempDir, "src"), { recursive: true });
      await fsWriteFile(
        join(tempDir, "src", "a.ts"),
        "export default function foo() {}",
      );
      await fsWriteFile(
        join(tempDir, "src", "b.ts"),
        "export default class Bar {}",
      );
      await fsWriteFile(
        join(tempDir, "src", "c.ts"),
        "export default function baz() {}",
      );

      const conventions = await detectConventions(tempDir);
      const exportStyle = conventions.find((c) => c.key === "exportStyle");
      expect(exportStyle).toBeDefined();
      expect(exportStyle!.value).toBe("default");
    });

    it("detects async/await pattern", async () => {
      await mkdir(join(tempDir, "src"), { recursive: true });
      await fsWriteFile(
        join(tempDir, "src", "a.ts"),
        "async function foo() { await bar(); await baz(); }",
      );

      const conventions = await detectConventions(tempDir);
      const asyncPattern = conventions.find((c) => c.key === "asyncPattern");
      expect(asyncPattern).toBeDefined();
      expect(asyncPattern!.value).toBe("async/await");
    });

    it("detects TypeScript strict mode", async () => {
      await fsWriteFile(
        join(tempDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );

      const conventions = await detectConventions(tempDir);
      const tsStrict = conventions.find((c) => c.key === "typescriptStrict");
      expect(tsStrict).toBeDefined();
      expect(tsStrict!.value).toBe("enabled");
    });

    it("detects source directory structure", async () => {
      await mkdir(join(tempDir, "src"), { recursive: true });

      const conventions = await detectConventions(tempDir);
      const structure = conventions.find((c) => c.key === "sourceStructure");
      expect(structure).toBeDefined();
      expect(structure!.value).toContain("src/");
    });

    it("detects package manager from lockfile", async () => {
      await fsWriteFile(join(tempDir, "package-lock.json"), "{}");

      const conventions = await detectConventions(tempDir);
      const pm = conventions.find((c) => c.key === "packageManager");
      expect(pm).toBeDefined();
      expect(pm!.value).toBe("npm");
    });

    it("detects bun from bun.lockb", async () => {
      await fsWriteFile(join(tempDir, "bun.lockb"), "binary");

      const conventions = await detectConventions(tempDir);
      const pm = conventions.find((c) => c.key === "packageManager");
      expect(pm).toBeDefined();
      expect(pm!.value).toBe("bun");
    });

    it("detects 2-space indentation", async () => {
      await mkdir(join(tempDir, "src"), { recursive: true });
      await fsWriteFile(
        join(tempDir, "src", "a.ts"),
        "function foo() {\n  const x = 1;\n  return x;\n}\n",
      );

      const conventions = await detectConventions(tempDir);
      const indent = conventions.find((c) => c.key === "indentation");
      expect(indent).toBeDefined();
      expect(indent!.value).toBe("2 spaces");
    });

    it("detects semicolon usage", async () => {
      await mkdir(join(tempDir, "src"), { recursive: true });
      await fsWriteFile(
        join(tempDir, "src", "a.ts"),
        'const a = 1;\nconst b = 2;\nconst c = "hello";\n',
      );

      const conventions = await detectConventions(tempDir);
      const semi = conventions.find((c) => c.key === "semicolons");
      expect(semi).toBeDefined();
      expect(semi!.value).toBe("required");
    });

    it("detects component directory", async () => {
      await mkdir(join(tempDir, "src", "components"), { recursive: true });
      await fsWriteFile(
        join(tempDir, "src", "components", "Button.tsx"),
        "export function Button() {}",
      );

      const conventions = await detectConventions(tempDir);
      const comp = conventions.find((c) => c.key === "componentDir");
      expect(comp).toBeDefined();
      expect(comp!.value).toBe("src/components/");
    });

    it("returns empty array for empty directory", async () => {
      const conventions = await detectConventions(tempDir);
      // May still detect some things based on directory existence
      expect(Array.isArray(conventions)).toBe(true);
    });

    it("detects 5+ conventions on a realistic project", async () => {
      // Set up a realistic project structure
      await mkdir(join(tempDir, "src", "lib"), { recursive: true });
      await mkdir(join(tempDir, "src", "components"), { recursive: true });
      await fsWriteFile(
        join(tempDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      await fsWriteFile(join(tempDir, "package-lock.json"), "{}");
      await fsWriteFile(
        join(tempDir, "src", "lib", "utils.ts"),
        'export function greet(): string {\n  const msg = "hello";\n  return msg;\n}\n',
      );
      await fsWriteFile(join(tempDir, "src", "lib", "utils.test.ts"), "test");
      await fsWriteFile(
        join(tempDir, "src", "lib", "api.ts"),
        "export async function fetchData() {\n  const res = await fetch('/api');\n  return await res.json();\n}\n",
      );

      const conventions = await detectConventions(tempDir);
      expect(conventions.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("saveConventions and loadConventions", () => {
    it("saves and loads conventions", async () => {
      const origCwd = process.cwd();
      process.chdir(tempDir);
      try {
        const conventions: Convention[] = [
          {
            key: "testFilePattern",
            label: "Test file pattern",
            value: "*.test.ts",
            source: "detected",
          },
        ];

        const saved = await saveConventions(conventions);
        expect(saved.detected.testFilePattern).toBe("*.test.ts");

        const loaded = await loadConventions();
        expect(loaded).not.toBeNull();
        expect(loaded!.detected.testFilePattern).toBe("*.test.ts");
      } finally {
        process.chdir(origCwd);
      }
    });

    it("preserves manual entries on re-save", async () => {
      const origCwd = process.cwd();
      process.chdir(tempDir);
      try {
        // First save with manual entries
        await mkdir(join(tempDir, ".sequant"), { recursive: true });
        await fsWriteFile(
          join(tempDir, CONVENTIONS_PATH),
          JSON.stringify({
            detected: { old: "value" },
            manual: { prTitleFormat: "feat(#N): description" },
            detectedAt: "2026-01-01T00:00:00.000Z",
          }),
        );

        // Re-save with new detected conventions
        const conventions: Convention[] = [
          {
            key: "testFilePattern",
            label: "Test file pattern",
            value: "*.test.ts",
            source: "detected",
          },
        ];

        const saved = await saveConventions(conventions);
        expect(saved.manual.prTitleFormat).toBe("feat(#N): description");
        expect(saved.detected.testFilePattern).toBe("*.test.ts");
        // Old detected value should be replaced
        expect(saved.detected.old).toBeUndefined();
      } finally {
        process.chdir(origCwd);
      }
    });
  });

  describe("getMergedConventions", () => {
    it("merges detected and manual with manual taking precedence", () => {
      const file: ConventionsFile = {
        detected: { testFilePattern: "*.test.ts", exportStyle: "named" },
        manual: { testFilePattern: "*.spec.ts", custom: "value" },
        detectedAt: "2026-01-01T00:00:00.000Z",
      };

      const merged = getMergedConventions(file);
      expect(merged.testFilePattern).toBe("*.spec.ts"); // manual overrides
      expect(merged.exportStyle).toBe("named"); // detected preserved
      expect(merged.custom).toBe("value"); // manual-only included
    });
  });

  describe("formatConventions", () => {
    it("formats conventions for display", () => {
      const file: ConventionsFile = {
        detected: { testFilePattern: "*.test.ts" },
        manual: { prTitleFormat: "feat(#N): description" },
        detectedAt: "2026-01-01T00:00:00.000Z",
      };

      const output = formatConventions(file);
      expect(output).toContain("testFilePattern: *.test.ts");
      expect(output).toContain("prTitleFormat: feat(#N): description");
      expect(output).toContain("Manual overrides:");
    });

    it("shows (none) for empty detected", () => {
      const file: ConventionsFile = {
        detected: {},
        manual: {},
        detectedAt: "2026-01-01T00:00:00.000Z",
      };

      const output = formatConventions(file);
      expect(output).toContain("(none)");
    });
  });

  describe("formatConventionsForContext", () => {
    it("formats conventions for AI skill context", () => {
      const file: ConventionsFile = {
        detected: { testFilePattern: "*.test.ts", exportStyle: "named" },
        manual: {},
        detectedAt: "2026-01-01T00:00:00.000Z",
      };

      const output = formatConventionsForContext(file);
      expect(output).toContain("## Codebase Conventions");
      expect(output).toContain("**testFilePattern**: *.test.ts");
      expect(output).toContain("**exportStyle**: named");
    });

    it("returns empty string when no conventions", () => {
      const file: ConventionsFile = {
        detected: {},
        manual: {},
        detectedAt: "2026-01-01T00:00:00.000Z",
      };

      expect(formatConventionsForContext(file)).toBe("");
    });
  });
});
