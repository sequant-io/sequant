import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectStack,
  getStackConfig,
  STACKS,
  detectPackageManager,
  getPackageManagerCommands,
  PM_CONFIG,
  STACK_NOTES,
  getStackNotes,
} from "./stacks.js";

// Mock the fs module
vi.mock("./fs.js", () => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
}));

import { fileExists, readFile } from "./fs.js";

const mockFileExists = vi.mocked(fileExists);
const mockReadFile = vi.mocked(readFile);

describe("STACKS", () => {
  describe("astro config", () => {
    it("has correct detection files", () => {
      expect(STACKS.astro.detection.files).toEqual([
        "astro.config.mjs",
        "astro.config.js",
        "astro.config.ts",
      ]);
    });

    it("has astro in packageDeps", () => {
      expect(STACKS.astro.detection.packageDeps).toContain("astro");
    });

    it("has correct commands", () => {
      expect(STACKS.astro.commands.build).toBe("npm run build");
      expect(STACKS.astro.commands.dev).toBe("npm run dev");
      expect(STACKS.astro.commands.test).toBe("npm test");
      expect(STACKS.astro.commands.lint).toBe("npm run lint");
    });
  });

  describe("sveltekit config", () => {
    it("has correct detection files", () => {
      expect(STACKS.sveltekit.detection.files).toEqual([
        "svelte.config.js",
        "svelte.config.ts",
      ]);
    });

    it("has @sveltejs/kit in packageDeps", () => {
      expect(STACKS.sveltekit.detection.packageDeps).toContain("@sveltejs/kit");
    });

    it("has correct commands", () => {
      expect(STACKS.sveltekit.commands.build).toBe("npm run build");
      expect(STACKS.sveltekit.commands.dev).toBe("npm run dev");
      expect(STACKS.sveltekit.commands.test).toBe("npm test");
      expect(STACKS.sveltekit.commands.lint).toBe("npm run lint");
    });

    it("has correct devUrl for Vite-based server", () => {
      expect(STACKS.sveltekit.devUrl).toBe("http://localhost:5173");
    });
  });

  describe("remix config", () => {
    it("has correct detection files", () => {
      expect(STACKS.remix.detection.files).toEqual([
        "remix.config.js",
        "remix.config.ts",
      ]);
    });

    it("has @remix-run/react in packageDeps", () => {
      expect(STACKS.remix.detection.packageDeps).toContain("@remix-run/react");
    });

    it("has correct commands", () => {
      expect(STACKS.remix.commands.build).toBe("npm run build");
      expect(STACKS.remix.commands.dev).toBe("npm run dev");
      expect(STACKS.remix.commands.test).toBe("npm test");
      expect(STACKS.remix.commands.lint).toBe("npm run lint");
    });

    it("has correct devUrl for Vite-based server", () => {
      expect(STACKS.remix.devUrl).toBe("http://localhost:5173");
    });
  });

  describe("nuxt config", () => {
    it("has correct detection files", () => {
      expect(STACKS.nuxt.detection.files).toEqual([
        "nuxt.config.ts",
        "nuxt.config.js",
      ]);
    });

    it("has nuxt in packageDeps", () => {
      expect(STACKS.nuxt.detection.packageDeps).toContain("nuxt");
    });

    it("has correct commands", () => {
      expect(STACKS.nuxt.commands.build).toBe("npm run build");
      expect(STACKS.nuxt.commands.dev).toBe("npm run dev");
      expect(STACKS.nuxt.commands.test).toBe("npm test");
      expect(STACKS.nuxt.commands.lint).toBe("npm run lint");
    });

    it("has correct devUrl", () => {
      expect(STACKS.nuxt.devUrl).toBe("http://localhost:3000");
    });
  });
});

