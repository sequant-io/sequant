import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs functions
vi.mock("../lib/fs.js", () => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

// Mock manifest
vi.mock("../lib/manifest.js", () => ({
  getManifest: vi.fn(),
  updateManifest: vi.fn(),
  getPackageVersion: vi.fn(() => "1.1.0"),
}));

// Mock templates
vi.mock("../lib/templates.js", () => ({
  copyTemplates: vi.fn(),
  computeTemplateChanges: vi.fn(),
}));

// Mock config
vi.mock("../lib/config.js", () => ({
  getConfig: vi.fn(),
}));

import { getSkillsVersion, areSkillsOutdated, syncCommand } from "./sync.js";
import { fileExists, readFile, writeFile } from "../lib/fs.js";
import { getManifest, getPackageVersion } from "../lib/manifest.js";
import { copyTemplates, computeTemplateChanges } from "../lib/templates.js";
import { getConfig } from "../lib/config.js";

const mockFileExists = vi.mocked(fileExists);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockGetManifest = vi.mocked(getManifest);
const mockGetPackageVersion = vi.mocked(getPackageVersion);
const mockCopyTemplates = vi.mocked(copyTemplates);
const mockComputeTemplateChanges = vi.mocked(computeTemplateChanges);
const mockGetConfig = vi.mocked(getConfig);

describe("sync command", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    // Some paths (missing manifest, content drift) set a non-zero exit code;
    // reset so it never leaks across tests or into the vitest process.
    process.exitCode = 0;
  });

  describe("getSkillsVersion", () => {
    it("returns null when version file does not exist", async () => {
      mockFileExists.mockResolvedValue(false);

      const version = await getSkillsVersion();

      expect(version).toBeNull();
    });

    it("returns version from file when it exists", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0\n");

      const version = await getSkillsVersion();

      expect(version).toBe("1.0.0");
    });
  });

  describe("areSkillsOutdated", () => {
    it("returns outdated true when versions differ", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(true);
      expect(result.currentVersion).toBe("1.0.0");
      expect(result.packageVersion).toBe("1.1.0");
    });

    it("returns outdated false when versions match", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(false);
    });

    it("returns outdated true when version file missing", async () => {
      mockFileExists.mockResolvedValue(false);
      mockGetPackageVersion.mockReturnValue("1.1.0");

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(true);
      expect(result.currentVersion).toBeNull();
    });
  });

  describe("syncCommand", () => {
    it("fails when manifest does not exist", async () => {
      mockGetManifest.mockResolvedValue(null);

      await syncCommand();

      expect(process.exitCode).toBe(1);
    });

    it("skips sync when versions match and content is identical", async () => {
      // AC-2: truthful no-op only when content is actually identical
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      // No drift: every template renders identical to installed content
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/skills/exec/SKILL.md",
          templatePath: "templates/skills/exec/SKILL.md",
          status: "unchanged",
          rendered: "x",
        },
      ]);

      const logSpy = vi.spyOn(console, "log");
      await syncCommand();

      expect(mockCopyTemplates).not.toHaveBeenCalled();
      expect(
        logSpy.mock.calls.some((c) =>
          String(c[0]).includes("already up to date"),
        ),
      ).toBe(true);
    });

    it("reports drift instead of false up-to-date when content differs at equal version", async () => {
      // AC-1: version marker matches but content differs
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/skills/exec/SKILL.md",
          templatePath: "templates/skills/exec/SKILL.md",
          status: "modified",
          rendered: "new",
          diff: "diff",
        },
        {
          path: ".claude/skills/new/SKILL.md",
          templatePath: "templates/skills/new/SKILL.md",
          status: "new",
          rendered: "new",
        },
      ]);

      const logSpy = vi.spyOn(console, "log");
      await syncCommand();

      // Report-only: does not mutate, does not claim up to date
      expect(mockCopyTemplates).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).not.toContain("already up to date");
      expect(output).toContain("2 file(s) differ");
      expect(output).toContain("sync --force");
      // Non-interactive / CI path must detect drift via the exit code.
      expect(process.exitCode).toBe(1);
    });

    it("signals drift via non-zero exit code even with --quiet (no silent success)", async () => {
      // AC-1 intent: the non-interactive path must not declare success on drift.
      // --quiet suppresses the message, but the exit code (the machine signal
      // automation actually checks) must still flag the drifted tree (#708).
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/skills/exec/SKILL.md",
          templatePath: "templates/skills/exec/SKILL.md",
          status: "modified",
          rendered: "new",
          diff: "diff",
        },
      ]);

      const logSpy = vi.spyOn(console, "log");
      await syncCommand({ quiet: true });

      expect(mockCopyTemplates).not.toHaveBeenCalled();
      // Quiet suppresses the human-readable message...
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).not.toContain("already up to date");
      expect(output).not.toContain("file(s) differ");
      // ...but the exit code still signals drift to automation.
      expect(process.exitCode).toBe(1);
    });

    it("treats local-override drift as no-op (not reported as drift)", async () => {
      // A customized constitution at equal version should not trigger the
      // drift message — only new/modified count as actionable drift.
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/memory/constitution.md",
          templatePath: "templates/memory/constitution.md",
          status: "local-override",
          rendered: "template",
        },
      ]);

      const logSpy = vi.spyOn(console, "log");
      await syncCommand();

      expect(mockCopyTemplates).not.toHaveBeenCalled();
      expect(
        logSpy.mock.calls.some((c) =>
          String(c[0]).includes("already up to date"),
        ),
      ).toBe(true);
    });

    it("syncs when versions differ", async () => {
      mockGetManifest.mockResolvedValue({
        version: "1.0.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockCopyTemplates.mockResolvedValue({ scriptsSymlinked: false });

      await syncCommand({ quiet: true });

      expect(mockCopyTemplates).toHaveBeenCalledWith(
        "nextjs",
        {},
        { force: true },
      );
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it("syncs when force is set even if versions match", async () => {
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetConfig.mockResolvedValue(null);
      mockCopyTemplates.mockResolvedValue({ scriptsSymlinked: false });

      await syncCommand({ force: true, quiet: true });

      expect(mockCopyTemplates).toHaveBeenCalled();
    });
  });
});
