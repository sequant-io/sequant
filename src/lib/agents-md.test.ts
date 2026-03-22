import { describe, it, expect, vi, afterEach } from "vitest";
import {
  extractPortableInstructions,
  checkAgentsMdConsistency,
  formatConventionsAsAgentsMd,
  generateAgentsMd,
} from "./agents-md.js";
import type { ConventionsFile } from "./conventions-detector.js";

vi.mock("./fs.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fileExists: vi.fn().mockResolvedValue(false),
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("./conventions-detector.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    loadConventions: vi.fn().mockResolvedValue(null),
  };
});

describe("agents-md", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("extractPortableInstructions", () => {
    it("returns non-Claude-specific sections", () => {
      const claudeMd = `# My Project

## Commit Rules

- Do NOT add Co-Authored-By lines

## Code Style

- Use camelCase
`;
      const result = extractPortableInstructions(claudeMd);
      expect(result).toContain("Commit Rules");
      expect(result).toContain("Co-Authored-By");
      expect(result).toContain("Code Style");
      expect(result).toContain("camelCase");
    });

    it("strips Claude-specific sections", () => {
      const claudeMd = `# Sequant

## Commit Rules

- No force push

## Slash Commands

- /spec, /exec, /qa

## Hook Configuration

- pre-tool.sh runs before each tool

## Code Style

- Use tabs
`;
      const result = extractPortableInstructions(claudeMd);
      expect(result).toContain("Commit Rules");
      expect(result).toContain("Code Style");
      expect(result).not.toContain("Slash Commands");
      expect(result).not.toContain("/spec, /exec, /qa");
      expect(result).not.toContain("Hook Configuration");
      expect(result).not.toContain("pre-tool.sh");
    });

    it("removes top-level heading", () => {
      const claudeMd = `# My Project

## Rules

- Rule 1
`;
      const result = extractPortableInstructions(claudeMd);
      expect(result).not.toMatch(/^# My Project/);
      expect(result).toContain("## Rules");
    });

    it("returns empty string for empty input", () => {
      expect(extractPortableInstructions("")).toBe("");
    });

    it("handles CLAUDE.md with only Claude-specific sections", () => {
      const claudeMd = `# Sequant

## Slash Commands

- /spec
- /exec

## Hooks

- pre-tool hook
`;
      const result = extractPortableInstructions(claudeMd);
      // Should only have empty string (top heading removed, all sections stripped)
      expect(result.trim()).toBe("");
    });
  });

  describe("checkAgentsMdConsistency", () => {
    it("returns null when consistent", () => {
      const agentsMd = "Contains Co-Authored-By reference and commit rules";
      const claudeMd = `# Project\n\n## Commit Rules\n\n- No Co-Authored-By`;
      expect(checkAgentsMdConsistency(agentsMd, claudeMd)).toBeNull();
    });

    it("detects missing Co-Authored-By reference", () => {
      const agentsMd = "Some generic AGENTS.md content";
      const claudeMd = `# Project\n\n## Commit Rules\n\n- Do NOT add Co-Authored-By lines`;
      const result = checkAgentsMdConsistency(agentsMd, claudeMd);
      expect(result).toContain("Co-Authored-By");
    });

    it("returns null when CLAUDE.md has no portable commit rules", () => {
      const agentsMd = "AGENTS.md content";
      const claudeMd = `# Project\n\n## Slash Commands\n\n- /spec`;
      expect(checkAgentsMdConsistency(agentsMd, claudeMd)).toBeNull();
    });
  });

  describe("formatConventionsAsAgentsMd", () => {
    it("formats detected conventions", () => {
      const conventions: ConventionsFile = {
        detected: {
          testFilePattern: "*.test.ts",
          indentation: "2 spaces",
        },
        manual: {},
        detectedAt: "2026-01-01",
      };
      const result = formatConventionsAsAgentsMd(conventions);
      expect(result).toContain("# AGENTS.md");
      expect(result).toContain("## Code Conventions");
      expect(result).toContain("**testFilePattern**: *.test.ts");
      expect(result).toContain("**indentation**: 2 spaces");
    });

    it("includes manual conventions", () => {
      const conventions: ConventionsFile = {
        detected: {},
        manual: { semicolons: "always" },
        detectedAt: "2026-01-01",
      };
      const result = formatConventionsAsAgentsMd(conventions);
      expect(result).toContain("**semicolons**: always");
    });

    it("handles empty conventions", () => {
      const conventions: ConventionsFile = {
        detected: {},
        manual: {},
        detectedAt: "2026-01-01",
      };
      const result = formatConventionsAsAgentsMd(conventions);
      expect(result).toContain("No conventions detected");
    });
  });

  describe("generateAgentsMd", () => {
    it("generates valid AGENTS.md content", async () => {
      const content = await generateAgentsMd({
        projectName: "test-project",
        stack: "generic",
      });

      expect(content).toContain("# AGENTS.md");
      expect(content).toContain("## Project Overview");
      expect(content).toContain("test-project");
      expect(content).toContain("## Development Commands");
      expect(content).toContain("## Code Conventions");
      expect(content).toContain("## Workflow");
      expect(content).toContain("Sequant");
    });

    it("includes stack-specific commands", async () => {
      const content = await generateAgentsMd({
        projectName: "my-app",
        stack: "nextjs",
        buildCommand: "npm run build",
        testCommand: "npm test",
        lintCommand: "npm run lint",
      });

      expect(content).toContain("npm run build");
      expect(content).toContain("npm test");
      expect(content).toContain("npm run lint");
    });

    it("includes stack display name", async () => {
      const content = await generateAgentsMd({
        projectName: "my-app",
        stack: "nextjs",
      });

      expect(content).toContain("Next.js");
    });

    describe("snapshot per stack", () => {
      const stacks = ["nextjs", "rust", "python", "go", "generic"];

      for (const stack of stacks) {
        it(`generates expected output for ${stack}`, async () => {
          const content = await generateAgentsMd({
            projectName: `test-${stack}-project`,
            stack,
          });

          expect(content).toMatchSnapshot();
        });
      }
    });
  });
});