describe("detectStack", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFileExists.mockResolvedValue(false);
    mockReadFile.mockResolvedValue("{}");
  });

  describe("Astro detection", () => {
    it("detects astro.config.mjs", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "astro.config.mjs";
      });

      const result = await detectStack();
      expect(result).toBe("astro");
    });

    it("detects astro.config.js", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "astro.config.js";
      });

      const result = await detectStack();
      expect(result).toBe("astro");
    });

    it("detects astro.config.ts", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "astro.config.ts";
      });

      const result = await detectStack();
      expect(result).toBe("astro");
    });

    it("detects astro in dependencies via package.json", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          dependencies: { astro: "^4.0.0" },
        }),
      );

      const result = await detectStack();
      expect(result).toBe("astro");
    });

    it("detects astro in devDependencies via package.json", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          devDependencies: { astro: "^4.0.0" },
        }),
      );

      const result = await detectStack();
      expect(result).toBe("astro");
    });
  });

  describe("SvelteKit detection", () => {
    it("detects svelte.config.js", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "svelte.config.js";
      });

      const result = await detectStack();
      expect(result).toBe("sveltekit");
    });

    it("detects svelte.config.ts", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "svelte.config.ts";
      });

      const result = await detectStack();
      expect(result).toBe("sveltekit");
    });

    it("detects @sveltejs/kit in dependencies via package.json", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          dependencies: { "@sveltejs/kit": "^2.0.0" },
        }),
      );

      const result = await detectStack();
      expect(result).toBe("sveltekit");
    });

    it("detects @sveltejs/kit in devDependencies via package.json", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          devDependencies: { "@sveltejs/kit": "^2.0.0" },
        }),
      );

      const result = await detectStack();
      expect(result).toBe("sveltekit");
    });
  });

  describe("Remix detection", () => {
    it("detects remix.config.js", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "remix.config.js";
      });

      const result = await detectStack();
      expect(result).toBe("remix");
    });

    it("detects remix.config.ts", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "remix.config.ts";
      });

      const result = await detectStack();
      expect(result).toBe("remix");
    });

    it("detects @remix-run/react in dependencies via package.json", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          dependencies: { "@remix-run/react": "^2.0.0" },
        }),
      );

      const result = await detectStack();
      expect(result).toBe("remix");
    });

    it("detects @remix-run/react in devDependencies via package.json", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          devDependencies: { "@remix-run/react": "^2.0.0" },
        }),
      );

      const result = await detectStack();
      expect(result).toBe("remix");
    });
  });

  describe("Nuxt detection", () => {
    it("detects nuxt.config.ts", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "nuxt.config.ts";
      });

      const result = await detectStack();
      expect(result).toBe("nuxt");
    });

    it("detects nuxt.config.js", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "nuxt.config.js";
      });

      const result = await detectStack();
      expect(result).toBe("nuxt");
    });

    it("detects nuxt in dependencies via package.json", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          dependencies: { nuxt: "^3.0.0" },
        }),
      );

      const result = await detectStack();
      expect(result).toBe("nuxt");
    });

    it("detects nuxt in devDependencies via package.json", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          devDependencies: { nuxt: "^3.0.0" },
        }),
      );

      const result = await detectStack();
      expect(result).toBe("nuxt");
    });
  });

  describe("priority", () => {
    it("Next.js takes priority over Astro when both present", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "next.config.js" || path === "astro.config.mjs";
      });

      const result = await detectStack();
      expect(result).toBe("nextjs");
    });

    it("Next.js dep takes priority over Astro dep", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          dependencies: { next: "^14.0.0", astro: "^4.0.0" },
        }),
      );

      const result = await detectStack();
      expect(result).toBe("nextjs");
    });

    it("Astro config file takes priority over Rust", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "astro.config.mjs" || path === "Cargo.toml";
      });

      const result = await detectStack();
      expect(result).toBe("astro");
    });

    it("Astro takes priority over SvelteKit when both present", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "astro.config.mjs" || path === "svelte.config.js";
      });

      const result = await detectStack();
      expect(result).toBe("astro");
    });

    it("SvelteKit takes priority over Remix when both present", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "svelte.config.js" || path === "remix.config.js";
      });

      const result = await detectStack();
      expect(result).toBe("sveltekit");
    });

    it("Remix takes priority over Nuxt when both present", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "remix.config.js" || path === "nuxt.config.ts";
      });

      const result = await detectStack();
      expect(result).toBe("remix");
    });

    it("SvelteKit dep takes priority over Remix dep", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          dependencies: {
            "@sveltejs/kit": "^2.0.0",
            "@remix-run/react": "^2.0.0",
          },
        }),
      );

      const result = await detectStack();
      expect(result).toBe("sveltekit");
    });

    it("Nuxt config file takes priority over Rust", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "nuxt.config.ts" || path === "Cargo.toml";
      });

      const result = await detectStack();
      expect(result).toBe("nuxt");
    });
  });

  describe("edge cases", () => {
    it("returns null when no stack detected", async () => {
      mockFileExists.mockResolvedValue(false);

      const result = await detectStack();
      expect(result).toBeNull();
    });

    it("handles malformed package.json gracefully", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });
      mockReadFile.mockResolvedValue("{ invalid json }");

      const result = await detectStack();
      expect(result).toBeNull();
    });

    it("handles empty package.json", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });
      mockReadFile.mockResolvedValue("{}");

      const result = await detectStack();
      expect(result).toBeNull();
    });
  });
});

