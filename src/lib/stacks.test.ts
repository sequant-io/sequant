import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectStack,
  getStackConfig,
  STACKS,
  detectPackageManager,
  getPackageManagerCommands,
  PM_CONFIG,
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
