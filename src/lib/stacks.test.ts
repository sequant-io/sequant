import { describe, it, expect, vi, beforeEach } from "vitest";
import { detectStack, getStackConfig, STACKS } from "./stacks.js";

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
