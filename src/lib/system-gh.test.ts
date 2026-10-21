import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  loadGhFixture,
  type GhReplay,
} from "./workflow/platforms/gh-fixtures.js";

// The gh-facing system helpers, split from system.test.ts so neither fakes gh
// through child_process (#1506): isGhAuthenticated replays captured gh output
// through the provider's runner seam, and getInstallHint is a table lookup.
const gh = vi.hoisted((): GhReplay => ({ fixtures: [], calls: [] }));
vi.mock("./workflow/platforms/github.js", async (importOriginal) =>
  (await import("./workflow/platforms/gh-fixtures.js")).replayGitHubModule(
    importOriginal,
    gh,
  ),
);

import { isGhAuthenticated, getInstallHint } from "./system.js";

describe("system utilities (gh)", () => {
  beforeEach(() => {
    gh.fixtures = [];
    gh.calls.length = 0;
  });

  describe("isGhAuthenticated", () => {
    it("returns true when gh is authenticated", () => {
      gh.fixtures = [loadGhFixture("auth-status")];

      expect(isGhAuthenticated()).toBe(true);
      expect(gh.calls[0]).toEqual({
        args: ["auth", "status"],
        opts: { timeout: 10_000 },
      });
    });

    it("returns false when gh is not authenticated", () => {
      gh.fixtures = [loadGhFixture("auth-status-logged-out")];

      expect(isGhAuthenticated()).toBe(false);
    });
  });

  describe("getInstallHint", () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      // Reset platform after each test
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        writable: true,
      });
    });

    it("returns macOS hint for gh on darwin", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      expect(getInstallHint("gh")).toBe("brew install gh");
    });

    it("returns macOS hint for jq on darwin", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      expect(getInstallHint("jq")).toBe("brew install jq");
    });

    it("returns Linux hint for gh on linux", () => {
      Object.defineProperty(process, "platform", { value: "linux" });

      expect(getInstallHint("gh")).toContain("apt install gh");
    });

    it("returns Windows hint for gh on win32", () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      expect(getInstallHint("gh")).toContain("choco install gh");
    });

    it("returns generic hint for unknown package", () => {
      expect(getInstallHint("unknown-package")).toBe("Install unknown-package");
    });

    it("returns npm hint for claude on any platform", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      expect(getInstallHint("claude")).toContain(
        "npm install -g @anthropic-ai/claude-code",
      );

      Object.defineProperty(process, "platform", { value: "linux" });
      expect(getInstallHint("claude")).toContain(
        "npm install -g @anthropic-ai/claude-code",
      );

      Object.defineProperty(process, "platform", { value: "win32" });
      expect(getInstallHint("claude")).toContain(
        "npm install -g @anthropic-ai/claude-code",
      );
    });
  });
});
