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

  it("returns generic config for unknown stack", () => {
    const config = getStackConfig("unknown-stack");
    expect(config.name).toBe("generic");
  });

  it("returns generic config for empty string", () => {
    const config = getStackConfig("");
    expect(config.name).toBe("generic");
  });
});