describe("getStackConfig", () => {
  it("returns astro config for astro stack", () => {
    const config = getStackConfig("astro");
    expect(config.name).toBe("astro");
    expect(config.displayName).toBe("Astro");
  });

  it("returns sveltekit config for sveltekit stack", () => {
    const config = getStackConfig("sveltekit");
    expect(config.name).toBe("sveltekit");
    expect(config.displayName).toBe("SvelteKit");
  });

  it("returns remix config for remix stack", () => {
    const config = getStackConfig("remix");
    expect(config.name).toBe("remix");
    expect(config.displayName).toBe("Remix");
  });

  it("returns nuxt config for nuxt stack", () => {
    const config = getStackConfig("nuxt");
    expect(config.name).toBe("nuxt");
    expect(config.displayName).toBe("Nuxt");
  });

  it("returns generic config for unknown stack", () => {
    const config = getStackConfig("unknown-stack");
    expect(config.name).toBe("generic");
  });

  it("returns generic config for empty string", () => {
    const config = getStackConfig("");
    expect(config.name).toBe("generic");
  });
});

describe("detectPackageManager", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFileExists.mockResolvedValue(false);
  });

  describe("lockfile detection", () => {
    it("detects bun.lockb", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "bun.lockb";
      });

      const result = await detectPackageManager();
      expect(result).toBe("bun");
    });

    it("detects bun.lock", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "bun.lock";
      });

      const result = await detectPackageManager();
      expect(result).toBe("bun");
    });

    it("detects yarn.lock", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "yarn.lock";
      });

      const result = await detectPackageManager();
      expect(result).toBe("yarn");
    });

    it("detects pnpm-lock.yaml", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "pnpm-lock.yaml";
      });

      const result = await detectPackageManager();
      expect(result).toBe("pnpm");
    });

    it("detects package-lock.json", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package-lock.json";
      });

      const result = await detectPackageManager();
      expect(result).toBe("npm");
    });
  });

  describe("priority", () => {
    it("bun takes priority over yarn", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "bun.lockb" || path === "yarn.lock";
      });

      const result = await detectPackageManager();
      expect(result).toBe("bun");
    });

    it("yarn takes priority over pnpm", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "yarn.lock" || path === "pnpm-lock.yaml";
      });

      const result = await detectPackageManager();
      expect(result).toBe("yarn");
    });

    it("pnpm takes priority over npm", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "pnpm-lock.yaml" || path === "package-lock.json";
      });

      const result = await detectPackageManager();
      expect(result).toBe("pnpm");
    });
  });

  describe("fallback behavior", () => {
    it("falls back to npm when only package.json exists", async () => {
      mockFileExists.mockImplementation(async (path) => {
        return path === "package.json";
      });

      const result = await detectPackageManager();
      expect(result).toBe("npm");
    });

    it("returns null when no package.json exists", async () => {
      mockFileExists.mockResolvedValue(false);

      const result = await detectPackageManager();
      expect(result).toBeNull();
    });
  });
});

