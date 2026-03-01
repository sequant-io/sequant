import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "fs";

// Mock fs module with both default and named exports
vi.mock("fs", () => {
  const existsSyncMock = vi.fn();
  const readFileSyncMock = vi.fn();
  return {
    default: {
      existsSync: existsSyncMock,
      readFileSync: readFileSyncMock,
    },
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  };
});

// Import module under test AFTER mocking
import {
  checkVersionSync,
  getVersionMismatchMessage,
} from "./plugin-version-sync.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

describe("plugin-version-sync", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("checkVersionSync", () => {
    it("returns inSync: true when versions match", () => {
      mockExistsSync.mockImplementation((filePath) => {
        const path = String(filePath);
        if (path.includes("marketplace.json")) return false;
        return true;
      });
      mockReadFileSync.mockImplementation((filePath) => {
        const path = String(filePath);
        if (path.includes("package.json")) {
          return JSON.stringify({ name: "sequant", version: "1.11.0" });
        }
        if (path.includes("plugin.json")) {
          return JSON.stringify({
            name: "sequant",
            version: "1.11.0",
            description: "test",
          });
        }
        return "";
      });

      const result = checkVersionSync("/test/project");

      expect(result.inSync).toBe(true);
      expect(result.packageVersion).toBe("1.11.0");
      expect(result.pluginVersion).toBe("1.11.0");
      expect(result.error).toBeUndefined();
    });

    it("returns inSync: false when versions differ", () => {
      mockExistsSync.mockImplementation((filePath) => {
        const path = String(filePath);
        if (path.includes("marketplace.json")) return false;
        return true;
      });
      mockReadFileSync.mockImplementation((filePath) => {
        const path = String(filePath);
        if (path.includes("package.json")) {
          return JSON.stringify({ name: "sequant", version: "1.12.0" });
        }
        if (path.includes("plugin.json")) {
          return JSON.stringify({
            name: "sequant",
            version: "1.11.0",
            description: "test",
          });
        }
        return "";
      });

      const result = checkVersionSync("/test/project");

      expect(result.inSync).toBe(false);
      expect(result.packageVersion).toBe("1.12.0");
      expect(result.pluginVersion).toBe("1.11.0");
      expect(result.error).toBeUndefined();
    });

    it("returns error when package.json not found", () => {
      mockExistsSync.mockReturnValue(false);

      const result = checkVersionSync("/test/project");

      expect(result.inSync).toBe(false);
      expect(result.error).toBe("package.json not found");
    });

    it("returns error when plugin.json not found", () => {
      mockExistsSync.mockImplementation((filePath) => {
        const path = String(filePath);
        if (path.includes("package.json")) return true;
        return false;
      });

      const result = checkVersionSync("/test/project");

      expect(result.inSync).toBe(false);
      expect(result.error).toBe("plugin.json not found");
    });

    it("returns error when package.json missing version", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((filePath) => {
        const path = String(filePath);
        if (path.includes("package.json")) {
          return JSON.stringify({ name: "sequant" }); // no version
        }
        if (path.includes("plugin.json")) {
          return JSON.stringify({ name: "sequant", version: "1.11.0" });
        }
        return "";
      });

      const result = checkVersionSync("/test/project");

      expect(result.inSync).toBe(false);
      expect(result.error).toBe("package.json missing version field");
    });

    it("returns error when plugin.json missing version", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((filePath) => {
        const path = String(filePath);
        if (path.includes("package.json")) {
          return JSON.stringify({ name: "sequant", version: "1.11.0" });
        }
        if (path.includes("plugin.json")) {
          return JSON.stringify({ name: "sequant" }); // no version
        }
        return "";
      });

      const result = checkVersionSync("/test/project");

      expect(result.inSync).toBe(false);
      expect(result.error).toBe("plugin.json missing version field");
    });

    it("returns inSync: true when all three files match", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((filePath) => {
        const path = String(filePath);
        if (path.includes("package.json")) {
          return JSON.stringify({ version: "1.11.0" });
        }
        if (path.includes("marketplace.json")) {
          return JSON.stringify({
            plugins: [{ version: "1.11.0" }],
          });
        }
        if (path.includes("plugin.json")) {
          return JSON.stringify({ version: "1.11.0" });
        }
        return "";
      });

      const result = checkVersionSync("/test/project");

      expect(result.inSync).toBe(true);
      expect(result.marketplaceVersion).toBe("1.11.0");
    });

    it("returns inSync: false when marketplace.json version differs", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((filePath) => {
        const path = String(filePath);
        if (path.includes("package.json")) {
          return JSON.stringify({ version: "1.12.0" });
        }
        if (path.includes("marketplace.json")) {
          return JSON.stringify({
            plugins: [{ version: "1.11.0" }],
          });
        }
        if (path.includes("plugin.json")) {
          return JSON.stringify({ version: "1.12.0" });
        }
        return "";
      });

      const result = checkVersionSync("/test/project");

      expect(result.inSync).toBe(false);
      expect(result.error).toContain("marketplace.json");
      expect(result.marketplaceVersion).toBe("1.11.0");
    });

    it("returns error on invalid JSON", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("{ invalid json }");

      const result = checkVersionSync("/test/project");

      expect(result.inSync).toBe(false);
      expect(result.error).toContain("Failed to parse JSON");
    });

    it("handles prerelease versions", () => {
      mockExistsSync.mockImplementation((filePath) => {
        const path = String(filePath);
        if (path.includes("marketplace.json")) return false;
        return true;
      });
      mockReadFileSync.mockImplementation((filePath) => {
        const path = String(filePath);
        if (path.includes("package.json")) {
          return JSON.stringify({ version: "2.0.0-beta.1" });
        }
        if (path.includes("plugin.json")) {
          return JSON.stringify({ version: "2.0.0-beta.1" });
        }
        return "";
      });

      const result = checkVersionSync("/test/project");

      expect(result.inSync).toBe(true);
      expect(result.packageVersion).toBe("2.0.0-beta.1");
    });
  });

  describe("getVersionMismatchMessage", () => {
    it("returns success message when in sync", () => {
      const result = {
        inSync: true,
        packageVersion: "1.11.0",
        pluginVersion: "1.11.0",
      };

      const message = getVersionMismatchMessage(result);

      expect(message).toContain("✓ Versions are in sync");
      expect(message).toContain("1.11.0");
    });

    it("returns error message with fix command when mismatched", () => {
      const result = {
        inSync: false,
        packageVersion: "1.12.0",
        pluginVersion: "1.11.0",
      };

      const message = getVersionMismatchMessage(result);

      expect(message).toContain("✗ Version mismatch!");
      expect(message).toContain("package.json:");
      expect(message).toContain("1.12.0");
      expect(message).toContain("plugin.json:");
      expect(message).toContain("1.11.0");
      expect(message).toContain("Run ./scripts/release.sh");
    });

    it("includes marketplace version in mismatch message when present", () => {
      const result = {
        inSync: false,
        packageVersion: "1.12.0",
        pluginVersion: "1.12.0",
        marketplaceVersion: "1.11.0",
      };

      const message = getVersionMismatchMessage(result);

      expect(message).toContain("marketplace.json:");
      expect(message).toContain("1.11.0");
    });

    it("returns error message when check failed", () => {
      const result = {
        inSync: false,
        packageVersion: null,
        pluginVersion: null,
        error: "package.json not found",
      };

      const message = getVersionMismatchMessage(result);

      expect(message).toContain("✗ Version sync check failed");
      expect(message).toContain("package.json not found");
    });
  });
});
