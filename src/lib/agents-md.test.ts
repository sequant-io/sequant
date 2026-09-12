import { describe, it, expect, vi, afterEach } from "vitest";
import {
  extractPortableInstructions,
  formatConventionsAsAgentsMd,
  generateAgentsMd,
  parseAgentsMdMarker,
  stripAgentsMdMarker,
  hashAgentsMdBody,
  isAgentsMdSequantOwned,
  decideAgentsMdSync,
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

// The AGENTS.md marker embeds the package version (#990 AC-1). Pin it so the
// per-stack snapshots do not rot on every release — they broke on the
// 2.15.0 bump because the recorded marker said v=2.14.0.
vi.mock("./manifest.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getPackageVersion: () => "0.0.0-test" };
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

    it("begins with a self-verifying marker whose hash recomputes from the body (AC-1)", async () => {
      const content = await generateAgentsMd({
        projectName: "test-project",
        stack: "generic",
      });

      const firstLine = content.split("\n")[0];
      expect(firstLine).toMatch(
        /^<!-- sequant:agents-md v=\S+ h=[0-9a-f]{40} -->$/,
      );

      const marker = parseAgentsMdMarker(content);
      expect(marker).not.toBeNull();
      const body = stripAgentsMdMarker(content);
      expect(hashAgentsMdBody(body)).toBe(marker!.hash);
    });
  });

  describe("isAgentsMdSequantOwned / decideAgentsMdSync (AC-2)", () => {
    it("is not owned when there is no marker", () => {
      expect(
        isAgentsMdSequantOwned("# AGENTS.md\n\nHand-written content\n"),
      ).toBe(false);
    });

    it("is not owned when the marker's hash doesn't match the body", () => {
      const content =
        "<!-- sequant:agents-md v=1.0.0 h=0000000000000000000000000000000000000000 -->\n# AGENTS.md\nEdited after generation\n";
      expect(isAgentsMdSequantOwned(content)).toBe(false);
    });

    it("is owned when the marker's hash matches the recomputed body hash", async () => {
      const content = await generateAgentsMd({
        projectName: "test-project",
        stack: "generic",
      });
      expect(isAgentsMdSequantOwned(content)).toBe(true);
    });

    it("decides skipped when disabled, none when absent, preserved when unowned, regenerate when owned or forced", () => {
      expect(
        decideAgentsMdSync({
          enabled: false,
          existingContent: null,
          force: false,
        }),
      ).toBe("skipped (--no-agents-md)");
      expect(
        decideAgentsMdSync({
          enabled: true,
          existingContent: null,
          force: false,
        }),
      ).toBe("none");
      expect(
        decideAgentsMdSync({
          enabled: true,
          existingContent: "# AGENTS.md\nhand-written\n",
          force: false,
        }),
      ).toBe("preserved");
      expect(
        decideAgentsMdSync({
          enabled: true,
          existingContent: "# AGENTS.md\nhand-written\n",
          force: true,
        }),
      ).toBe("regenerate");
    });
  });
});