describe("getPackageManagerCommands", () => {
  it("returns correct npm commands", () => {
    const config = getPackageManagerCommands("npm");
    expect(config.run).toBe("npm run");
    expect(config.exec).toBe("npx");
    expect(config.install).toBe("npm install");
    expect(config.installSilent).toBe("npm install --silent");
  });

  it("returns correct bun commands", () => {
    const config = getPackageManagerCommands("bun");
    expect(config.run).toBe("bun run");
    expect(config.exec).toBe("bunx");
    expect(config.install).toBe("bun install");
    expect(config.installSilent).toBe("bun install --silent");
  });

  it("returns correct yarn commands", () => {
    const config = getPackageManagerCommands("yarn");
    expect(config.run).toBe("yarn");
    expect(config.exec).toBe("yarn dlx");
    expect(config.install).toBe("yarn install");
    expect(config.installSilent).toBe("yarn install --silent");
  });

  it("returns correct pnpm commands", () => {
    const config = getPackageManagerCommands("pnpm");
    expect(config.run).toBe("pnpm run");
    expect(config.exec).toBe("pnpm dlx");
    expect(config.install).toBe("pnpm install");
    expect(config.installSilent).toBe("pnpm install --silent");
  });
});

describe("PM_CONFIG", () => {
  it("has all supported package managers", () => {
    expect(PM_CONFIG).toHaveProperty("npm");
    expect(PM_CONFIG).toHaveProperty("bun");
    expect(PM_CONFIG).toHaveProperty("yarn");
    expect(PM_CONFIG).toHaveProperty("pnpm");
  });
});

describe("STACK_NOTES", () => {
  it("has notes for all supported stacks", () => {
    const supportedStacks = [
      "nextjs",
      "astro",
      "sveltekit",
      "remix",
      "nuxt",
      "rust",
      "python",
      "go",
      "generic",
    ];

    for (const stack of supportedStacks) {
      expect(STACK_NOTES).toHaveProperty(stack);
      expect(STACK_NOTES[stack]).toBeTruthy();
    }
  });

  it("includes testing section for each stack", () => {
    for (const [stack, notes] of Object.entries(STACK_NOTES)) {
      expect(notes.toLowerCase()).toContain("test");
    }
  });

  it("includes linting section for each stack", () => {
    for (const [stack, notes] of Object.entries(STACK_NOTES)) {
      expect(notes.toLowerCase()).toContain("lint");
    }
  });

  it("includes build section for each stack", () => {
    for (const [stack, notes] of Object.entries(STACK_NOTES)) {
      expect(notes.toLowerCase()).toContain("build");
    }
  });

  describe("stack-specific content", () => {
    it("nextjs notes mention Jest and next/jest", () => {
      expect(STACK_NOTES.nextjs).toContain("Jest");
      expect(STACK_NOTES.nextjs).toContain("next/jest");
    });

    it("astro notes mention Vitest", () => {
      expect(STACK_NOTES.astro).toContain("Vitest");
    });

    it("rust notes mention cargo commands", () => {
      expect(STACK_NOTES.rust).toContain("cargo test");
      expect(STACK_NOTES.rust).toContain("cargo clippy");
    });

    it("python notes mention pytest and ruff", () => {
      expect(STACK_NOTES.python).toContain("pytest");
      expect(STACK_NOTES.python).toContain("ruff");
    });

    it("go notes mention go test and golangci-lint", () => {
      expect(STACK_NOTES.go).toContain("go test");
      expect(STACK_NOTES.go).toContain("golangci-lint");
    });
  });
});

describe("getStackNotes", () => {
  it("returns notes for known stacks", () => {
    expect(getStackNotes("nextjs")).toBe(STACK_NOTES.nextjs);
    expect(getStackNotes("rust")).toBe(STACK_NOTES.rust);
    expect(getStackNotes("python")).toBe(STACK_NOTES.python);
  });

  it("falls back to generic notes for unknown stack", () => {
    expect(getStackNotes("unknown-stack")).toBe(STACK_NOTES.generic);
  });

  it("falls back to generic notes for empty string", () => {
    expect(getStackNotes("")).toBe(STACK_NOTES.generic);
  });

  it("returns non-empty string for all supported stacks", () => {
    const supportedStacks = [
      "nextjs",
      "astro",
      "sveltekit",
      "remix",
      "nuxt",
      "rust",
      "python",
      "go",
      "generic",
    ];

    for (const stack of supportedStacks) {
      const notes = getStackNotes(stack);
      expect(notes.length).toBeGreaterThan(100);
    }
  });
});
