import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs functions
vi.mock("../lib/fs.js", () => ({
  fileExists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  getFileStats: vi.fn(),
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
  listTemplateFiles: vi.fn(),
  getTemplatesDir: vi.fn(() => "/pkg/templates"),
}));

// Mock config
vi.mock("../lib/config.js", () => ({
  getConfig: vi.fn(),
}));

import {
  getSkillsVersion,
  areSkillsOutdated,
  checkAndWarnSkillsOutdated,
  syncCommand,
} from "./sync.js";
import { fileExists, readFile, writeFile, getFileStats } from "../lib/fs.js";
import { getManifest, getPackageVersion } from "../lib/manifest.js";
import {
  copyTemplates,
  computeTemplateChanges,
  listTemplateFiles,
} from "../lib/templates.js";
import { getConfig } from "../lib/config.js";

const mockFileExists = vi.mocked(fileExists);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockGetFileStats = vi.mocked(getFileStats);
const mockGetManifest = vi.mocked(getManifest);
const mockGetPackageVersion = vi.mocked(getPackageVersion);
const mockCopyTemplates = vi.mocked(copyTemplates);
const mockComputeTemplateChanges = vi.mocked(computeTemplateChanges);
const mockListTemplateFiles = vi.mocked(listTemplateFiles);
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

    it("reports contentDrift on a version match with new/modified files (AC-1)", async () => {
      // Version marker matches but bundled content has drifted in place — the
      // #708 blind spot. The pre-flight must now see it.
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
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

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(false);
      expect(result.contentDrift).toBe(2);
    });

    it("excludes local-override/unchanged from contentDrift (AC-1, #711)", async () => {
      // A customized constitution (local-override) or identical file (unchanged)
      // must NOT register as drift — otherwise every command would warn.
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/memory/constitution.md",
          templatePath: "templates/memory/constitution.md",
          status: "local-override",
          rendered: "template",
        },
        {
          path: ".claude/skills/exec/SKILL.md",
          templatePath: "templates/skills/exec/SKILL.md",
          status: "unchanged",
          rendered: "same",
        },
      ]);

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(false);
      expect(result.contentDrift).toBe(0);
    });

    it("skips the content diff on a version mismatch (AC-5 fast-path)", async () => {
      // A version mismatch already means stale; the copy path handles it, so the
      // per-command pre-flight must NOT pay for a template scan.
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.0.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(true);
      expect(result.contentDrift).toBe(0);
      expect(mockComputeTemplateChanges).not.toHaveBeenCalled();
    });

    it("treats a content-diff failure as no drift (pre-flight never throws)", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("1.1.0");
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockGetConfig.mockResolvedValue(null);
      mockComputeTemplateChanges.mockRejectedValue(new Error("read error"));

      const result = await areSkillsOutdated();

      expect(result.outdated).toBe(false);
      expect(result.contentDrift).toBe(0);
    });
  });

  describe("areSkillsOutdated content-drift cache (AC-5)", () => {
    const VERSION_PATH = ".claude/skills/.sequant-version";
    const CACHE_PATH = ".claude/.sequant/.skills-drift-cache.json";

    const fakeStat = (mtimeMs: number) =>
      ({ mtimeMs }) as unknown as Awaited<ReturnType<typeof getFileStats>>;

    // Wire fs mocks so the drift cache round-trips through an in-memory store,
    // letting one run's write be the next run's read. `null` = cache absent.
    function setup(mtimeMs: number) {
      const store: { value: string | null } = { value: null };
      mockGetPackageVersion.mockReturnValue("1.1.0");
      mockGetManifest.mockResolvedValue({
        version: "1.1.0",
        stack: "nextjs",
        installedAt: "2024-01-01",
        files: {},
      });
      mockGetConfig.mockResolvedValue(null);
      mockListTemplateFiles.mockResolvedValue([]);
      mockGetFileStats.mockResolvedValue(fakeStat(mtimeMs));
      mockComputeTemplateChanges.mockResolvedValue([
        {
          path: ".claude/skills/a/SKILL.md",
          templatePath: "templates/skills/a/SKILL.md",
          status: "modified",
          rendered: "x",
          diff: "d",
        },
      ]);
      mockFileExists.mockImplementation(async (p: string) => {
        if (p === VERSION_PATH) return true;
        if (p === CACHE_PATH) return store.value !== null;
        return false;
      });
      mockReadFile.mockImplementation(async (p: string) => {
        if (p === VERSION_PATH) return "1.1.0";
        if (p === CACHE_PATH) return store.value ?? "";
        return "";
      });
      mockWriteFile.mockImplementation(async (p: string, content: string) => {
        if (p === CACHE_PATH) store.value = content;
      });
      return store;
    }

    it("default (no cache) never reads or writes the cache and always scans", async () => {
      setup(1000);

      const result = await areSkillsOutdated();

      expect(result.contentDrift).toBe(1);
      expect(mockComputeTemplateChanges).toHaveBeenCalledTimes(1);
      // No fingerprint stats, no cache file write on the uncached default path.
      expect(mockGetFileStats).not.toHaveBeenCalled();
      expect(mockListTemplateFiles).not.toHaveBeenCalled();
      const cacheWrites = mockWriteFile.mock.calls.filter(
        (c) => c[0] === CACHE_PATH,
      );
      expect(cacheWrites).toHaveLength(0);
    });

    it("scans once, then serves the cached result while nothing changes", async () => {
      const store = setup(1000);

      const first = await areSkillsOutdated({ cache: true });
      expect(first.contentDrift).toBe(1);
      expect(mockComputeTemplateChanges).toHaveBeenCalledTimes(1);
      expect(store.value).not.toBeNull(); // cache was populated

      mockComputeTemplateChanges.mockClear();
      const second = await areSkillsOutdated({ cache: true });

      expect(second.contentDrift).toBe(1);
      // Same fingerprint → full scan skipped entirely.
      expect(mockComputeTemplateChanges).not.toHaveBeenCalled();
    });

    it("rescans (no stale warning) when a tracked file's mtime changes", async () => {
      setup(1000);
      await areSkillsOutdated({ cache: true });
      expect(mockComputeTemplateChanges).toHaveBeenCalledTimes(1);

      // A file was edited in place → its mtime moves → fingerprint differs.
      mockGetFileStats.mockResolvedValue(fakeStat(2000));
      mockComputeTemplateChanges.mockClear();

      const result = await areSkillsOutdated({ cache: true });

      expect(result.contentDrift).toBe(1);
      expect(mockComputeTemplateChanges).toHaveBeenCalledTimes(1);
    });

    it("falls back to a fresh scan when the fingerprint can't be computed", async () => {
      const store = setup(1000);
      mockListTemplateFiles.mockRejectedValue(new Error("walk failed"));

      const result = await areSkillsOutdated({ cache: true });

      expect(result.contentDrift).toBe(1);
      expect(mockComputeTemplateChanges).toHaveBeenCalledTimes(1);
      // Fingerprint null → nothing cached.
      expect(store.value).toBeNull();
    });
  });

  describe("checkAndWarnSkillsOutdated", () => {
    it("warns and returns true on a version mismatch", async () => {
      const logSpy = vi.spyOn(console, "log");

      const warned = await checkAndWarnSkillsOutdated({
        outdated: true,
        currentVersion: "1.0.0",
        packageVersion: "1.1.0",
        contentDrift: 0,
      });

      expect(warned).toBe(true);
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("Skills are outdated");
    });

    it("warns (warn-only) on content drift at a matching version (AC-2)", async () => {
      const logSpy = vi.spyOn(console, "log");

      const warned = await checkAndWarnSkillsOutdated({
        outdated: false,
        currentVersion: "1.1.0",
        packageVersion: "1.1.0",
        contentDrift: 3,
      });

      expect(warned).toBe(true);
      const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(output).toContain("3 file(s) differ");
      // Remediation points at the commands that actually fix in-place drift —
      // a bare `sync` at a matching version is report-only (#708).
      expect(output).toContain("sync --force");
      // Pre-flight must not fail the command it precedes.
      expect(process.exitCode).toBe(0);
    });

    it("returns false and stays silent when up to date", async () => {
      const logSpy = vi.spyOn(console, "log");

      const warned = await checkAndWarnSkillsOutdated({
        outdated: false,
        currentVersion: "1.1.0",
        packageVersion: "1.1.0",
        contentDrift: 0,
      });

      expect(warned).toBe(false);
      expect(logSpy).not.toHaveBeenCalled();
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
